import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  countLines,
  DRY_RUN_TIMEOUT,
  FAILED_INITIAL_RUN,
  FALLBACK_TRIGGERS,
  flakyRetry,
  judgeLane,
  MARKERS,
  overCutoff,
  planLane,
  RETRY_PLUGIN,
  RETRY_REPORTER,
  retryConfig,
  wrapperConfig,
  type Lane,
  type LaneDeps,
  type Plan,
} from './lanes.ts';

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

test('countLines counts as wc -l does, plus a last line with no newline', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\n\n'), 2, 'a blank line counts');
  assert.equal(countLines('\n'), 1);
  assert.equal(countLines('// x\n\n  y();\n'), 3, 'comments and blank lines count');
});

test('overCutoff: over means more lines than maxLines, across every target, and an unreadable target counts 0', () => {
  const texts = new Map([['apps/web/src/a.ts', 'x\ny\nz\n'], ['apps/web/src/b.ts', 'p\nq']]);
  const read = (file: string) => texts.get(file);
  const plan = (maxLines: number | undefined, targets = ['apps/web/src/a.ts', 'apps/web/src/b.ts']): Plan => ({
    lane: maxLines === undefined ? web : { ...web, maxLines },
    targets,
    suites: [],
    notJudged: [],
  });
  assert.equal(overCutoff(plan(undefined), read), null, 'no cut-off');
  assert.equal(overCutoff(plan(5), read), null, 'at the cut-off is judged');
  assert.equal(
    overCutoff(plan(4), read),
    'apps/web: 5 lines in 2 file(s), over its cut-off of 4 - not judged in this run, CI judges it (--lane "apps/web" judges it here)',
  );
  assert.equal(overCutoff(plan(2, ['apps/web/src/a.ts', 'apps/web/src/gone.ts']), read), 'apps/web: 3 lines in 2 file(s), over its cut-off of 2 - not judged in this run, CI judges it (--lane "apps/web" judges it here)');
  assert.equal(overCutoff(plan(1, ['apps/web/src/gone.ts']), read), null, 'a failed read never causes a skip');
});

test('planLane judges an .mjs source whose only suite is its .test.mjs', () => {
  const scripts: Lane = { ...web, name: 'scripts', cwd: '.', selects: (path) => path.startsWith('scripts/') };
  const owned = new Set(['scripts/version-rule.test.mjs', 'scripts/pins.test.ts', 'scripts/pins.test.mjs']);
  const plan = planLane(scripts, ['scripts/version-rule.mjs', 'scripts/pins.mjs', 'scripts/lone.mjs'], (path) => owned.has(path), () => false);
  assert.deepEqual(plan.targets, ['scripts/version-rule.mjs', 'scripts/pins.mjs']);
  assert.deepEqual(plan.suites, ['scripts/version-rule.test.mjs', 'scripts/pins.test.ts']);
  assert.deepEqual(plan.notJudged, ['not judged (no colocated suite): scripts/lone.mjs']);
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
  stopAfterMs?: number;
}

type Code = { code: number; seen: string[]; refusal?: string; failedTests?: string[]; stopped?: boolean };

/**
 * Deps whose Stryker writes each run's report in turn: a retry round's to
 * its own report, the rest to the lane's. A round also writes the next of
 * `events`, the lines its reporter would have appended.
 */
function fakeDeps(reports: (string | undefined)[], codes: Code[] = [], key: string | null = 'k1', events: (string | undefined)[] = []) {
  const files = new Map<string, string>();
  const runs: Run[] = [];
  const logs: string[] = [];
  const deps: LaneDeps = {
    root: '/repo',
    reportsDir: '/repo/reports/agnipariksha',
    runStryker: async (cwd, args, env, stopAfterMs) => {
      runs.push({ cwd, args, env, ...(stopAfterMs === undefined ? {} : { stopAfterMs }) });
      const slug = `/repo/reports/agnipariksha/${plan.lane.name.replace(/[^A-Za-z0-9]+/g, '-')}`;
      const round = args[1] === `${slug}.retry.stryker.config.mjs`;
      const report = reports.shift();
      if (report !== undefined) files.set(`${slug}${round ? '.retry' : ''}.json`, report);
      const lines = round ? events.shift() : undefined;
      if (lines !== undefined) files.set(`${slug}.retry-events.jsonl`, lines);
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
    log: (line) => {
      logs.push(line);
    },
  };
  let plan: Plan = { lane: web, targets: [], suites: [], notJudged: [] };
  const setPlan = (next: Plan) => {
    plan = next;
  };
  return { deps, files, runs, logs, setPlan };
}

const webPlan: Plan = { lane: web, targets: ['apps/web/src/a.ts'], suites: ['apps/web/src/a.test.ts'], notJudged: [] };
const report = (files: Record<string, unknown[]>) =>
  JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([path, mutants]) => [path, { mutants }])) });
const twoTimeouts = () => report({ 'src/a.ts': [strykerMutant('Timeout'), strykerMutant('Timeout', 7)] });
/** The two timeouts as a round's refusal names them. */
const both = 'apps/web/src/a.ts:3:5 StringLiteral ("\\"\\""), apps/web/src/a.ts:7:5 StringLiteral ("\\"\\"")';
/** A Timeout on lines 2 to 9 that holds the one on line 3, so it retries a round later. */
const wide = { ...strykerMutant('Timeout', 2, 1), location: { start: { line: 2, column: 1 }, end: { line: 9, column: 1 } } };

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

const EVENTS = '/repo/reports/agnipariksha/apps-web.retry-events.jsonl';
const RETRY_REPORT = '/repo/reports/agnipariksha/apps-web.retry.json';
const RETRY_WRAPPER = '/repo/reports/agnipariksha/apps-web.retry.stryker.config.mjs';
const PLUGINS = { ignorer: RETRY_PLUGIN, reporter: RETRY_REPORTER };
/** The event line the retry reporter writes for a report mutant of `file`. */
const event = (file: string, m: ReturnType<typeof strykerMutant>, at: number) =>
  JSON.stringify({ kind: 'mutant', at, file, status: m.status, mutator: m.mutatorName, replacement: m.replacement, line: m.location.start.line, column: m.location.start.column, endLine: m.location.end.line, endColumn: m.location.end.column });

test("one round retries a lane's timeouts: one worker, a 3-minute limit, every span for the ignorer, its own report and events, the wall, and the round files' unused mutators left out", async () => {
  const other = (mutatorName: string, line: number, status = 'Killed') => ({ ...strykerMutant(status, line), mutatorName });
  const lane = report({
    'src/a.ts': [strykerMutant('Timeout'), strykerMutant('Killed', 4), other('ConditionalExpression', 5), other('ConditionalExpression', 6), other('BlockStatement', 7)],
    'src/b.ts': [other('ArrayDeclaration', 1, 'Timeout')],
    'src/c.ts': [other('Regex', 1)],
  });
  const { deps, files, runs, logs, setPlan } = fakeDeps(
    [lane, report({ 'src/a.ts': [strykerMutant('Killed')], 'src/b.ts': [other('ArrayDeclaration', 1)] })],
    [],
    null,
    [['{"kind":"dry-run","at":0}', event('src/a.ts', strykerMutant('Killed'), 0)].join('\n')],
  );
  const plan: Plan = { ...webPlan, targets: ['apps/web/src/a.ts', 'apps/web/src/b.ts', 'apps/web/src/c.ts'] };
  setPlan(plan);
  files.set(EVENTS, 'a stale line');
  // A minute on the clock: the stop comes the budget after the pass's start, not after the clock's zero.
  deps.now = () => 60_000;
  const result = await judgeLane(plan, deps);
  assert.deepEqual(runs[1], {
    cwd: '/repo/apps/web',
    args: ['run', RETRY_WRAPPER, '--concurrency', '4', '--timeoutMS', '180000', '--mutate', 'src/a.ts:3:4-3:8,src/b.ts:1:4-1:8'],
    env: { X: '1', AGNIPARIKSHA_RETRY_SPANS: 'src/a.ts:3:4-3:8\nsrc/b.ts:1:4-1:8', AGNIPARIKSHA_RETRY_EVENTS: EVENTS },
    stopAfterMs: 900_000,
  });
  assert.equal(files.get(RETRY_WRAPPER), retryConfig('/repo/apps/web/stryker.config.mjs', RETRY_REPORT, PLUGINS, ['ConditionalExpression', 'BlockStatement']));
  assert.deepEqual(runs[0], { cwd: '/repo/apps/web', args: ['run', '/repo/reports/agnipariksha/apps-web.stryker.config.mjs', '--mutate', 'src/a.ts,src/b.ts,src/c.ts'], env: { X: '1' } }, 'the lane run carries no span and no stop');
  assert.equal(files.get('/repo/reports/agnipariksha/apps-web.json'), lane, "the round leaves the lane's report alone");
  assert.equal(result.retried, 2);
  assert.deepEqual(result.judgement.byStatus, { Killed: 7 });
  assert.deepEqual(logs, [
    '  retry round 1 of 1: 2 timed-out mutant(s) in 2 file(s)',
    '  retry 1 of 2: apps/web/src/a.ts:3:5 StringLiteral ("\\"\\""): Killed after 0.0 s',
    '  retry 2 of 2: apps/web/src/b.ts:1:5 ArrayDeclaration ("\\"\\""): Killed',
  ]);
});

test('a round stopped at the wall keeps what its events say Stryker finished, reads no report, and refuses the rest', async () => {
  const { deps, setPlan } = fakeDeps(
    [twoTimeouts(), report({ 'src/a.ts': [strykerMutant('Survived'), strykerMutant('Survived', 7)] })],
    [{ code: 0, seen: [] }, { code: 143, seen: [], stopped: true }],
    null,
    [['{"kind":"dry-run","at":0}', event('src/a.ts', strykerMutant('Killed'), 0)].join('\n')],
  );
  setPlan(webPlan);
  const result = await judgeLane(webPlan, deps);
  assert.equal(result.retried, 1);
  assert.deepEqual(result.judgement.byStatus, { Killed: 1 });
  assert.equal(result.refusals.length, 1);
  assert.match(result.refusals[0] ?? '', /^the timeout retry pass reached its 15-minute budget after 0\.0 min: .*; 1 timed-out mutant\(s\) left unretried: apps\/web\/src\/a\.ts:7:5 StringLiteral/);
});

test("a refused round passes on when its dry run ended, so the wall's refusal books the rest of its time as the rest", async () => {
  const { deps, setPlan } = fakeDeps(
    [report({ 'src/a.ts': [strykerMutant('Timeout'), wide] })],
    [{ code: 0, seen: [] }, { code: 1, seen: [] }, { code: 143, seen: [], stopped: true }],
    null,
    ['{"kind":"dry-run","at":60000}'],
  );
  setPlan(webPlan);
  let t = 0;
  deps.now = () => t;
  const run = deps.runStryker;
  // The lane's run takes no time; the first round ends at 10 minutes, the second at the wall.
  const ends = [0, 10 * 60_000, 15 * 60_000];
  deps.runStryker = async (...args) => {
    const result = await run(...args);
    t = ends.shift() ?? t;
    return result;
  };
  const result = await judgeLane(webPlan, deps);
  assert.match(result.refusals[1] ?? '', /: 6\.0 min went to starting Stryker and its initial test run \(2 run\(s\)\), 0\.0 min to 0 mutant\(s\) that timed out again, and 9\.0 min to the rest;/);
});

test("a stale lane report is removed before the lane's run: a run that writes none is never read as one", async () => {
  const { deps, files, setPlan } = fakeDeps([undefined], [], null);
  setPlan(webPlan);
  files.set('/repo/reports/agnipariksha/apps-web.json', report({ 'src/a.ts': [strykerMutant('Killed')] }));
  const result = await judgeLane(webPlan, deps);
  assert.deepEqual(result.refusals, ['Stryker wrote no report at /repo/reports/agnipariksha/apps-web.json']);
});

test('a stale round report or event file is removed before the round: a round that writes none is never read as one', async () => {
  const { deps, files, setPlan } = fakeDeps([twoTimeouts()], [], null);
  setPlan(webPlan);
  files.set(RETRY_REPORT, report({ 'src/a.ts': [strykerMutant('Killed'), strykerMutant('Killed', 7)] }));
  files.set(EVENTS, event('src/a.ts', strykerMutant('Killed'), 0));
  const result = await judgeLane(webPlan, deps);
  assert.deepEqual(result.refusals, [`retry round 1 of 1 (${both}): Stryker wrote no report at ${RETRY_REPORT}`]);
  assert.equal(files.has(EVENTS), false);
});

test('the retry ignorer and reporter the retry config loads are the compiled ones beside lanes', () => {
  assert.equal(RETRY_PLUGIN, join(dirname(fileURLToPath(import.meta.url)), 'retry-ignorer.js'));
  assert.equal(RETRY_REPORTER, join(dirname(fileURLToPath(import.meta.url)), 'retry-reporter.js'));
});

test('the retry config is the lane config with the report moved, the retry ignorer and reporter added and the other mutators left out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  const plugins = { ignorer: '/p/retry-ignorer.js', reporter: '/p/retry-reporter.js' };
  try {
    writeFileSync(
      join(dir, 'base.mjs'),
      "export default { testRunner: 'tap', jsonReporter: { spacer: 2 }, reporters: ['json'], appendPlugins: ['/own.mjs'], ignorers: ['arid'], mutator: { plugins: ['x'], excludedMutations: ['Regex'] } };",
    );
    writeFileSync(join(dir, 'bare.mjs'), "export default { testRunner: 'tap' };");
    writeFileSync(join(dir, 'retry.mjs'), retryConfig(join(dir, 'base.mjs'), '/r/out.json', plugins, ['BlockStatement', 'StringLiteral']));
    writeFileSync(join(dir, 'bare-retry.mjs'), retryConfig(join(dir, 'bare.mjs'), '/r/out.json', plugins, []));
    const loaded = (await import(pathToFileURL(join(dir, 'retry.mjs')).href)) as { default: unknown };
    assert.deepEqual(loaded.default, {
      testRunner: 'tap',
      jsonReporter: { spacer: 2, fileName: '/r/out.json' },
      reporters: ['json', 'agnipariksha-retry-log'],
      appendPlugins: ['/own.mjs', '/p/retry-ignorer.js', '/p/retry-reporter.js'],
      ignorers: ['arid', 'agnipariksha-retry'],
      mutator: { plugins: ['x'], excludedMutations: ['Regex', 'BlockStatement', 'StringLiteral'] },
    });
    const bare = (await import(pathToFileURL(join(dir, 'bare-retry.mjs')).href)) as { default: unknown };
    assert.deepEqual(bare.default, {
      testRunner: 'tap',
      jsonReporter: { fileName: '/r/out.json' },
      reporters: ['agnipariksha-retry-log'],
      appendPlugins: ['/p/retry-ignorer.js', '/p/retry-reporter.js'],
      ignorers: ['agnipariksha-retry'],
      mutator: { excludedMutations: [] },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    assert.deepEqual(result.noMutants, []);
    assert.deepEqual(result.ownSuites, []);
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
    fallbackOwnSuites: true,
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
    assert.deepEqual(
      runs.map((r) => r.env),
      [
        { RELATED: '1' },
        { RELATED: '0', SUITES: 'scripts/a.test.ts' },
        { RELATED: '0', SUITES: 'scripts/a.test.ts', AGNIPARIKSHA_RETRY_SPANS: 'scripts/a.ts:3:4-3:8', AGNIPARIKSHA_RETRY_EVENTS: '/repo/reports/agnipariksha/tooling-vitest.retry-events.jsonl' },
      ],
      'the retry keeps the fallback mode',
    );
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
  assert.deepEqual(result.judgement, { blocking: [], unknown: [], byStatus: {}, counted: 0, caught: 0 }, 'a refused lane judges nothing');

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
      ['scripts/a.ts:3:4-3:8', { RELATED: '1', AGNIPARIKSHA_RETRY_SPANS: 'scripts/a.ts:3:4-3:8', AGNIPARIKSHA_RETRY_EVENTS: '/repo/reports/agnipariksha/tooling-vitest.retry-events.jsonl' }],
      ['scripts/b.ts:4:4-4:8', { ...own, AGNIPARIKSHA_RETRY_SPANS: 'scripts/b.ts:4:4-4:8', AGNIPARIKSHA_RETRY_EVENTS: '/repo/reports/agnipariksha/tooling-vitest.retry-events.jsonl' }],
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

const failedRun = (...failedTests: string[]) => ({ code: 1, seen: [FAILED_INITIAL_RUN], failedTests });

test('a lane with no fallback reruns a dry run that failed on a test once, with the same variables; a pass there says the test flaked', async () => {
  const { deps, runs, setPlan } = fakeDeps([undefined, report({ 'src/a.ts': [strykerMutant('Killed')] })], [failedRun('clock is pinned')], null);
  setPlan(webPlan);
  const result = await judgeLane(webPlan, deps);
  assert.deepEqual(runs.map((r) => [r.args.at(-1), r.env]), [
    ['src/a.ts', { X: '1' }],
    ['src/a.ts', { X: '1' }],
  ]);
  assert.equal(
    result.flaky,
    'its initial test run failed on "clock is pinned", then passed when run again: the test is flaky; fix the flake first (an injected, pinned clock is the usual cure), then run again',
  );
  assert.equal(result.fellBack, null);
  assert.deepEqual(result.judgement.byStatus, { Killed: 1 });
  assert.deepEqual(result.refusals, []);

  const unnamed = fakeDeps([undefined, report({ 'src/a.ts': [] })], [failedRun()], null);
  unnamed.setPlan(webPlan);
  assert.match((await judgeLane(webPlan, unnamed.deps)).flaky ?? '', /^its initial test run failed, then passed when run again/);
});

test('a dry run failing on a test twice refuses, naming the tests; a rerun failing otherwise refuses with its own reason', async () => {
  const twice = fakeDeps([], [failedRun('a'), failedRun('a', 'b')], null);
  twice.setPlan(webPlan);
  const result = await judgeLane(webPlan, twice.deps);
  assert.equal(twice.runs.length, 2);
  assert.deepEqual(result.refusals, [
    'the initial test run failed on both runs, the second time: Stryker exited 1 (There were failed tests in the initial test run: "a" and "b"); fix those tests, then run again',
  ]);
  assert.equal(result.flaky, undefined);

  const other = fakeDeps([], [failedRun('a'), { code: 2, seen: [] }], null);
  other.setPlan(webPlan);
  const otherResult = await judgeLane(webPlan, other.deps);
  assert.deepEqual(otherResult.refusals, ['Stryker exited 2']);
  assert.equal(otherResult.flaky, undefined);
});

test('only a failed test reruns a lane with no fallback: no related suite or no tests at all is not a flake', async () => {
  for (const trigger of FALLBACK_TRIGGERS.filter((line) => line !== FAILED_INITIAL_RUN)) {
    const { deps, runs, setPlan } = fakeDeps([], [{ code: 1, seen: [trigger] }], null);
    setPlan(webPlan);
    const result = await judgeLane(webPlan, deps);
    assert.equal(runs.length, 1);
    assert.deepEqual(result.refusals, [`Stryker exited 1 (${trigger})`]);
  }
});

test('ownSuites: every target of a narrowed lane, the targets a fallback reran, and none under a related filter or a refusal', async () => {
  const narrowedPlan: Plan = { ...webPlan, lane: { ...web, ownSuites: true } };
  const narrowed = fakeDeps([report({ 'src/a.ts': [strykerMutant('Survived')] })], [], null);
  narrowed.setPlan(narrowedPlan);
  assert.deepEqual((await judgeLane(narrowedPlan, narrowed.deps)).ownSuites, ['apps/web/src/a.ts']);

  const related = fakeDeps([report({ 'src/a.ts': [strykerMutant('Survived')] })], [], null);
  related.setPlan(webPlan);
  assert.deepEqual((await judgeLane(webPlan, related.deps)).ownSuites, []);

  const fellBack = fakeDeps([undefined, report({ 'scripts/a.ts': [strykerMutant('Survived')] })], [{ code: 1, seen: ['No tests were executed'] }]);
  fellBack.setPlan(toolingPlan);
  assert.deepEqual((await judgeLane(toolingPlan, fellBack.deps)).ownSuites, ['scripts/a.ts']);

  const unreached = fakeDeps([
    report({ 'scripts/a.ts': [strykerMutant('Survived', 1)], 'scripts/b.ts': [strykerMutant('NoCoverage', 1)] }),
    report({ 'scripts/b.ts': [strykerMutant('Survived', 1)] }),
  ]);
  unreached.setPlan(twoFiles);
  assert.deepEqual((await judgeLane(twoFiles, unreached.deps)).ownSuites, ['scripts/b.ts'], 'only the file rerun in own-suite mode');

  const refusedRun = fakeDeps([], [{ code: 2, seen: [] }], null);
  refusedRun.setPlan(narrowedPlan);
  assert.deepEqual((await judgeLane(narrowedPlan, refusedRun.deps)).ownSuites, []);

  // A narrowed lane whose fallback is not narrowed: the fallback's results count, so nothing is narrowed.
  const wideFallback: Plan = { ...toolingPlan, lane: { ...toolingPlan.lane, ownSuites: true, fallbackOwnSuites: false } };
  const wide = fakeDeps([undefined, report({ 'scripts/a.ts': [strykerMutant('Survived')] })], [{ code: 1, seen: ['No tests were executed'] }]);
  wide.setPlan(wideFallback);
  assert.deepEqual((await judgeLane(wideFallback, wide.deps)).ownSuites, []);
});

test('a fallback names the tests that failed its first dry run', async () => {
  const { deps, setPlan } = fakeDeps([undefined, report({ 'scripts/a.ts': [strykerMutant('Killed')] })], [failedRun('x')]);
  setPlan(toolingPlan);
  const result = await judgeLane(toolingPlan, deps);
  assert.equal(result.fellBack, 'its dry run failed: "There were failed tests in the initial test run" on "x"');
  assert.equal(result.flaky, undefined);
});

test("a timeout retry whose dry run fails on a test says the run was flaky, names the test and says what to do", async () => {
  const { deps, setPlan } = fakeDeps([report({ 'src/a.ts': [strykerMutant('Timeout')] })], [{ code: 0, seen: [] }, failedRun('clock is pinned')], null);
  setPlan(webPlan);
  const result = await judgeLane(webPlan, deps);
  const one = 'retry round 1 of 1 (apps/web/src/a.ts:3:5 StringLiteral ("\\"\\""))';
  assert.deepEqual(result.refusals, [
    `${one}: the initial test run was flaky: it passed in the lane's run and failed in this retry on "clock is pinned"; fix the flake first (an injected, pinned clock is the usual cure), then run again, and apply each hung mutant by hand to see that it dies fast`,
  ]);
  assert.match(flakyRetry([]), /failed in this retry; fix the flake first/, 'no names, no "on"');

  const otherRetry = fakeDeps([report({ 'src/a.ts': [strykerMutant('Timeout')] })], [{ code: 0, seen: [] }, { code: 1, seen: ['No tests were executed'] }], null);
  otherRetry.setPlan(webPlan);
  assert.deepEqual((await judgeLane(webPlan, otherRetry.deps)).refusals, [`${one}: Stryker exited 1 (No tests were executed)`]);
});

test('the configs are written one statement a line', () => {
  assert.equal(
    wrapperConfig('/l/stryker.config.mjs', '/r/out.json'),
    'import base from "file:///l/stryker.config.mjs";\nexport default { ...base, jsonReporter: { ...base.jsonReporter, fileName: "/r/out.json" } };\n',
  );
  assert.equal(
    retryConfig('/l/stryker.config.mjs', '/r/out.json', { ignorer: '/p/retry-ignorer.js', reporter: '/p/retry-reporter.js' }, ['BlockStatement']),
    [
      'import base from "file:///l/stryker.config.mjs";',
      'export default {',
      '  ...base,',
      '  jsonReporter: { ...base.jsonReporter, fileName: "/r/out.json" },',
      '  appendPlugins: [...(base.appendPlugins ?? []), "/p/retry-ignorer.js", "/p/retry-reporter.js"],',
      '  reporters: [...(base.reporters ?? []), "agnipariksha-retry-log"],',
      '  ignorers: [...(base.ignorers ?? []), "agnipariksha-retry"],',
      '  mutator: { ...base.mutator, excludedMutations: [...(base.mutator?.excludedMutations ?? []), ...["BlockStatement"]] },',
      '};',
      '',
    ].join('\n'),
  );
});

test("a lane's file names collapse each run of other characters in its name to one hyphen", async () => {
  const spaced: Plan = { ...webPlan, lane: { ...web, name: 'apps / web' } };
  const { deps, runs, setPlan } = fakeDeps([report({ 'src/a.ts': [] })], [], null);
  setPlan(spaced);
  await judgeLane(spaced, deps);
  assert.equal(runs[0]?.args[1], '/repo/reports/agnipariksha/apps-web.stryker.config.mjs');
});

test('a round that fails refuses its mutants and the next round runs; only a busy dry run stops the pass', async () => {
  const first = 'retry round 1 of 2 (apps/web/src/a.ts:3:5 StringLiteral ("\\"\\""))';
  const goesOn: [string, string | undefined, Code][] = [
    ['its temp directory vanished', report({ 'src/a.ts': [strykerMutant('Killed')] }), { code: 0, seen: [], refusal: 'its temp directory vanished' }],
    ['Stryker exited 1', undefined, { code: 1, seen: [] }],
    // Only the initial test run's failure names tests.
    ['Stryker exited 1 (No tests were executed)', undefined, { code: 1, seen: ['No tests were executed'], failedTests: ['x'] }],
    [`Stryker wrote no report at ${RETRY_REPORT}`, undefined, { code: 0, seen: [] }],
    [`Stryker's report ${RETRY_REPORT} is not JSON`, '{', { code: 0, seen: [] }],
    ['the report has no `files`', '[]', { code: 0, seen: [] }],
    [flakyRetry(['t']), undefined, { code: 1, seen: [FAILED_INITIAL_RUN], failedTests: ['t'] }],
  ];
  for (const [refusal, text, code] of goesOn) {
    const { deps, runs, setPlan } = fakeDeps([report({ 'src/a.ts': [strykerMutant('Timeout'), wide] }), text, report({ 'src/a.ts': [{ ...wide, status: 'Killed' }] })], [{ code: 0, seen: [] }, code], null);
    setPlan(webPlan);
    const result = await judgeLane(webPlan, deps);
    assert.deepEqual(result.refusals, [`${first}: ${refusal}`], refusal);
    assert.equal(runs.length, 3, refusal);
    assert.deepEqual(runs[2]?.args.at(-1), 'src/a.ts:2:0-9:0', refusal);
    assert.equal(result.retried, 1, refusal);
  }

  const busy = fakeDeps([report({ 'src/a.ts': [strykerMutant('Timeout'), wide] })], [{ code: 0, seen: [] }, { code: 1, seen: [DRY_RUN_TIMEOUT] }], null);
  busy.setPlan(webPlan);
  const stopped = await judgeLane(webPlan, busy.deps);
  assert.equal(busy.runs.length, 2);
  assert.deepEqual(stopped.refusals, [
    `${first}: Stryker's initial test run timed out: the machine is busy; push again when it is quieter`,
    'a retry found the machine busy; 1 timed-out mutant(s) left unretried: apps/web/src/a.ts:2:1 StringLiteral ("\\"\\""). For each, make the suite that owns its file kill it fast, or push again when the machine is quieter',
  ]);

  const noEnd = { ...strykerMutant('Timeout'), location: { start: { line: 3, column: 5 } } };
  const located = fakeDeps([report({ 'src/a.ts': [noEnd, strykerMutant('Timeout', 7)] }), report({ 'src/a.ts': [strykerMutant('Killed', 7)] })], [], null);
  located.setPlan(webPlan);
  const unlocated = await judgeLane(webPlan, located.deps);
  assert.equal(located.runs.length, 2);
  assert.equal(unlocated.retried, 1);
  assert.deepEqual(unlocated.refusals, ['retry of apps/web/src/a.ts:3 (StringLiteral): its report gives no full location to retry it by']);
});

test('a lane that fell back already never reruns a NoCoverage file', async () => {
  const { deps, runs, setPlan } = fakeDeps(
    [undefined, report({ 'scripts/a.ts': [strykerMutant('Killed')], 'scripts/b.ts': [strykerMutant('NoCoverage')] })],
    [{ code: 1, seen: ['No tests were executed'] }],
  );
  setPlan(twoFiles);
  const result = await judgeLane(twoFiles, deps);
  assert.equal(runs.length, 2);
  assert.equal(result.fellBack, 'its dry run failed: "No tests were executed"');
  assert.deepEqual(result.judgement.blocking.map((m) => `${m.file}:${m.status}`), ['scripts/b.ts:NoCoverage']);
});

test('the NoCoverage rerun names every file it reruns', async () => {
  const { deps, runs, setPlan } = fakeDeps([
    report({ 'scripts/a.ts': [strykerMutant('NoCoverage')], 'scripts/b.ts': [strykerMutant('NoCoverage')] }),
    report({ 'scripts/a.ts': [strykerMutant('Killed')], 'scripts/b.ts': [strykerMutant('Killed')] }),
  ]);
  setPlan(twoFiles);
  const result = await judgeLane(twoFiles, deps);
  assert.equal(result.fellBack, 'every mutant of scripts/a.ts, scripts/b.ts was NoCoverage under the related filter');
  assert.equal(runs[1]?.args.at(-1), 'scripts/a.ts,scripts/b.ts');
});

test('a target with no mutants in the report is named; one with mutants is not', async () => {
  const plan: Plan = { ...webPlan, targets: ['apps/web/src/a.ts', 'apps/web/src/b.ts'] };
  const { deps, setPlan } = fakeDeps([report({ 'src/a.ts': [strykerMutant('Killed')] })], [], null);
  setPlan(plan);
  const result = await judgeLane(plan, deps);
  assert.deepEqual(result.noMutants, ['apps/web/src/b.ts']);
  assert.equal('flaky' in result, false, 'no flake, no key');
});
