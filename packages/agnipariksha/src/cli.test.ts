import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  bootstrap,
  entry,
  inheritedEnv,
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
  scratchVanished,
  spawnStryker,
  stopAll,
  summaryLine,
  unfinishedMerge,
  type CliDeps,
  type EntryProcess,
} from './cli.ts';
import { parseConfig, type Config } from './config.ts';
import { FAILED_TESTS_HEADER } from './failed-tests.ts';
import { DRY_RUN_TIMEOUT, type Lane, type Plan } from './lanes.ts';
import { judge } from './verdict.ts';

const FIXTURE = fileURLToPath(new URL('../test/fixture/agnipariksha.json', import.meta.url));
const fixture = parseConfig(readFileSync(FIXTURE, 'utf8'));
if (typeof fixture === 'string') throw new Error(fixture);
const config: Config = fixture;

test('parseArgs: --base, --files, --no-reuse, --pushed-refs, and refusals', () => {
  assert.deepEqual(parseArgs([]), { reuse: true, trackedOnly: false, pushedRefs: false });
  assert.deepEqual(parseArgs(['--base', 'abc', '--files', 'a.ts,,b.ts', '--no-reuse']), { reuse: false, trackedOnly: false, pushedRefs: false, base: 'abc', files: ['a.ts', 'b.ts'] });
  assert.deepEqual(parseArgs(['--tracked-only']), { reuse: true, trackedOnly: true, pushedRefs: false });
  assert.deepEqual(parseArgs(['--tracked-only', '--pushed-refs', '--base', 'origin/main']), { reuse: true, trackedOnly: true, pushedRefs: true, base: 'origin/main' });
  assert.match(parseArgs(['--base']) as string, /"--base"/);
  assert.match(parseArgs(['--files', '--no-reuse']) as string, /"--files"/);
  assert.match(parseArgs(['--ci']) as string, /"--ci"/);
  assert.equal(parseArgs(['--ci', 'x']), 'unsupported or incomplete argument "--ci"', 'an unknown flag refuses even with a value after it');
  assert.equal(parseArgs(['--base', 'a', 'b']), 'unsupported or incomplete argument "b"', 'a flag takes one value');
});

test('parseArgs: --lane is repeatable and comma-separated, and keeps spaces in a name', () => {
  assert.deepEqual(parseArgs(['--lane', 'apps/web']), { reuse: true, trackedOnly: false, pushedRefs: false, lanes: ['apps/web'] });
  assert.deepEqual(parseArgs(['--lane', 'tooling vitest', '--lane', 'tooling node:test,apps/web,']), {
    reuse: true,
    trackedOnly: false,
    pushedRefs: false,
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

/** The fake's lanes, with scripts/a.ts at 3 lines and tools/new.ts unreadable. */
function cutOff(scriptsMax: number, reports: Record<string, string>): Fake {
  const f = fake(reports, { lanes: [{ ...lane('scripts', 'scripts/'), maxLines: scriptsMax }, { ...lane('tools', 'tools/'), maxLines: 1 }, lane('docs', 'nothing/')] });
  f.files.set('/repo/scripts/a.ts', 'one();\n\n// three\n');
  return f;
}
const SCRIPTS_OVER = 'scripts: 3 lines in 1 file(s), over its cut-off of 2 - not judged in this run, CI judges it (--lane "scripts" judges it here)';

test('the cut-off: a run naming no lane leaves out a lane over it, judges the rest, and counts it in the total', async () => {
  const f = cutOff(2, { tools: JSON.stringify({ files: { 'tools/new.ts': { mutants: [] } } }) });
  assert.equal(await main([], f.deps), 0);
  assert.deepEqual(f.logs, [
    '  not judged (comment-only change): scripts/b.ts',
    '  not judged (no colocated suite): scripts/c.ts',
    SCRIPTS_OVER,
    'agnipariksha: tools: stryker run --mutate tools/new.ts',
    "  no mutants (absent from Stryker's report): tools/new.ts",
    'tools: 0 killed of 0 in 1 file(s) (no mutants; 0 timeout(s) retried) - pass',
    'docs: nothing to judge - not run',
    'agnipariksha total: 0 killed of 0 in 1 lane(s), 0 blocking, 0 refused, 1 over the cut-off for CI - exit 0',
  ]);
  assert.equal(f.strykerRuns.length, 1, 'only tools ran: its unreadable file counts 0 lines, under its cut-off of 1');
});

test('the cut-off: a lane at it is judged, and so is a lane --lane names, whatever its size', async () => {
  const at = cutOff(3, { scripts: mutants('Killed') });
  assert.equal(await main(['--tracked-only'], at.deps), 0);
  assert.ok(at.logs.includes('agnipariksha: scripts: stryker run --mutate scripts/a.ts'));
  assert.equal(at.logs.at(-1), 'agnipariksha total: 1 killed of 1 in 1 lane(s), 0 blocking, 0 refused - exit 0');

  const named = cutOff(2, { scripts: mutants('Survived') });
  assert.equal(await main(['--lane', 'scripts'], named.deps), 1);
  assert.equal(named.logs.includes(SCRIPTS_OVER), false);
  assert.equal(named.strykerRuns.length, 1);
  assert.equal(named.logs.at(-1), 'agnipariksha total: 0 killed of 1 in 1 lane(s), 1 blocking, 0 refused - exit 1');
});

test('the cut-off: --files without --lane still applies it, and a run with every lane over it passes having judged none', async () => {
  const files = cutOff(2, {});
  assert.equal(await main(['--files', 'scripts/a.ts'], files.deps), 0);
  assert.deepEqual(files.strykerRuns, []);
  assert.ok(files.logs.includes(SCRIPTS_OVER));
  assert.equal(files.logs.at(-1), 'agnipariksha total: 0 killed of 0 in 0 lane(s), 0 blocking, 0 refused, 1 over the cut-off for CI - exit 0');

  const tracked = cutOff(2, {});
  assert.equal(await main(['--tracked-only'], tracked.deps), 0);
  assert.deepEqual(tracked.strykerRuns, []);
  assert.equal(tracked.logs.at(-1), 'agnipariksha total: 0 killed of 0 in 0 lane(s), 0 blocking, 0 refused, 1 over the cut-off for CI - exit 0');
});

const lane = (name: string, prefix: string): Lane => ({ name, cwd: '', config: `${name}.mjs`, selects: (path) => path.startsWith(prefix), reuse: true, env: () => ({}) });

test('summaryLine names counts, statuses, retries and the verdict', () => {
  const plan: Plan = { lane: lane('scripts', 'scripts/'), targets: ['a', 'b'], suites: [], notJudged: [] };
  const m = { file: 'a', mutator: 'M', replacement: 'r', line: 1, column: 1, endLine: 1, endColumn: 2 };
  const killed = judge([{ ...m, status: 'Killed' }, { ...m, status: 'RuntimeError' }]);
  assert.equal(summaryLine(plan, { judgement: killed, retried: 1, refusals: [], noMutants: [], fellBack: null, ownSuites: [] }), 'scripts: 2 killed of 2 in 2 file(s) (1 Killed, 1 RuntimeError; 1 timeout(s) retried) - pass');
  assert.match(summaryLine(plan, { judgement: judge([{ ...m, status: 'Survived' }]), retried: 0, refusals: [], noMutants: [], fellBack: null, ownSuites: [] }), /- 1 blocking$/);
  assert.match(summaryLine(plan, { judgement: judge([]), retried: 0, refusals: ['x'], noMutants: [], fellBack: null, ownSuites: [] }), /\(no mutants; 0 timeout\(s\) retried\) - REFUSED$/);
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
      // Strict: a rev-parse the gate does not make throws, so a mutated argument refuses the run.
      if (args[0] === 'rev-parse') {
        if (args.join(' ') === 'rev-parse --git-common-dir') return '.git\n';
        if (args[1] === '--git-path' && args.length === 3) return `.git/${args[2]}\n`;
        throw new Error(`fatal: unexpected git ${args.join(' ')}`);
      }
      return outputs[args[0] as string] ?? '';
    },
    exists: (path) => path.endsWith('.test.ts') && !path.startsWith('scripts/c.'),
    pathExists: (path) => files.has(path),
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
    readStdin: () => {
      throw new Error('stdin read without --pushed-refs');
    },
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
    f.logs.includes('  fallback: scripts reran with its fallbackEnv: its dry run failed: "Vitest failed to find test files related to mutated files"'),
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
  assert.deepEqual(held.logs, ['agnipariksha REFUSED: waited over 30 min for /repo/.git/agnipariksha.lock: 1 other run(s) held it in turn, the last pid 7 then']);
});

const LOCK = '/repo/.git/agnipariksha.lock';

test('a git failure while planning refuses with exit 2, before the lock', async () => {
  const f = fake({});
  const git = f.deps.git;
  f.deps.git = (args) => {
    if (args[0] === 'merge-base') throw new Error('no origin/main');
    return git(args);
  };
  assert.equal(await main([], f.deps), 2);
  assert.deepEqual(f.logs, ['agnipariksha REFUSED: no origin/main']);
  assert.equal(f.files.has(LOCK), false);
  assert.equal(f.exits.length, 0, 'no lock taken');
  assert.equal(f.gitCalls.some((args) => args.includes('--git-common-dir')), false);
});

test('a git failure under the lock refuses with exit 2 and releases the lock', async () => {
  const f = fake({});
  const git = f.deps.git;
  let bases = 0;
  f.deps.git = (args) => {
    if (args[0] === 'merge-base' && (bases += 1) > 1) throw new Error('origin/main is gone');
    return git(args);
  };
  assert.equal(await main([], f.deps), 2);
  assert.deepEqual(f.logs, ['agnipariksha REFUSED: origin/main is gone']);
  assert.equal(f.exits.length, 1, 'the lock was taken');
  assert.equal(f.files.has(LOCK), false, 'and released');
  assert.deepEqual(f.strykerRuns, []);
});

/** Another live pid holds the lock, and any use of the lock's deps fails the run; returns the uses. */
function lockHeld(f: Fake): string[] {
  const used: string[] = [];
  f.files.set(LOCK, '7 then');
  const use = (name: string) => (): never => {
    used.push(name);
    throw new Error(`the lock's ${name} was called`);
  };
  f.deps.lock = { create: use('create'), read: use('read'), remove: use('remove'), alive: use('alive'), now: use('now'), sleep: use('sleep'), log: use('log') };
  return used;
}

/** Asserts the run never went near the lock: no lock dep, no common-dir lookup, no release, the holder's file intact. */
function lockUntouched(f: Fake, used: readonly string[]): void {
  assert.deepEqual(used, []);
  assert.equal(f.gitCalls.some((args) => args.includes('--git-common-dir')), false);
  assert.equal(f.exits.length, 0);
  assert.equal(f.files.get(LOCK), '7 then');
  assert.deepEqual(f.strykerRuns, []);
}

test('nothing to judge: a docs-only change exits 0 at once, never waiting on a lock another run holds', async () => {
  const f = fake({});
  const git = f.deps.git;
  f.deps.git = (args) => (args[0] === 'diff' && args[1] === '--name-only' ? 'docs/x.md\0' : git(args));
  const used = lockHeld(f);
  assert.equal(await main(['--tracked-only'], f.deps), 0);
  assert.deepEqual(f.logs, [
    'scripts: nothing to judge - not run',
    'tools: nothing to judge - not run',
    'docs: nothing to judge - not run',
    'agnipariksha total: 0 killed of 0 in 0 lane(s), 0 blocking, 0 refused - exit 0',
  ]);
  lockUntouched(f, used);
});

test('nothing to judge: a change only in a lane over its cut-off exits 0 at once, never waiting on a lock another run holds', async () => {
  const f = cutOff(2, {});
  const used = lockHeld(f);
  assert.equal(await main(['--tracked-only'], f.deps), 0);
  assert.deepEqual(f.logs, [
    '  not judged (comment-only change): scripts/b.ts',
    '  not judged (no colocated suite): scripts/c.ts',
    SCRIPTS_OVER,
    'tools: nothing to judge - not run',
    'docs: nothing to judge - not run',
    'agnipariksha total: 0 killed of 0 in 0 lane(s), 0 blocking, 0 refused, 1 over the cut-off for CI - exit 0',
  ]);
  lockUntouched(f, used);
});

test('a run that waits for the lock plans again under it, and judges the tree as it is then', async () => {
  const f = fake({ scripts: mutants('Killed') });
  let diff = 'scripts/a.ts\0';
  const git = f.deps.git;
  f.deps.git = (args) => (args[0] === 'diff' && args[1] === '--name-only' ? diff : git(args));
  f.files.set(LOCK, '7 then');
  const waits: string[] = [];
  f.deps.lock.log = (line) => waits.push(line);
  // The holder finishes, and meanwhile the change to scripts/a.ts is undone.
  f.deps.lock.sleep = async () => {
    f.files.delete(LOCK);
    diff = 'docs/x.md\0';
  };
  assert.equal(await main(['--tracked-only'], f.deps), 0);
  assert.deepEqual(waits, ['agnipariksha: waiting for pid 7 then, which holds /repo/.git/agnipariksha.lock']);
  assert.deepEqual(f.logs, [
    'scripts: nothing to judge - not run',
    'tools: nothing to judge - not run',
    'docs: nothing to judge - not run',
    'agnipariksha total: 0 killed of 0 in 0 lane(s), 0 blocking, 0 refused - exit 0',
  ]);
  assert.deepEqual(f.strykerRuns, []);
  assert.equal(f.exits.length, 1, 'the lock was taken');
  assert.equal(f.files.has(LOCK), false, 'and released');
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

const PUSHED_HEAD = '1a'.repeat(20);
const PUSHED_ZERO = '0'.repeat(40);

/** The fake, given `refs` on stdin, with HEAD at PUSHED_HEAD and a clean tracked tree. */
function pushing(refs: string, reports: Record<string, string> = {}): Fake {
  const f = fake(reports, { readStdin: () => refs });
  const git = f.deps.git;
  f.deps.git = (args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD^{commit}') {
      f.gitCalls.push(args);
      return `${PUSHED_HEAD}\n${args.slice(2).map((arg) => arg.replace('^{commit}', '')).join('\n')}\n`;
    }
    if (args.join(' ') === 'diff --name-only -z HEAD --') {
      f.gitCalls.push(args);
      return '';
    }
    return git(args);
  };
  return f;
}

test('--pushed-refs: a push of HEAD from a clean tree runs as it does without the flag', async () => {
  const reports = { scripts: mutants('Killed', 'RuntimeError', 'Ignored'), tools: JSON.stringify({ files: { 'tools/new.ts': { mutants: [] } } }) };
  const plain = fake(reports);
  assert.equal(await main(['--tracked-only'], plain.deps), 0);
  const f = pushing(`refs/heads/feat ${PUSHED_HEAD} refs/heads/feat ${PUSHED_ZERO}\n`, reports);
  assert.equal(await main(['--tracked-only', '--pushed-refs'], f.deps), 0);
  assert.deepEqual(f.logs, plain.logs);
  assert.equal(f.strykerRuns.length, plain.strykerRuns.length);
  assert.deepEqual(f.gitCalls.slice(0, 2), [['rev-parse', 'HEAD^{commit}', `${PUSHED_HEAD}^{commit}`], ['diff', '--name-only', '-z', 'HEAD', '--']]);
});

test('--pushed-refs: a ref other than HEAD refuses before the lock, judging nothing', async () => {
  const other = `0${'2b'.repeat(19)}0`;
  const f = pushing(`refs/heads/other ${other} refs/heads/other ${PUSHED_ZERO}\n`);
  assert.equal(await main(['--pushed-refs'], f.deps), 2);
  assert.deepEqual(f.logs, [
    'agnipariksha REFUSED: the push carries refs/heads/other at 02b2b2b2b2b2, not the checked-out HEAD (1a1a1a1a1a1a): the gate judges HEAD and the files on disk, so its verdict would not be about refs/heads/other. Check out refs/heads/other and push again',
  ]);
  assert.deepEqual(f.strykerRuns, []);
  assert.equal(f.exits.length, 0, 'refused before the lock');
});

test('--pushed-refs: deletions only judge nothing and pass, before the lock', async () => {
  const f = pushing(`(delete) ${PUSHED_ZERO} refs/heads/old ${PUSHED_HEAD}\n`);
  assert.equal(await main(['--tracked-only', '--pushed-refs'], f.deps), 0);
  assert.deepEqual(f.logs, ['agnipariksha: the push carries no commit (up to date, or deletions only) - nothing to judge']);
  assert.deepEqual(f.gitCalls, []);
  assert.deepEqual(f.strykerRuns, []);
  assert.equal(f.exits.length, 0);
});

test('--pushed-refs: stdin that cannot be read refuses with exit 2', async () => {
  const f = fake({}, {
    readStdin: () => {
      throw new Error('EAGAIN: resource temporarily unavailable, read');
    },
  });
  assert.equal(await main(['--pushed-refs'], f.deps), 2);
  assert.deepEqual(f.logs, ['agnipariksha REFUSED: EAGAIN: resource temporarily unavailable, read']);
  assert.deepEqual(f.gitCalls, []);
});

test('unfinishedMerge reads git paths relative to the root or absolute, names a merge with no message by its head, and refuses an unreadable one', () => {
  const on = (files: Record<string, string>) => [(path: string) => files[path], (path: string) => Object.hasOwn(files, path)] as const;
  const relative = (args: string[]) => `.git/${args[2]}\n`;
  assert.equal(unfinishedMerge(relative, '/repo', ...on({})), null);
  const absolute = (args: string[]) => `/main/.git/worktrees/w/${args[2]}\n`;
  assert.match(
    unfinishedMerge(absolute, '/elsewhere', ...on({ '/main/.git/worktrees/w/MERGE_HEAD': '1111111111112222\n3333333333334444\n' })) ?? '',
    /^a merge \(MERGE_HEAD 111111111111\) is not committed: /,
  );
  assert.match(unfinishedMerge(relative, '/repo', ...on({ '/repo/.git/MERGE_HEAD': 'abc\n', '/repo/.git/MERGE_MSG': '\n' })) ?? '', /^a merge \(MERGE_HEAD abc\)/);
  // The subject is the message's first line, trimmed.
  assert.match(unfinishedMerge(relative, '/repo', ...on({ '/repo/.git/MERGE_HEAD': 'abc\n', '/repo/.git/MERGE_MSG': '  Merge side  \nbody\n' })) ?? '', /^"Merge side" \(MERGE_HEAD abc\) is not committed/);
  // There but unreadable (a permission, a race): the tree may still be half-merged, so it refuses.
  const unreadable = unfinishedMerge(relative, '/repo', () => undefined, (path) => path === '/repo/.git/MERGE_HEAD');
  assert.match(unreadable ?? '', /^a merge \(\/repo\/\.git\/MERGE_HEAD, unreadable\) is not committed: .*then run again$/);
});

test('unfinishedMerge on real git: a stopped merge in a plain repository and in a linked worktree; a committed merge passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  // Hermetic: none of the machine's git config, trace or maintenance reaches the fixture, and it has its own identity.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|CONFIG)/.test(key)));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' });
  const settings = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
  const git = (cwd: string) => (args: string[]) => execFileSync('git', [...settings, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const main_ = join(dir, 'main');
  const wt = join(dir, 'wt');
  try {
    git(dir)(['init', '-q', '-b', 'main', main_]);
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

    assert.equal(unfinishedMerge(g, main_, readText, existsSync), null);
    // A conflict stops each merge before its commit; the fixture's shape is checked, not only the exit.
    assert.throws(() => g(['merge', 'side']));
    assert.match(g(['rev-parse', '--verify', '-q', 'MERGE_HEAD']), /^[0-9a-f]{40}\n$/);
    assert.match(unfinishedMerge(g, main_, readText, existsSync) ?? '', /^"Merge branch 'side'" \(MERGE_HEAD [0-9a-f]{12}\) is not committed/);
    assert.throws(() => w(['merge', 'main']));
    assert.match(w(['rev-parse', '--verify', '-q', 'MERGE_HEAD']), /^[0-9a-f]{40}\n$/);
    assert.ok(w(['rev-parse', '--git-path', 'MERGE_HEAD']).startsWith('/'), "a linked worktree's git path is absolute");
    assert.match(unfinishedMerge(w, wt, readText, existsSync) ?? '', /^"Merge branch 'main' into side" \(MERGE_HEAD [0-9a-f]{12}\) is not committed/);

    writeFileSync(join(main_, 'a.txt'), 'merged\n');
    g(['commit', '-qam', 'merged']);
    assert.equal(unfinishedMerge(g, main_, readText, existsSync), null, 'committed: the way out works');
    w(['merge', '--abort']);
    assert.equal(unfinishedMerge(w, wt, readText, existsSync), null, 'aborted: the way out works');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a blocking file with a sibling suite, in a run narrowed to the owning suites, says once that the sibling did not run', async () => {
  const narrowed: Lane = { ...lane('scripts', 'scripts/'), ownSuites: true };
  const withSibling = (f: Fake): Fake => {
    const git = f.deps.git;
    f.deps.git = (args) => (args[0] === 'ls-files' && args.includes('--cached') ? 'scripts/a.ts\0scripts/a.test.ts\0scripts/a-cases.test.ts\0' : git(args));
    return f;
  };
  const f = withSibling(fake({ scripts: mutants('Survived', 'NoCoverage') }));
  assert.equal(await main(['--files', 'scripts/a.ts'], { ...f.deps, lanes: [narrowed] }), 1);
  assert.deepEqual(f.logs.slice(1, 4), [
    '  Survived scripts/a.ts:1 (M)',
    '  NoCoverage scripts/a.ts:2 (M)',
    '  a-cases.test.ts is not the owner, so it did not run; only a.test.ts kills mutants of a.ts here: put the tests that should kill them there',
  ]);

  // Under a related filter (the lane's own run not narrowed) the sibling ran if it imports the file: nothing to say.
  const related = withSibling(fake({ scripts: mutants('Survived') }));
  assert.equal(await main(['--files', 'scripts/a.ts', '--no-reuse'], related.deps), 1);
  assert.equal(related.logs.some((line) => line.includes('not the owner')), false, 'related mode, no line');

  const alone = fake({ scripts: mutants('Survived') });
  assert.equal(await main(['--files', 'scripts/a.ts', '--no-reuse'], { ...alone.deps, lanes: [narrowed] }), 1);
  assert.equal(alone.logs.some((line) => line.includes('not the owner')), false, 'no sibling, no line');

  const passing = withSibling(fake({ scripts: mutants('Killed') }));
  assert.equal(await main(['--files', 'scripts/a.ts', '--no-reuse'], { ...passing.deps, lanes: [narrowed] }), 0);
  assert.equal(passing.logs.some((line) => line.includes('not the owner')), false, 'nothing blocks, nothing to say');

  // The owning suite was removed while Stryker ran: there is no owner to name, so nothing is said.
  const vanished = withSibling(fake({ scripts: mutants('Survived') }));
  const exists = vanished.deps.exists;
  const run = vanished.deps.runStryker;
  let ran = false;
  vanished.deps.exists = (path) => !ran && exists(path);
  vanished.deps.runStryker = async (cwd, args, env) => ((ran = true), run(cwd, args, env));
  assert.equal(await main(['--files', 'scripts/a.ts', '--no-reuse'], { ...vanished.deps, lanes: [narrowed] }), 1);
  assert.equal(vanished.logs.some((line) => line.includes('not the owner')), false, 'no owner now, no line');
});

test('a lane with two files names both in its stryker line, and the tracked list is asked for exactly', async () => {
  const f = fake({ scripts: mutants('Killed') });
  assert.equal(await main(['--files', 'scripts/a.ts,scripts/b.ts'], f.deps), 0);
  assert.ok(f.logs.includes('agnipariksha: scripts: stryker run --mutate scripts/a.ts,scripts/b.ts'), f.logs.join('\n'));
  assert.ok(f.gitCalls.some((args) => args.join(' ') === 'ls-files -z --cached --others --exclude-standard'), 'the reuse key reads every tracked and untracked file');
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
// A mutant that keeps a run, a lock or a sleep from settling fails the tests that reach one at 15 s,
// well inside a retry's 180 s: several such tests in a row must still fit the retry pass's budget.
const HANG = { timeout: 15_000 };

test("spawnStryker names the failing tests from Stryker's real output, split anywhere, and a last line with no newline", HANG, async () => {
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

test('spawnStryker keeps a test name whole across chunks: a split character is joined, and an over-long line is its prefix only', HANG, async () => {
  const children = new Set<ChildProcess>();
  // "é" is two bytes in UTF-8: the first chunk ends between them.
  const split = `const b = Buffer.from(${JSON.stringify(`${FAILED_TESTS_HEADER}\n\tcafé works\n`)}); const at = b.indexOf(0xc3) + 1; process.stdout.write(b.subarray(0, at)); setTimeout(() => process.stdout.write(b.subarray(at)), 50);`;
  assert.deepEqual((await spawnStryker([node, '-e', split], children)('.', [], {})).failedTests, ['café works']);

  // The over-long line spans three chunks and ends in "TAIL"; the next line is whole.
  const write = (text: string) => `process.stdout.write(${JSON.stringify(text)})`;
  const spliced = [
    write(`${FAILED_TESTS_HEADER}\n\t${'a'.repeat(MAX_LINE)}`),
    write('b'.repeat(MAX_LINE)),
    write('TAIL\n\tnext test\n'),
  ];
  const script = `${spliced[0]}; setTimeout(() => { ${spliced[1]}; setTimeout(() => ${spliced[2]}, 50); }, 50);`;
  const names = (await spawnStryker([node, '-e', script], children)('.', [], {})).failedTests ?? [];
  assert.deepEqual(names, [`${'a'.repeat(MAX_LINE - 1)}`, 'next test'], 'the prefix only, never the prefix spliced to the tail');
});

test('spawnStryker returns the exit code and the markers it saw, across chunks and streams', HANG, async () => {
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

test('each Stryker run gets its own fresh temp directory, which no lane env can override, removed afterwards', HANG, async () => {
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
    assert.equal(basename(first.TMPDIR).slice(0, -6), 'agnipariksha-tmp-', 'named so a leftover is recognisable');
    assert.deepEqual(first.entries, [], 'fresh and empty');
    assert.equal(existsSync(first.TMPDIR), false, 'removed after the run');
    const second = await seen();
    assert.notEqual(second.TMPDIR, first.TMPDIR, 'a second run (a retry) gets a directory of its own');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('unsetEnv names are removed from what a Stryker run inherits; a lane env still sets one', HANG, async () => {
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

test('a run whose temp directory vanished refuses, whatever it exited with', HANG, async () => {
  // The child removes whatever TMPDIR it is given. A mutant that drops the
  // scratch variables hands it the test's own TMPDIR, so the test owns one:
  // under a gate run, the inherited TMPDIR is the gate's own scratch.
  const keys = ['TMPDIR', 'TEMP', 'TMP'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const owned = mkdtempSync(join(tmpdir(), 'agnipariksha-test-'));
  for (const key of keys) process.env[key] = owned;
  try {
    const children = new Set<ChildProcess>();
    const result = await spawnStryker([node, '-e', 'require("node:fs").rmSync(process.env.TMPDIR, { recursive: true })'], children)('.', [], {});
    assert.equal(result.code, 0);
    assert.match(result.refusal ?? '', /^the run's temp directory .*agnipariksha-tmp-.* vanished during the run: .* not trusted$/);
    assert.deepEqual(scratchTmpEnv('/s'), { TMPDIR: '/s', TEMP: '/s', TMP: '/s' });
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(owned, { recursive: true, force: true });
  }
});

test('a temp directory that cannot be removed is left, never failing the run; an exiting gate removes the live ones', () => {
  assert.doesNotThrow(() =>
    removeScratchTmp('/nowhere', () => {
      throw new Error('EPERM');
    }),
  );
  assert.doesNotThrow(() => removeLiveScratch());
});

/** Wait, on real timers, until `path` holds text; give up after 15 s, so a failed test leaves nothing polling. */
async function written(path: string): Promise<string> {
  for (let tries = 0; tries < 750; tries += 1) {
    const text = readText(path);
    if (text !== undefined && text !== '') return text;
    await delay(20);
  }
  throw new Error(`nothing was written to ${path}`);
}

test('a run tees its output to the gate, inherits its stdin, and its temp directory is removed with what the child left in it', HANG, async () => {
  const children = new Set<ChildProcess>();
  const out = mkdtempSync(join(tmpdir(), 'agnipariksha-test-'));
  const printed: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  try {
    const script = `const fs = require('node:fs'); fs.writeFileSync(require('node:path').join(process.env.TMPDIR, 'left'), 'x'); const s = fs.fstatSync(0); fs.writeFileSync(process.env.OUT, JSON.stringify({ tmp: process.env.TMPDIR, stdin: [s.dev, s.ino] })); console.log('tee-check-1');`;
    // Captured and still written: the test reporter's own lines go to stdout too.
    process.stdout.write = ((chunk: string | Uint8Array) => (printed.push(String(chunk)), write(chunk))) as typeof process.stdout.write;
    const result = await spawnStryker([node, '-e', script], children)('.', [], { OUT: join(out, 'seen.json') });
    process.stdout.write = write;
    assert.deepEqual(result, { code: 0, seen: [] });
    assert.ok(printed.join('').includes('tee-check-1'), 'the child prints through the gate');
    const seen = JSON.parse(readFileSync(join(out, 'seen.json'), 'utf8')) as { tmp: string; stdin: number[] };
    const own = fstatSync(0);
    assert.deepEqual(seen.stdin, [own.dev, own.ino], "the child's stdin is the gate's own");
    assert.equal(existsSync(seen.tmp), false, 'removed, with the file the child left');
  } finally {
    process.stdout.write = write;
    rmSync(out, { recursive: true, force: true });
  }
});

test("a run's last partial character reads as U+FFFD, and a spawn that fails leaves no temp directory", HANG, async () => {
  const children = new Set<ChildProcess>();
  // On stderr: a line left open on stdout would run into the test reporter's next line.
  const partial = `process.stderr.write(${JSON.stringify(`${FAILED_TESTS_HEADER}\n\tname`)}); process.stderr.write(Buffer.from([0xc3]));`;
  assert.deepEqual((await spawnStryker([node, '-e', partial], children)('.', [], {})).failedTests, ['name�']);
  // A TMPDIR of its own: under a gate run, every test runner shares the inherited one and makes scratch in it.
  const keys = ['TMPDIR', 'TEMP', 'TMP'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const owned = mkdtempSync(join(tmpdir(), 'agnipariksha-test-'));
  for (const key of keys) process.env[key] = owned;
  try {
    assert.deepEqual(await spawnStryker(['/nonexistent/stryker'], children)('.', [], {}), { code: 127, seen: [] });
    assert.deepEqual(readdirSync(owned), [], 'the failed spawn left nothing behind');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(owned, { recursive: true, force: true });
  }
});

test('with no unset list, a run inherits every variable, even one named like a mutant', HANG, async () => {
  const children = new Set<ChildProcess>();
  const out = mkdtempSync(join(tmpdir(), 'agnipariksha-test-'));
  const name = 'Stryker was here';
  const saved = process.env[name];
  process.env[name] = 'kept';
  try {
    const script = `require('node:fs').writeFileSync(process.env.OUT, process.env[${JSON.stringify(name)}] ?? 'gone')`;
    assert.deepEqual(await spawnStryker([node, '-e', script], children)('.', [], { OUT: join(out, 'env') }), { code: 0, seen: [] });
    assert.equal(readFileSync(join(out, 'env'), 'utf8'), 'kept');
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
    rmSync(out, { recursive: true, force: true });
  }
  assert.equal(children.size, 0);
});

test('stopAll stops a live run and removes its temp directory; a finished run is no longer live', HANG, async () => {
  const children = new Set<ChildProcess>();
  const out = mkdtempSync(join(tmpdir(), 'agnipariksha-test-'));
  try {
    const script = `require('node:fs').writeFileSync(process.env.OUT, process.env.TMPDIR); setTimeout(() => {}, 5000);`;
    const running = spawnStryker([node, '-e', script], children)('.', [], { OUT: join(out, 'tmp') });
    const tmp = await written(join(out, 'tmp'));
    assert.equal(children.size, 1, 'the live child is held');
    stopAll(children);
    assert.equal(existsSync(tmp), false, 'its temp directory is removed at once');
    const result = await running;
    assert.equal(result.code, 1, 'SIGTERM ended it, long before its five seconds');
    assert.equal(result.refusal, scratchVanished(tmp));
    assert.equal(children.size, 0, 'a closed child is let go');

    // Done, the run is no longer live: a directory at its old path is someone else's now.
    mkdirSync(tmp);
    stopAll(children);
    assert.equal(existsSync(tmp), true);
    rmSync(tmp, { recursive: true, force: true });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("realDeps runs the repository's own stryker, removes files that may be missing, and hooks the process's exit", HANG, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  const logged: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const listener = (): void => undefined;
  try {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'stryker'), '#!/bin/sh\necho "$*" > "$OUT"\n');
    chmodSync(join(dir, 'node_modules', '.bin', 'stryker'), 0o755);
    const deps = realDeps(dir, new Set(), config);
    assert.equal((await deps.runStryker(dir, ['run', 'x.mjs'], { OUT: join(dir, 'args') })).code, 0);
    assert.equal(readFileSync(join(dir, 'args'), 'utf8'), 'run x.mjs\n');

    assert.doesNotThrow(() => deps.removeFile(join(dir, 'missing')));
    const lock = join(dir, 'lock');
    writeFileSync(lock, '1');
    deps.lock.remove(lock);
    assert.equal(existsSync(lock), false);
    assert.doesNotThrow(() => deps.lock.remove(lock));

    const slept = deps.lock.sleep(1);
    assert.ok(slept instanceof Promise);
    await slept;

    deps.atExit(listener);
    assert.ok(process.listeners('exit').includes(listener));

    process.stderr.write = ((chunk: string) => (logged.push(chunk), write(chunk))) as typeof process.stderr.write;
    deps.lock.log('waiting');
    process.stderr.write = write;
    assert.deepEqual(logged, ['waiting\n']);
  } finally {
    process.stderr.write = write;
    process.off('exit', listener);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('realDeps reads, writes, removes and locks on the real filesystem', HANG, async () => {
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
    const refs = join(dir, 'refs');
    writeFileSync(refs, 'refs/heads/a 1 refs/heads/a 0\n');
    assert.equal(realDeps(dir, new Set(), config, refs).readStdin(), 'refs/heads/a 1 refs/heads/a 0\n');
    deps.atExit(() => undefined);
    deps.log('realDeps log check');
    deps.lock.log('realDeps lock log check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('entry runs the arguments after the script, sets the exit code, exits 2 on a signal, and stops the children on exit', async () => {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  const kills: string[] = [];
  const proc: EntryProcess = {
    argv: ['node', 'bin.js', '--files', 'a.ts'],
    on: (event, listener) => listeners.set(event, listener),
    exit: (code) => {
      exits.push(code);
    },
  };
  let ran: readonly string[] = [];
  await entry(proc, async (argv, children) => {
    ran = argv;
    children.add({ kill: (signal: string) => kills.push(signal) } as unknown as ChildProcess);
    return 3;
  });
  assert.deepEqual(ran, ['--files', 'a.ts']);
  assert.equal(proc.exitCode, 3);
  assert.deepEqual([...listeners.keys()], ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) listeners.get(signal)?.();
  assert.deepEqual(exits, [2, 2, 2]);
  listeners.get('exit')?.();
  assert.deepEqual(kills, ['SIGTERM']);
});

test('bootstrap refuses with exit 2 on a bad argument, and outside a repository', HANG, async () => {
  assert.equal(await bootstrap(['--nope'], new Set()), 2);
  const here = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  const printed: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  try {
    process.chdir(dir);
    process.stdout.write = ((chunk: string) => (printed.push(chunk), write(chunk))) as typeof process.stdout.write;
    assert.equal(await bootstrap([], new Set()), 2);
    process.stdout.write = write;
    assert.match(printed.join(''), /^agnipariksha REFUSED: Command failed: git rev-parse --show-toplevel\n/);
  } finally {
    process.stdout.write = write;
    process.chdir(here);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap reads agnipariksha.json at the root: missing or bad refuses with exit 2 before any work, valid runs', HANG, async () => {
  const here = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  const printed: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  // Captured and still written: a swallowed stdout would hide the test reporter's lines, a failure's
  // among them, and a runner that stops at the first failure would never see it.
  process.stdout.write = ((chunk: string) => (printed.push(chunk), write(chunk))) as typeof process.stdout.write;
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
