import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bootstrap,
  inheritedEnv,
  isEntry,
  main,
  MAX_LINE,
  parseArgs,
  readText,
  realDeps,
  removeLiveScratch,
  removeScratchTmp,
  SCRATCH_TMP_PREFIX,
  scratchTmpEnv,
  selectLanes,
  spawnStryker,
  summaryLine,
  unfinishedMerge,
  type CliDeps,
} from './cli.ts';
import { parseConfig, type Config } from './config.ts';
import { FAILED_TESTS_HEADER } from './failed-tests.ts';
import { DRY_RUN_TIMEOUT, type Lane, type Plan } from './lanes.ts';
import { judge } from './verdict.ts';

const FIXTURE = fileURLToPath(new URL('../test/fixture/agnipariksha.json', import.meta.url));
const fixture = parseConfig(readFileSync(FIXTURE, 'utf8'));
if (typeof fixture === 'string') throw new Error(fixture);
const config: Config = fixture;

test('parseArgs: --base, --files, --no-reuse, and refusals', () => {
  assert.deepEqual(parseArgs([]), { reuse: true, trackedOnly: false });
  assert.deepEqual(parseArgs(['--base', 'abc', '--files', 'a.ts,,b.ts', '--no-reuse']), { reuse: false, trackedOnly: false, base: 'abc', files: ['a.ts', 'b.ts'] });
  assert.deepEqual(parseArgs(['--tracked-only']), { reuse: true, trackedOnly: true });
  assert.match(parseArgs(['--base']) as string, /"--base"/);
  assert.match(parseArgs(['--files', '--no-reuse']) as string, /"--files"/);
  assert.match(parseArgs(['--ci']) as string, /"--ci"/);
});

test('parseArgs: --lane is repeatable and comma-separated, and keeps spaces in a name', () => {
  assert.deepEqual(parseArgs(['--lane', 'apps/web']), { reuse: true, trackedOnly: false, lanes: ['apps/web'] });
  assert.deepEqual(parseArgs(['--lane', 'tooling vitest', '--lane', 'tooling node:test,apps/web,']), {
    reuse: true,
    trackedOnly: false,
    lanes: ['tooling vitest', 'tooling node:test', 'apps/web'],
  });
  assert.equal(parseArgs(['--lane', ',']), '--lane names no lane');
  assert.match(parseArgs(['--lane']) as string, /"--lane"/);
  assert.match(parseArgs(['--lane', '--no-reuse']) as string, /"--lane"/);
});

test('selectLanes keeps the config order, and refuses a name the config does not have', () => {
  const lanes = [lane('scripts', 'scripts/'), lane('tools', 'tools/'), lane('docs', 'nothing/')];
  assert.equal(selectLanes(lanes, undefined), lanes);
  assert.deepEqual(
    (selectLanes(lanes, ['docs', 'scripts', 'docs']) as Lane[]).map((l) => l.name),
    ['scripts', 'docs'],
  );
  assert.equal(
    selectLanes(lanes, ['tools', 'web', 'api']),
    '--lane names no lane in agnipariksha.json: "web", "api" (its lanes: "scripts", "tools", "docs")',
  );
});

test('--tracked-only leaves out untracked files: a push carries none', async () => {
  const f = fake({ scripts: mutants('Killed') });
  assert.equal(await main(['--tracked-only'], f.deps), 0);
  assert.ok(f.logs.includes('tools: nothing to judge - not run'), 'the untracked tools/new.ts is not judged');
  assert.equal(f.strykerRuns.length, 1);
  assert.equal(f.gitCalls.some((args) => args.includes('--others') && !args.includes('--cached')), false);
});

test('--lane runs only the lanes it names; an unknown name refuses before the lock', async () => {
  const f = fake({ tools: JSON.stringify({ files: { 'tools/new.ts': { mutants: [] } } }) });
  assert.equal(await main(['--lane', 'tools'], f.deps), 0);
  assert.equal(f.strykerRuns.length, 1);
  assert.ok(f.logs.includes('agnipariksha: tools: stryker run --mutate tools/new.ts'));
  assert.equal(f.logs.some((line) => line.startsWith('scripts') || line.startsWith('docs')), false);
  assert.equal(f.logs.at(-1), 'agnipariksha total: 0 killed of 0 in 1 lane(s), 0 blocking, 0 refused - exit 0');

  const unknown = fake({});
  assert.equal(await main(['--lane', 'web'], unknown.deps), 2);
  assert.deepEqual(unknown.logs, ['agnipariksha REFUSED: --lane names no lane in agnipariksha.json: "web" (its lanes: "scripts", "tools", "docs")']);
  assert.deepEqual(unknown.gitCalls, [], 'refused before the lock or any git call');
  assert.equal(unknown.exits.length, 0);
});

const lane = (name: string, prefix: string): Lane => ({ name, cwd: '', config: `${name}.mjs`, selects: (path) => path.startsWith(prefix), reuse: true, env: () => ({}) });

test('summaryLine names counts, statuses, retries and the verdict', () => {
  const plan: Plan = { lane: lane('scripts', 'scripts/'), targets: ['a', 'b'], suites: [], notJudged: [] };
  const m = { file: 'a', mutator: 'M', replacement: 'r', line: 1, column: 1, endLine: 1, endColumn: 2 };
  const killed = judge([{ ...m, status: 'Killed' }, { ...m, status: 'RuntimeError' }]);
  assert.equal(summaryLine(plan, { judgement: killed, retried: 1, refusals: [], noMutants: [], fellBack: null }), 'scripts: 2 killed of 2 in 2 file(s) (1 Killed, 1 RuntimeError; 1 timeout(s) retried) - pass');
  assert.match(summaryLine(plan, { judgement: judge([{ ...m, status: 'Survived' }]), retried: 0, refusals: [], noMutants: [], fellBack: null }), /- 1 blocking$/);
  assert.match(summaryLine(plan, { judgement: judge([]), retried: 0, refusals: ['x'], noMutants: [], fellBack: null }), /\(no mutants; 0 timeout\(s\) retried\) - REFUSED$/);
});

interface Fake {
  deps: CliDeps;
  logs: string[];
  gitCalls: string[][];
  strykerRuns: string[][];
  files: Map<string, string>;
  exits: (() => void)[];
}

function fake(reports: Record<string, string>, over: Partial<CliDeps> = {}): Fake {
  const logs: string[] = [];
  const gitCalls: string[][] = [];
  const strykerRuns: string[][] = [];
  const files = new Map<string, string>([['/repo/scripts.mjs', 'config'], ['/repo/pnpm-lock.yaml', 'lock'], ['/repo/node_modules/@stryker-mutator/core/package.json', '{}']]);
  const exits: (() => void)[] = [];
  const outputs: Record<string, string> = {
    'rev-parse': '.git\n',
    'merge-base': 'base1\n',
    diff: 'scripts/a.ts\0scripts/b.ts\0scripts/c.ts\0docs/x.md\0',
    'ls-files': 'tools/new.ts\0',
  };
  const deps: CliDeps = {
    root: '/repo',
    reportsDir: '/repo/reports/agnipariksha',
    git: (args) => {
      gitCalls.push(args);
      if (args[0] === 'diff' && args[1] === '-U0') return args.at(-1) === 'scripts/b.ts' ? '@@ -1 +1 @@\n+// note\n' : '@@ -1 +1 @@\n+x();\n';
      return outputs[args[0] as string] ?? '';
    },
    exists: (path) => path.endsWith('.test.ts') && !path.startsWith('scripts/c.'),
    runStryker: async (_cwd, args) => {
      strykerRuns.push(args);
      const name = /agnipariksha\/(.+)\.stryker\.config\.mjs$/.exec(args[1] ?? '')?.[1] ?? '';
      const text = reports[name];
      if (text !== undefined) files.set(`/repo/reports/agnipariksha/${name}.json`, text);
      return { code: text === undefined ? 1 : 0, seen: text === undefined ? ['No tests were executed'] : [] };
    },
    readFile: (path) => files.get(path),
    writeFile: (path, text) => {
      files.set(path, text);
    },
    removeFile: (path) => {
      files.delete(path);
    },
    now: () => 0,
    pid: 42,
    lanes: [lane('scripts', 'scripts/'), lane('tools', 'tools/'), lane('docs', 'nothing/')],
    upstream: 'origin/main',
    keyPolicy: config.reuseKey,
    atExit: (fn) => exits.push(fn),
    log: (line) => logs.push(line),
    lock: {
      create: (path, text) => (files.has(path) ? false : (files.set(path, text), true)),
      read: (path) => files.get(path),
      remove: (path) => {
        files.delete(path);
      },
      alive: () => true,
      now: () => 0,
      sleep: async () => undefined,
      log: () => undefined,
    },
    ...over,
  };
  return { deps, logs, gitCalls, strykerRuns, files, exits };
}

const mutants = (...statuses: string[]) =>
  JSON.stringify({
    files: {
      'scripts/a.ts': {
        mutants: statuses.map((status, i) => ({ mutatorName: 'M', replacement: 'r', status, location: { start: { line: i + 1, column: 1 }, end: { line: i + 1, column: 3 } } })),
      },
    },
  });

test('a clean push: comment-only and unowned files are skipped, every lane passes, the lock is released', async () => {
  const f = fake({ scripts: mutants('Killed', 'RuntimeError', 'Ignored'), tools: JSON.stringify({ files: { 'tools/new.ts': { mutants: [] } } }) });
  assert.equal(await main([], f.deps), 0);
  assert.deepEqual(f.logs, [
    '  not judged (comment-only change): scripts/b.ts',
    '  not judged (no colocated suite): scripts/c.ts',
    'agnipariksha: scripts: stryker run --mutate scripts/a.ts',
    'scripts: 2 killed of 2 in 1 file(s) (1 Killed, 1 RuntimeError; 0 timeout(s) retried) - pass',
    'agnipariksha: tools: stryker run --mutate tools/new.ts',
    "  no mutants (absent from Stryker's report): tools/new.ts",
    'tools: 0 killed of 0 in 1 file(s) (no mutants; 0 timeout(s) retried) - pass',
    'docs: nothing to judge - not run',
    'agnipariksha total: 2 killed of 2 in 2 lane(s), 0 blocking, 0 refused - exit 0',
  ]);
  assert.equal(f.files.has('/repo/.git/agnipariksha.lock'), false);
  assert.equal(f.exits.length, 1);
  assert.ok(f.gitCalls.some((args) => args.join(' ') === 'diff -U0 --no-color base1 -- scripts/a.ts'));
  assert.equal(f.gitCalls.some((args) => args.at(-1) === 'tools/new.ts' && args[1] === '-U0'), false, 'untracked files are always judged');
  assert.ok(f.strykerRuns[0]?.includes('--incremental'), 'reuse is on by default');
});

test('a blocking mutant exits 1 even when another lane refuses', async () => {
  const f = fake({ scripts: mutants('Survived') });
  assert.equal(await main(['--no-reuse'], f.deps), 1);
  assert.ok(f.logs.includes('  Survived scripts/a.ts:1 (M)'));
  assert.ok(f.logs.includes('  REFUSED tools: Stryker exited 1 (No tests were executed)'));
  assert.equal(f.logs.at(-1), 'agnipariksha total: 0 killed of 1 in 2 lane(s), 1 blocking, 1 refused - exit 1');
  assert.equal(f.strykerRuns[0]?.includes('--incremental'), false);
});

test('a lane that falls back says so, and its fallback result is the verdict', async () => {
  const related: Lane = { ...lane('scripts', 'scripts/'), env: () => ({ MODE: 'related' }), fallback: () => ({ MODE: 'own' }) };
  const f = fake({ scripts: mutants('Killed') });
  const run = f.deps.runStryker;
  f.deps.runStryker = async (cwd, args, env) =>
    env.MODE === 'related' ? { code: 1, seen: ['Vitest failed to find test files related to mutated files'] } : run(cwd, args, env);
  assert.equal(await main(['--files', 'scripts/a.ts'], { ...f.deps, lanes: [related] }), 0);
  assert.ok(
    f.logs.includes('  fallback: scripts reran in its own-suite mode: its dry run failed: "Vitest failed to find test files related to mutated files"'),
  );
  assert.match(f.logs.at(-1) ?? '', /1 killed of 1 in 1 lane\(s\), 0 blocking, 0 refused - exit 0/);
});

test('a refusal alone exits 2', async () => {
  const f = fake({ scripts: mutants('Killed') });
  assert.equal(await main(['--no-reuse'], f.deps), 2);
});

test('--files judges exactly those files, whatever their diff', async () => {
  const f = fake({ scripts: mutants('Killed') });
  assert.equal(await main(['--files', 'scripts/b.ts'], f.deps), 0);
  assert.equal(f.gitCalls.some((args) => args[0] === 'diff' || args[0] === 'merge-base'), false);
  assert.deepEqual(f.strykerRuns[0]?.slice(-2), ['--mutate', 'scripts/b.ts']);
});

test('a reuse key that cannot be read means a full run', async () => {
  const f = fake({ scripts: mutants('Killed') });
  f.files.delete('/repo/pnpm-lock.yaml');
  assert.equal(await main(['--files', 'scripts/a.ts'], f.deps), 0);
  assert.equal(f.strykerRuns[0]?.includes('--incremental'), false);
});

test('a bad argument or a held lock refuses with exit 2', async () => {
  const bad = fake({});
  assert.equal(await main(['--nope'], bad.deps), 2);
  assert.match(bad.logs[0] ?? '', /REFUSED: unsupported/);

  const held = fake({});
  held.files.set('/repo/.git/agnipariksha.lock', '7 then');
  let clock = 0;
  held.deps.lock.now = () => (clock += 60 * 60_000);
  assert.equal(await main([], held.deps), 2);
  assert.match(held.logs[0] ?? '', /REFUSED: another mutation run \(pid 7 then\)/);
});

test('a git failure refuses with exit 2 and releases the lock', async () => {
  const f = fake({});
  const git = f.deps.git;
  f.deps.git = (args) => {
    if (args[0] === 'merge-base') throw new Error('no origin/main');
    return git(args);
  };
  assert.equal(await main([], f.deps), 2);
  assert.deepEqual(f.logs, ['agnipariksha REFUSED: no origin/main']);
  assert.equal(f.files.has('/repo/.git/agnipariksha.lock'), false);
});

test('an unfinished merge refuses before the lock, naming the merge and the way out', async () => {
  const f = fake({ scripts: mutants('Killed') });
  f.files.set('/repo/.git/MERGE_HEAD', 'abcdef0123456789abcdef0123456789abcdef01\n');
  f.files.set('/repo/.git/MERGE_MSG', "Merge remote-tracking branch 'origin/main' into feat\n\n# Conflicts:\n#\tscripts/a.ts\n");
  const git = f.deps.git;
  f.deps.git = (args) => (args[0] === 'rev-parse' && args[1] === '--git-path' ? `.git/${args[2]}\n` : git(args));
  assert.equal(await main(['--files', 'scripts/a.ts'], f.deps), 2);
  assert.deepEqual(f.logs, [
    `agnipariksha REFUSED: "Merge remote-tracking branch 'origin/main' into feat" (MERGE_HEAD abcdef012345) is not committed: the working tree is half-merged, so a verdict now would say nothing about the branch. Commit the merge (git commit) or abort it (git merge --abort), then run again`,
  ]);
  assert.equal(f.strykerRuns.length, 0);
  assert.equal(f.gitCalls.some((args) => args.includes('--git-common-dir')), false, 'refused before the lock');

  const failing = fake({});
  failing.deps.git = () => {
    throw new Error('git: not a repository');
  };
  assert.equal(await main([], failing.deps), 2);
  assert.deepEqual(failing.logs, ['agnipariksha REFUSED: git: not a repository']);
});

test('unfinishedMerge reads git paths relative to the root or absolute, and names a merge with no message by its head', () => {
  const read = (files: Record<string, string>) => (path: string) => files[path];
  const relative = (args: string[]) => `.git/${args[2]}\n`;
  assert.equal(unfinishedMerge(relative, '/repo', read({})), null);
  const absolute = (args: string[]) => `/main/.git/worktrees/w/${args[2]}\n`;
  assert.match(
    unfinishedMerge(absolute, '/elsewhere', read({ '/main/.git/worktrees/w/MERGE_HEAD': '1111111111112222\n3333333333334444\n' })) ?? '',
    /^a merge \(MERGE_HEAD 111111111111\) is not committed: /,
  );
  assert.match(unfinishedMerge(relative, '/repo', read({ '/repo/.git/MERGE_HEAD': 'abc\n', '/repo/.git/MERGE_MSG': '\n' })) ?? '', /^a merge \(MERGE_HEAD abc\)/);
});

test('unfinishedMerge on real git: a stopped merge in a plain repository and in a linked worktree; a committed merge passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  const git = (cwd: string) => (args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const main_ = join(dir, 'main');
  const wt = join(dir, 'wt');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', main_]);
    const g = git(main_);
    writeFileSync(join(main_, 'a.txt'), 'base\n');
    g(['add', 'a.txt']);
    g(['commit', '-qm', 'base']);
    g(['branch', 'side']);
    writeFileSync(join(main_, 'a.txt'), 'main\n');
    g(['commit', '-qam', 'main']);
    g(['worktree', 'add', '-q', wt, 'side']);
    const w = git(wt);
    writeFileSync(join(wt, 'a.txt'), 'side\n');
    w(['commit', '-qam', 'side']);

    assert.equal(unfinishedMerge(g, main_, readText), null);
    assert.throws(() => g(['merge', '-q', 'side']), /CONFLICT|conflict|failed/);
    assert.match(unfinishedMerge(g, main_, readText) ?? '', /^"Merge branch 'side'" \(MERGE_HEAD [0-9a-f]{12}\) is not committed/);
    assert.throws(() => w(['merge', '-q', 'main']), /CONFLICT|conflict|failed/);
    assert.match(unfinishedMerge(w, wt, readText) ?? '', /^"Merge branch 'main' into side" \(MERGE_HEAD [0-9a-f]{12}\) is not committed/);

    writeFileSync(join(main_, 'a.txt'), 'merged\n');
    g(['commit', '-qam', 'merged']);
    assert.equal(unfinishedMerge(g, main_, readText), null, 'committed: the way out works');
    w(['merge', '--abort']);
    assert.equal(unfinishedMerge(w, wt, readText), null, 'aborted: the way out works');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a blocking file with a sibling suite says once that the sibling is not the owner; a passing one says nothing', async () => {
  const f = fake({ scripts: mutants('Survived', 'NoCoverage') });
  const git = f.deps.git;
  f.deps.git = (args) => (args[0] === 'ls-files' && args.includes('--cached') ? 'scripts/a.ts\0scripts/a.test.ts\0scripts/a-cases.test.ts\0' : git(args));
  assert.equal(await main(['--files', 'scripts/a.ts'], f.deps), 1);
  assert.deepEqual(f.logs.slice(1, 4), [
    '  Survived scripts/a.ts:1 (M)',
    '  NoCoverage scripts/a.ts:2 (M)',
    '  a-cases.test.ts is not the owner; only a.test.ts kills mutants of a.ts: put the tests that should kill them there',
  ]);

  const alone = fake({ scripts: mutants('Survived') });
  assert.equal(await main(['--files', 'scripts/a.ts', '--no-reuse'], alone.deps), 1);
  assert.equal(alone.logs.some((line) => line.includes('not the owner')), false, 'no sibling, no line');

  const passing = fake({ scripts: mutants('Killed') });
  passing.deps.git = f.deps.git;
  assert.equal(await main(['--files', 'scripts/a.ts', '--no-reuse'], passing.deps), 0);
  assert.equal(passing.logs.some((line) => line.includes('not the owner')), false, 'nothing blocks, nothing to say');
});

test('a lane whose first dry run flaked says so', async () => {
  const f = fake({ scripts: mutants('Killed') });
  const run = f.deps.runStryker;
  let calls = 0;
  f.deps.runStryker = async (cwd, args, env) =>
    (calls += 1) === 1 ? { code: 1, seen: ['There were failed tests in the initial test run'], failedTests: ['t'] } : run(cwd, args, env);
  assert.equal(await main(['--files', 'scripts/a.ts'], f.deps), 0);
  assert.ok(f.logs.includes('  flaky: scripts: its initial test run failed on "t", then passed when run again: the test is flaky; fix the flake first (an injected, pinned clock is the usual cure), then run again'));
});

const node = process.execPath;

test("spawnStryker names the failing tests from Stryker's real output, split anywhere, and a last line with no newline", async () => {
  const children = new Set<ChildProcess>();
  const real = readFileSync(fileURLToPath(new URL('../test/fixture/stryker-failed-initial-run.txt', import.meta.url)), 'utf8');
  const cut = real.indexOf('the clock') + 4;
  const script = `process.stdout.write(${JSON.stringify(real.slice(0, cut))}); setTimeout(() => { process.stdout.write(${JSON.stringify(real.slice(cut))}); process.stderr.write(${JSON.stringify(`${FAILED_TESTS_HEADER}\n\tlast one`)}); process.exit(1); }, 50);`;
  const result = await spawnStryker([node, '-e', script], children)('.', [], {});
  assert.deepEqual(result, { code: 1, seen: ['There were failed tests in the initial test run'], failedTests: ['the clock is pinned', 'last one'] });

  const long = `process.stdout.write(${JSON.stringify(FAILED_TESTS_HEADER)} + '\\n\\t' + 'x'.repeat(${MAX_LINE * 3}))`;
  const cutShort = await spawnStryker([node, '-e', long], children)('.', [], {});
  assert.equal(cutShort.failedTests?.[0]?.length, MAX_LINE - 1, 'a line past the cap is cut, never held whole');
});

test('spawnStryker returns the exit code and the markers it saw, across chunks and streams', async () => {
  const children = new Set<ChildProcess>();
  const half = DRY_RUN_TIMEOUT.length >> 1;
  const failed = 'There were failed tests in the initial test run';
  const script = `process.stdout.write(${JSON.stringify(DRY_RUN_TIMEOUT.slice(0, half))}); setTimeout(() => { process.stdout.write(${JSON.stringify(DRY_RUN_TIMEOUT.slice(half))}); process.stderr.write(${JSON.stringify(failed)}); process.exit(3); }, 50);`;
  assert.deepEqual(await spawnStryker([node, '-e', script], children)('.', [], {}), { code: 3, seen: [DRY_RUN_TIMEOUT, failed] });
  assert.deepEqual(await spawnStryker([node, '-e', 'process.exit(Number(process.env.CODE))'], children)('.', [], { CODE: '0' }), { code: 0, seen: [] });
  assert.deepEqual(await spawnStryker([node, '-e', 'process.kill(process.pid, "SIGKILL")'], children)('.', [], {}), { code: 1, seen: [] });
  assert.deepEqual(await spawnStryker(['/nonexistent/stryker'], children)('.', [], {}), { code: 127, seen: [] });
  assert.deepEqual(await spawnStryker([node, '-e', 'console.log("abc")'], children, ['abc'])('.', [], {}), { code: 0, seen: ['abc'] });
});

test('each Stryker run gets its own fresh temp directory, which no lane env can override, removed afterwards', async () => {
  const children = new Set<ChildProcess>();
  const out = mkdtempSync(join(tmpdir(), 'agnipariksha-test-'));
  try {
    const script = `const fs = require('node:fs'); const os = require('node:os'); fs.writeFileSync(process.env.OUT, JSON.stringify({ TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, tmpdir: os.tmpdir(), entries: fs.readdirSync(os.tmpdir()) }));`;
    const run = spawnStryker([node, '-e', script], children);
    const seen = async (): Promise<{ TMPDIR: string; TEMP: string; TMP: string; tmpdir: string; entries: string[] }> => {
      assert.deepEqual(await run('.', [], { OUT: join(out, 'seen.json'), TMPDIR: '/tmp', TMP: '/tmp' }), { code: 0, seen: [] });
      return JSON.parse(readFileSync(join(out, 'seen.json'), 'utf8'));
    };
    const first = await seen();
    assert.equal(first.TEMP, first.TMPDIR);
    assert.equal(first.TMP, first.TMPDIR);
    assert.equal(first.tmpdir, first.TMPDIR, "the child's os.tmpdir() is its own directory");
    assert.ok(first.TMPDIR.startsWith(join(tmpdir(), SCRATCH_TMP_PREFIX)), first.TMPDIR);
    assert.deepEqual(first.entries, [], 'fresh and empty');
    assert.equal(existsSync(first.TMPDIR), false, 'removed after the run');
    const second = await seen();
    assert.notEqual(second.TMPDIR, first.TMPDIR, 'a second run (a retry) gets a directory of its own');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('unsetEnv names are removed from what a Stryker run inherits; a lane env still sets one', async () => {
  assert.deepEqual(inheritedEnv({ A: '1', B: '2', C: '3' }, ['B', 'Z']), { A: '1', C: '3' });
  const children = new Set<ChildProcess>();
  const out = mkdtempSync(join(tmpdir(), 'agnipariksha-test-'));
  const saved = { gone: process.env.AGNIPARIKSHA_TEST_GONE, back: process.env.AGNIPARIKSHA_TEST_BACK };
  process.env.AGNIPARIKSHA_TEST_GONE = 'inherited';
  process.env.AGNIPARIKSHA_TEST_BACK = 'inherited';
  try {
    const script = `require('node:fs').writeFileSync(process.env.OUT, JSON.stringify({ gone: process.env.AGNIPARIKSHA_TEST_GONE ?? null, back: process.env.AGNIPARIKSHA_TEST_BACK ?? null, kept: process.env.PATH !== undefined }));`;
    const run = spawnStryker([node, '-e', script], children, undefined, ['AGNIPARIKSHA_TEST_GONE', 'AGNIPARIKSHA_TEST_BACK']);
    assert.deepEqual(await run('.', [], { OUT: join(out, 'env.json'), AGNIPARIKSHA_TEST_BACK: 'lane' }), { code: 0, seen: [] });
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'env.json'), 'utf8')), { gone: null, back: 'lane', kept: true });
    assert.equal(process.env.AGNIPARIKSHA_TEST_GONE, 'inherited', "the gate's own environment is untouched");
  } finally {
    for (const [key, name] of [['gone', 'AGNIPARIKSHA_TEST_GONE'], ['back', 'AGNIPARIKSHA_TEST_BACK']] as const) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
    rmSync(out, { recursive: true, force: true });
  }
});

test('a run whose temp directory vanished refuses, whatever it exited with', async () => {
  const children = new Set<ChildProcess>();
  const result = await spawnStryker([node, '-e', 'require("node:fs").rmSync(process.env.TMPDIR, { recursive: true })'], children)('.', [], {});
  assert.equal(result.code, 0);
  assert.match(result.refusal ?? '', /^the run's temp directory .*agnipariksha-tmp-.* vanished during the run: .* not trusted$/);
  assert.deepEqual(scratchTmpEnv('/s'), { TMPDIR: '/s', TEMP: '/s', TMP: '/s' });
});

test('a temp directory that cannot be removed is left, never failing the run; an exiting gate removes the live ones', () => {
  assert.doesNotThrow(() =>
    removeScratchTmp('/nowhere', () => {
      throw new Error('EPERM');
    }),
  );
  assert.doesNotThrow(() => removeLiveScratch());
});

test('realDeps reads, writes, removes and locks on the real filesystem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  try {
    const deps = realDeps(dir, new Set(), config);
    assert.equal(deps.reportsDir, join(dir, 'reports/agnipariksha'));
    const file = join(dir, 'a/b/c.txt');
    deps.writeFile(file, 'x');
    assert.equal(deps.readFile(file), 'x');
    assert.equal(deps.exists('a/b/c.txt'), true);
    deps.removeFile(file);
    assert.equal(deps.readFile(file), undefined);
    const lock = join(dir, 'lock');
    assert.equal(deps.lock.create(lock, '1'), true);
    assert.equal(deps.lock.create(lock, '2'), false);
    assert.throws(() => deps.lock.create(join(dir, 'missing/lock'), '1'), /ENOENT/);
    assert.equal(deps.lock.read(lock), '1');
    deps.lock.remove(lock);
    assert.equal(deps.lock.alive(process.pid), true);
    await deps.lock.sleep(1);
    assert.equal(typeof deps.lock.now(), 'number');
    assert.match(realDeps(process.cwd(), new Set(), config).git(['rev-parse', '--is-inside-work-tree']), /true/);
    assert.equal(deps.lanes.length, 7);
    assert.equal(deps.upstream, 'origin/main');
    assert.equal(deps.keyPolicy, config.reuseKey);
    assert.equal(readText(join(dir, 'missing')), undefined);
    assert.equal(deps.pid, process.pid);
    assert.equal(typeof deps.now(), 'number');
    deps.atExit(() => undefined);
    deps.log('realDeps log check');
    deps.lock.log('realDeps lock log check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isEntry recognises this module only, through symlinks too', () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  assert.equal(isEntry(cli), true);
  assert.equal(isEntry(fileURLToPath(import.meta.url)), false);
  assert.equal(isEntry(undefined), false);
  assert.equal(isEntry('/nonexistent/cli.ts'), false);
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  try {
    symlinkSync(cli, join(dir, 'linked.ts'));
    assert.equal(isEntry(join(dir, 'linked.ts')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap refuses with exit 2 on a bad argument, and outside a repository', async () => {
  assert.equal(await bootstrap(['--nope'], new Set()), 2);
  const here = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  try {
    process.chdir(dir);
    assert.equal(await bootstrap([], new Set()), 2);
  } finally {
    process.chdir(here);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap reads agnipariksha.json at the root: missing or bad refuses with exit 2 before any work, valid runs', async () => {
  const here = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  const printed: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => (printed.push(chunk), true)) as typeof process.stdout.write;
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    process.chdir(dir);
    assert.equal(await bootstrap(['--files', 'docs/x.md'], new Set()), 2);
    assert.match(printed.at(-1) ?? '', /^agnipariksha REFUSED: no agnipariksha\.json at .+: it names the lanes to judge/);

    writeFileSync(join(dir, 'agnipariksha.json'), JSON.stringify({ lanes: [] }));
    assert.equal(await bootstrap(['--files', 'docs/x.md'], new Set()), 2);
    assert.equal(printed.at(-1), 'agnipariksha REFUSED: agnipariksha.json.reuseKey is missing\n');
    assert.equal(printed.some((line) => line.includes('nothing to judge')), false, 'a bad config refuses before any lane is planned');

    copyFileSync(FIXTURE, join(dir, 'agnipariksha.json'));
    assert.equal(await bootstrap(['--files', 'docs/x.md'], new Set()), 0);
    assert.match(printed.join(''), /tooling node:test: nothing to judge - not run\n/);
    assert.match(printed.at(-1) ?? '', /^agnipariksha total: 0 killed of 0 in 0 lane\(s\), 0 blocking, 0 refused - exit 0\n$/);
  } finally {
    process.stdout.write = write;
    process.chdir(here);
    rmSync(dir, { recursive: true, force: true });
  }
});
