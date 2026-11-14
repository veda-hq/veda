import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { DRY_RUN_TIMEOUT, FALLBACK_TRIGGERS, judgeLane, MARKERS, planLane, wrapperConfig, type Lane, type LaneDeps, type Plan } from './lanes.ts';

const web: Lane = {
  name: 'apps/web',
  cwd: 'apps/web',
  config: 'stryker.config.mjs',
  selects: (path) => path.startsWith('apps/web/src/'),
  reuse: true,
  env: () => ({ X: '1' }),
};

test('planLane: owned files are targets, the rest are named and skipped', () => {
  const owned = new Set(['apps/web/src/a.test.ts', 'apps/web/src/b.test.tsx', 'apps/web/src/c.test.ts', 'apps/web/src/a2.test.ts']);
  const plan = planLane(
    web,
    ['apps/web/src/a.ts', 'apps/web/src/b.tsx', 'apps/web/src/c.ts', 'apps/web/src/d.ts', 'scripts/x.ts', 'apps/web/src/a2.ts'],
    (path) => owned.has(path),
    (file) => file.endsWith('c.ts'),
  );
  assert.deepEqual(plan.targets, ['apps/web/src/a.ts', 'apps/web/src/b.tsx', 'apps/web/src/a2.ts']);
  assert.deepEqual(plan.suites, ['apps/web/src/a.test.ts', 'apps/web/src/b.test.tsx', 'apps/web/src/a2.test.ts']);
  assert.deepEqual(plan.notJudged, ['not judged (comment-only change): apps/web/src/c.ts', 'not judged (no colocated suite): apps/web/src/d.ts']);
});

test('planLane lists each owning suite once', () => {
  const plan = planLane(web, ['apps/web/src/a.ts', 'apps/web/src/a.tsx'], (path) => path === 'apps/web/src/a.test.ts', () => false);
  assert.deepEqual(plan.suites, ['apps/web/src/a.test.ts']);
});

test('the wrapper config is the lane config with the JSON report moved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  try {
    writeFileSync(join(dir, 'base.mjs'), "export default { testRunner: 'vitest', jsonReporter: { spacer: 2, fileName: 'old.json' } };");
    writeFileSync(join(dir, 'wrap.mjs'), wrapperConfig(join(dir, 'base.mjs'), '/r/out.json'));
    const loaded = (await import(pathToFileURL(join(dir, 'wrap.mjs')).href)) as { default: unknown };
    assert.deepEqual(loaded.default, { testRunner: 'vitest', jsonReporter: { spacer: 2, fileName: '/r/out.json' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const strykerMutant = (status: string, line = 3, column = 5) => ({
  mutatorName: 'StringLiteral',
  replacement: '""',
  status,
  location: { start: { line, column }, end: { line, column: column + 4 } },
});

interface Run {
  cwd: string;
  args: string[];
  env: Record<string, string>;
}

function fakeDeps(reports: (string | undefined)[], codes: { code: number; seen: string[]; refusal?: string }[] = [], key: string | null = 'k1') {
  const files = new Map<string, string>();
  const runs: Run[] = [];
  const deps: LaneDeps = {
    root: '/repo',
    reportsDir: '/repo/reports/agnipariksha',
    runStryker: async (cwd, args, env) => {
      runs.push({ cwd, args, env });
      const report = reports.shift();
      if (report !== undefined) files.set(`/repo/reports/agnipariksha/${plan.lane.name.replace(/[^A-Za-z0-9]+/g, '-')}.json`, report);
      return codes.shift() ?? { code: 0, seen: [] };
    },
    readFile: (path) => files.get(path),
    writeFile: (path, text) => {
      files.set(path, text);
    },
    removeFile: (path) => {
      files.delete(path);
    },
    reuseKey: () => key,
    now: () => 0,
  };
  let plan: Plan = { lane: web, targets: [], suites: [], notJudged: [] };
  const setPlan = (next: Plan) => {
    plan = next;
  };
  return { deps, files, runs, setPlan };
}

const webPlan: Plan = { lane: web, targets: ['apps/web/src/a.ts'], suites: ['apps/web/src/a.test.ts'], notJudged: [] };
const report = (files: Record<string, unknown[]>) =>
  JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([path, mutants]) => [path, { mutants }])) });

test('a workspace lane rewrites its reuse file, runs --incremental from its own directory, and judges only its targets', async () => {
  const { deps, files, runs, setPlan } = fakeDeps([report({ 'src/a.ts': [strykerMutant('Killed'), strykerMutant('Survived', 7)], 'src/old.ts': [strykerMutant('Survived')] })]);
  setPlan(webPlan);
  const reuse = '/repo/reports/agnipariksha/apps-web.incremental-k1.json';
  files.set(reuse, JSON.stringify({ files: { 'src/a.ts': { mutants: [{ status: 'Killed' }, { status: 'Timeout' }] } } }));
  const result = await judgeLane(webPlan, deps);
  assert.deepEqual(JSON.parse(files.get(reuse) ?? ''), { files: { 'src/a.ts': { mutants: [{ status: 'Killed' }] } } });
  assert.deepEqual(runs, [
    {
      cwd: '/repo/apps/web',
      args: ['run', '/repo/reports/agnipariksha/apps-web.stryker.config.mjs', '--incremental', '--incrementalFile', reuse, '--mutate', 'src/a.ts'],
      env: { X: '1' },
    },
  ]);
  assert.match(files.get('/repo/reports/agnipariksha/apps-web.stryker.config.mjs') ?? '', /apps\/web\/stryker\.config\.mjs/);
  assert.deepEqual(result.judgement.blocking.map((m) => `${m.file}:${m.line}`), ['apps/web/src/a.ts:7']);
  assert.equal(result.judgement.counted, 2);
  assert.deepEqual(result.refusals, []);
  assert.deepEqual(result.noMutants, []);
});

test('an unreadable reuse file is removed; no key or no reuse means no --incremental', async () => {
  const reuse = '/repo/reports/agnipariksha/apps-web.incremental-k1.json';
  const broken = fakeDeps([report({ 'src/a.ts': [] })]);
  broken.setPlan(webPlan);
  broken.files.set(reuse, '{');
  await judgeLane(webPlan, broken.deps);
  assert.equal(broken.files.has(reuse), false);
  assert.ok(broken.runs[0]?.args.includes('--incremental'));

  const none = fakeDeps([report({ 'src/a.ts': [] })], [], null);
  none.setPlan(webPlan);
  const empty = await judgeLane(webPlan, none.deps);
  assert.equal(none.runs[0]?.args.includes('--incremental'), false);
  assert.deepEqual(empty.noMutants, ['apps/web/src/a.ts']);

  const tooling: Plan = { lane: { ...web, name: 'tooling vitest', cwd: '', reuse: false }, targets: ['scripts/a.ts'], suites: [], notJudged: [] };
  const root = fakeDeps([report({ 'scripts/a.ts': [strykerMutant('Killed')] })]);
  root.setPlan(tooling);
  const result = await judgeLane(tooling, root.deps);
  assert.equal(root.runs[0]?.cwd, '/repo');
  assert.deepEqual(root.runs[0]?.args.slice(-2), ['--mutate', 'scripts/a.ts']);
  assert.equal(result.judgement.caught, 1);
});

test('a timed-out mutant is retried alone, with one worker and a 3-minute limit', async () => {
  const { deps, runs, setPlan } = fakeDeps(
    [report({ 'src/a.ts': [strykerMutant('Timeout')] }), report({ 'src/a.ts': [strykerMutant('Killed')] })],
    [],
    null,
  );
  setPlan(webPlan);
  const result = await judgeLane(webPlan, deps);
  assert.deepEqual(runs[1]?.args, ['run', '/repo/reports/agnipariksha/apps-web.stryker.config.mjs', '--concurrency', '1', '--timeoutMS', '180000', '--mutate', 'src/a.ts:3:4-3:8']);
  assert.equal(result.retried, 1);
  assert.deepEqual(result.judgement.byStatus, { Killed: 1 });
});

test('a timed-out mutant with no location refuses', async () => {
  const noEnd = { ...strykerMutant('Timeout'), location: { start: { line: 3, column: 5 } } };
  const { deps, runs, setPlan } = fakeDeps([report({ 'src/a.ts': [noEnd] })], [], null);
  setPlan(webPlan);
  const result = await judgeLane(webPlan, deps);
  assert.equal(runs.length, 1);
  assert.match(result.refusals[0] ?? '', /no full location/);
});

test('Stryker failing, a busy dry run, a missing, non-JSON or malformed report, and an unknown status all refuse', async () => {
  const cases: [string | undefined, { code: number; seen: string[]; refusal?: string } | undefined, RegExp][] = [
    [undefined, { code: 1, seen: [] }, /^Stryker exited 1$/],
    // A run that cannot be trusted refuses even with a clean exit and a full report.
    [report({ 'src/a.ts': [strykerMutant('Killed')] }), { code: 0, seen: [], refusal: 'its temp directory vanished' }, /^its temp directory vanished$/],
    [undefined, { code: 1, seen: [DRY_RUN_TIMEOUT, 'No tests were executed'] }, /initial test run timed out/],
    // A trigger names itself, but a lane without a fallback just refuses.
    [undefined, { code: 1, seen: ['No tests were executed'] }, /^Stryker exited 1 \(No tests were executed\)$/],
    [undefined, undefined, /wrote no report/],
    ['{', undefined, /is not JSON/],
    ['[]', undefined, /no `files`/],
    [report({ 'src/a.ts': [strykerMutant('Pending')] }), undefined, /unknown status: Pending apps\/web\/src\/a\.ts:3/],
  ];
  for (const [text, code, expected] of cases) {
    const { deps, setPlan } = fakeDeps([text], code === undefined ? [] : [code], null);
    setPlan(webPlan);
    const result = await judgeLane(webPlan, deps);
    assert.match(result.refusals[0] ?? '', expected);
    assert.equal(result.fellBack, null);
  }
});

const toolingPlan: Plan = {
  lane: {
    ...web,
    name: 'tooling vitest',
    cwd: '',
    reuse: false,
    env: () => ({ RELATED: '1' }),
    fallback: (suites) => ({ RELATED: '0', SUITES: suites.join(',') }),
  },
  targets: ['scripts/a.ts'],
  suites: ['scripts/a.test.ts'],
  notJudged: [],
};

test('the trigger strings', () => {
  assert.equal(DRY_RUN_TIMEOUT, 'Initial test run timed out!');
  assert.deepEqual(FALLBACK_TRIGGERS, [
    'Vitest failed to find test files related to mutated files',
    'No tests were executed',
    'There were failed tests in the initial test run',
  ]);
  assert.deepEqual(MARKERS, [DRY_RUN_TIMEOUT, ...FALLBACK_TRIGGERS]);
});

test('a dry run failing on a trigger reruns once in the fallback mode, and only that run counts', async () => {
  for (const trigger of FALLBACK_TRIGGERS) {
    const timeout = strykerMutant('Timeout');
    const { deps, runs, setPlan } = fakeDeps(
      [undefined, report({ 'scripts/a.ts': [strykerMutant('Killed', 1), timeout] }), report({ 'scripts/a.ts': [strykerMutant('Killed')] })],
      [{ code: 1, seen: [trigger] }],
    );
    setPlan(toolingPlan);
    const result = await judgeLane(toolingPlan, deps);
    assert.equal(result.fellBack, `its dry run failed: "${trigger}"`);
    assert.deepEqual(runs.map((r) => r.env), [{ RELATED: '1' }, { RELATED: '0', SUITES: 'scripts/a.test.ts' }, { RELATED: '0', SUITES: 'scripts/a.test.ts' }], 'the retry keeps the fallback mode');
    assert.deepEqual(result.judgement.byStatus, { Killed: 2 });
    assert.deepEqual(result.refusals, []);
  }
});

test('a fallback that fails too refuses; a busy dry run never falls back', async () => {
  const both = fakeDeps([], [{ code: 1, seen: ['There were failed tests in the initial test run'] }, { code: 2, seen: [] }]);
  both.setPlan(toolingPlan);
  const result = await judgeLane(toolingPlan, both.deps);
  assert.equal(result.fellBack, 'its dry run failed: "There were failed tests in the initial test run"');
  assert.deepEqual(result.refusals, ['Stryker exited 2']);

  const busy = fakeDeps([], [{ code: 1, seen: [DRY_RUN_TIMEOUT] }]);
  busy.setPlan(toolingPlan);
  const busyResult = await judgeLane(toolingPlan, busy.deps);
  assert.equal(busy.runs.length, 1);
  assert.equal(busyResult.fellBack, null);
  assert.match(busyResult.refusals[0] ?? '', /machine is busy/);
});

const twoFiles: Plan = { ...toolingPlan, targets: ['scripts/a.ts', 'scripts/b.ts'], suites: ['scripts/a.test.ts', 'scripts/b.test.ts'] };
const own = { RELATED: '0', SUITES: 'scripts/a.test.ts,scripts/b.test.ts' };

test('a file no related suite reached is rerun alone in own-suite mode; its timeouts retry in that mode, the others in related mode', async () => {
  const { deps, runs, setPlan } = fakeDeps([
    report({
      'scripts/a.ts': [strykerMutant('Killed', 1), strykerMutant('Timeout', 3)],
      'scripts/b.ts': [strykerMutant('NoCoverage', 1), strykerMutant('NoCoverage', 2), strykerMutant('Ignored', 5)],
    }),
    report({ 'scripts/b.ts': [strykerMutant('Killed', 1), strykerMutant('Survived', 2), strykerMutant('Timeout', 4)] }),
    report({ 'scripts/a.ts': [strykerMutant('Killed', 3)] }),
    report({ 'scripts/b.ts': [strykerMutant('Killed', 4)] }),
  ]);
  setPlan(twoFiles);
  const result = await judgeLane(twoFiles, deps);
  assert.equal(result.fellBack, 'every mutant of scripts/b.ts was NoCoverage under the related filter');
  assert.deepEqual(
    runs.map((r) => [r.args.at(-1), r.env]),
    [
      ['scripts/a.ts,scripts/b.ts', { RELATED: '1' }],
      ['scripts/b.ts', own],
      ['scripts/a.ts:3:4-3:8', { RELATED: '1' }],
      ['scripts/b.ts:4:4-4:8', own],
    ],
  );
  assert.deepEqual(result.judgement.byStatus, { Killed: 4, Survived: 1 });
  assert.deepEqual(result.judgement.blocking.map((m) => `${m.file}:${m.line}`), ['scripts/b.ts:2']);
  assert.deepEqual(result.refusals, []);
});

test('the own-suite rerun failing refuses the lane', async () => {
  const { deps, setPlan } = fakeDeps([report({ 'scripts/a.ts': [strykerMutant('Killed')], 'scripts/b.ts': [strykerMutant('NoCoverage')] })], [{ code: 0, seen: [] }, { code: 1, seen: [] }]);
  setPlan(twoFiles);
  const result = await judgeLane(twoFiles, deps);
  assert.equal(result.fellBack, 'every mutant of scripts/b.ts was NoCoverage under the related filter');
  assert.deepEqual(result.refusals, ['Stryker exited 1']);
});

test('no rerun for a partly covered file, an all-Ignored file, or a lane without a fallback', async () => {
  const partly = fakeDeps([report({ 'scripts/a.ts': [strykerMutant('NoCoverage', 1), strykerMutant('Killed', 2)], 'scripts/b.ts': [strykerMutant('Ignored')] })]);
  partly.setPlan(twoFiles);
  const result = await judgeLane(twoFiles, partly.deps);
  assert.equal(partly.runs.length, 1);
  assert.equal(result.fellBack, null);
  assert.deepEqual(result.judgement.blocking.map((m) => m.status), ['NoCoverage']);

  const workspace = fakeDeps([report({ 'src/a.ts': [strykerMutant('NoCoverage')] })], [], null);
  workspace.setPlan(webPlan);
  const blocked = await judgeLane(webPlan, workspace.deps);
  assert.equal(workspace.runs.length, 1);
  assert.equal(blocked.judgement.blocking.length, 1);
});
