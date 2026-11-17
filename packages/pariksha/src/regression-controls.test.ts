// regression-controls: the engine over a map-backed reader, the index reader
// over temp git trees, and the subcommand end to end through `run`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from './cli.ts';
import { caseTitles, checkRegressionControls, disablingSyntax, formatControls, guardedPath, indexReader, parseBatch, parseRegistry, worktreeReader, type Reader } from './regression-controls.ts';
import { loadTypescript, type Ts } from './typescript.ts';

const loaded = loadTypescript();
if (typeof loaded === 'string') throw new Error(loaded);
const ts: Ts = loaded;

// indexReader and `--staged` spawn git with this process's environment, as
// they must in a hook (a partial commit's GIT_INDEX_FILE is the index to
// judge). Under test that environment is made hermetic, so an inherited
// GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE cannot point them elsewhere.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TRACE2: '0',
  GIT_TRACE2_EVENT: '0',
  GIT_TRACE2_PERF: '0',
};
const inherited = { ...process.env };
before(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in env)) Reflect.deleteProperty(process.env, name);
  }
  Object.assign(process.env, env);
});

/** Every folder a test made, removed once the file's tests are done. */
const made: string[] = [];
after(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in inherited)) Reflect.deleteProperty(process.env, name);
  }
  Object.assign(process.env, inherited);
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, env, stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' });
};
const folder = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-controls-')));
  made.push(root);
  return root;
};
const put = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
};
/** A git repository holding `files`, all of them staged. */
const repo = (files: Readonly<Record<string, string>>): string => {
  const root = folder();
  git(root, 'init', '-q');
  put(root, files);
  git(root, 'add', '-A');
  return root;
};

// ── the fixture: three controls, their tests and the files they guard ───────

const CONTROL = 'scripts/cleanup.test.ts';
const FIXED_TITLE = 'fixed: the same kind of path is refused and survives';
const CONTROL_SOURCE = [
  "import { describe, it } from 'vitest';",
  "describe('removeFixtureRoot', () => {",
  "  it('bad: the historical removal deletes state outside the temp directory', () => {});",
  `  it('${FIXED_TITLE}', () => {});`,
  "  it('near miss: an owned temp root is removed', () => {});",
  "  it('guard flip: without the ownership check the fixed case is deleted', () => {});",
  '});',
  '',
].join('\n');
const POOL = 'apps/api/src/pool.integration.test.ts';
const POOL_SOURCE = [
  "import { test } from 'vitest';",
  "test('bad: the sequential probe stays under the cap with the cap removed', () => {});",
  "test.each([[1], [8]])('fixed: %j sends hold no more connections than the cap', () => {});",
  "test('near miss: one send opens one connection', () => {});",
  "test('guard flip: the same burst drives a pool without the cap past it', () => {});",
  '',
].join('\n');
const SEARCH = 'apps/web/src/search.test.tsx';
const SEARCH_SOURCE = [
  "import { it } from 'vitest';",
  'it("bad: parity cannot see a fault both paths share", () => {});',
  'it(`fixed: the independent rows give the tier order`, () => {});',
  "it.each([1])('guard flip: the independent rows catch the shared fault', () => {});",
  '',
].join('\n');

const FILES: Readonly<Record<string, string>> = {
  [CONTROL]: CONTROL_SOURCE,
  'scripts/cleanup.ts': 'export const removeFixtureRoot = () => {};\n',
  [POOL]: POOL_SOURCE,
  'apps/api/src/pool.ts': 'export const POOL_MAX = 4;\n',
  [SEARCH]: SEARCH_SOURCE,
  'apps/web/src/search.ts': 'export const search = () => [];\n',
};

type Json = Record<string, unknown>;
interface RegistryJson {
  $comment?: string;
  gates?: Record<string, string[]> | null;
  requiredFindings?: string[] | null;
  controls: Json[];
}
const registryJson = (): RegistryJson => ({
  $comment: 'Each targeted regression control: the finding it answers, the guard it proves, and its four cases.',
  gates: {
    tooling: ['^scripts/.+\\.test\\.ts$'],
    'api test': ['^apps/api/src/(?!.+\\.integration\\.test\\.ts$).+\\.test\\.ts$'],
    'api integration': ['^apps/api/src/.+\\.integration\\.(test|spec)\\.ts$'],
    'web test': ['^apps/web/src/.+\\.test\\.tsx?$'],
  },
  requiredFindings: ['F-1', 'F-2', 'F-3'],
  controls: [
    {
      id: 'pool-cap',
      finding: 'F-1',
      family: 'concurrency',
      file: POOL,
      gate: 'api integration',
      guard: 'max: POOL_MAX in apps/api/src/pool.ts',
      cases: {
        bad: 'bad: the sequential probe stays under the cap with the cap removed',
        fixed: 'fixed: %j sends hold no more connections than the cap',
        nearMiss: 'near miss: one send opens one connection',
        guardFlip: 'guard flip: the same burst drives a pool without the cap past it',
      },
    },
    {
      id: 'search-oracle',
      finding: 'F-2',
      family: 'oracle',
      file: SEARCH,
      gate: 'web test',
      guard: 'tier order in apps/web/src/search.ts',
      // The fixed case is its own near miss: a title may serve two kinds.
      cases: {
        bad: 'bad: parity cannot see a fault both paths share',
        fixed: 'fixed: the independent rows give the tier order',
        nearMiss: 'fixed: the independent rows give the tier order',
        guardFlip: 'guard flip: the independent rows catch the shared fault',
      },
    },
    {
      id: 'fixture-root-ownership',
      finding: 'F-3',
      family: 'fixture',
      file: CONTROL,
      gate: 'tooling',
      guard: 'isOwnedFixturePath check in scripts/cleanup.ts',
      cases: {
        bad: 'bad: the historical removal deletes state outside the temp directory',
        fixed: FIXED_TITLE,
        nearMiss: 'near miss: an owned temp root is removed',
        guardFlip: 'guard flip: without the ownership check the fixed case is deleted',
      },
    },
  ],
});
const REGISTRY_TEXT = JSON.stringify(registryJson());

/** The control at `i`, to edit. */
const nth = (r: RegistryJson, i: number): Json => {
  const c = r.controls[i];
  if (c === undefined) throw new Error(`no control ${i}`);
  return c;
};

/** The fixture's files, each edit replacing one (null deletes it). */
const overlay = (edits: Readonly<Record<string, string | null>> = {}): Reader => (p) => (Object.hasOwn(edits, p) ? (edits[p] ?? null) : Object.hasOwn(FILES, p) ? (FILES[p] ?? null) : null);

/** The check over `read` and the fixture registry, as `edit` leaves it. */
const check = (read: Reader = overlay(), edit: (r: RegistryJson) => void = () => {}): string[] => {
  const r = registryJson();
  edit(r);
  return checkRegressionControls(ts, read, parseRegistry(JSON.stringify(r)));
};

const renamed = (): Reader => overlay({ [CONTROL]: CONTROL_SOURCE.replace(FIXED_TITLE, 'refuses a path') });
/** The fixed case deleted, its title left behind where no case reads it. */
const leftover = (where: string): Reader => overlay({ [CONTROL]: `${CONTROL_SOURCE.replace(FIXED_TITLE, 'refuses a path')}\n${where}` });
/** The fixture control's file with `code` appended. */
const appended = (code: string): Reader => overlay({ [CONTROL]: `${CONTROL_SOURCE}\n${code}` });
const LABEL = 'fixture-root-ownership (F-3)';
const MISSING_FIXED = `${LABEL}: fixed case "${FIXED_TITLE}" is not a case in ${CONTROL}`;
const uses = (text: string): string => `${LABEL}: ${CONTROL} uses ${text}`;

// ── the engine ───────────────────────────────────────────────────────────────

describe('checkRegressionControls', () => {
  it('near miss: the registry over its own tests is whole', () => {
    assert.deepEqual(check(), []);
  });

  it('bad: a renamed control case is reported, not silently ended', () => {
    assert.deepEqual(check(renamed()), [MISSING_FIXED]);
  });

  const reported: Array<[string, () => string[], string]> = [
    ['a deleted test file', () => check(overlay({ [CONTROL]: null })), `${LABEL}: ${CONTROL} is missing`],
    ['a conditionally skipped test', () => check(appended("it.skipIf(true)('x', () => {});")), uses('it.skipIf')],
    ['a conditionally run suite', () => check(appended("describe.runIf(false)('x', () => {});")), uses('describe.runIf')],
    ['a case skipped through an alias of it', () => check(appended("check.skip('x', () => {});")), uses('check.skip')],
    ['a table skipped after .each', () => check(appended("it.each([1]).skip('x %s', () => {});")), uses('.skip')],
    ['a skip table', () => check(appended("test.skip.each([1])('x %s', () => {});")), uses('test.skip')],
    ['a node:test case skipped by its options', () => check(appended("test('x', { skip: true }, () => {});")), uses('{ skip:')],
    ['a node:test case left as a todo', () => check(appended("test('x', {todo:'later'}, () => {});")), uses('{todo:')],
    ['an unknown gate', () => check(overlay(), (r) => void (nth(r, 0)['gate'] = 'nightly')), 'pool-cap (F-1): unknown gate "nightly"'],
    ['a gate named like an inherited member', () => check(overlay(), (r) => void (nth(r, 0)['gate'] = 'constructor')), 'pool-cap (F-1): unknown gate "constructor"'],
    ['a file the gate does not collect', () => check(overlay(), (r) => void (nth(r, 2)['gate'] = 'web test')), `${LABEL}: ${CONTROL} is not collected by web test`],
    ['an integration suite given the unit gate', () => check(overlay(), (r) => void (nth(r, 0)['gate'] = 'api test')), `pool-cap (F-1): ${POOL} is not collected by api test`],
    ['a missing guarded file', () => check(overlay(), (r) => void (nth(r, 2)['guard'] = 'isOwnedFixturePath check in scripts/gone.ts')), `${LABEL}: guarded file scripts/gone.ts is missing`],
    ['a guard without a path', () => check(overlay(), (r) => void (nth(r, 2)['guard'] = 'the ownership check')), `${LABEL}: guard must read "<what> in <path>"`],
    ['a guard whose path leaves the root', () => check(overlay(), (r) => void (nth(r, 2)['guard'] = 'the check in ../outside.ts')), `${LABEL}: guarded path ../outside.ts is not a normalized root-relative path`],
    ['a dropped finding', () => check(overlay(), (r) => void r.controls.splice(2, 1)), 'F-3: no control answers this finding'],
    ['a duplicate id', () => check(overlay(), (r) => void r.controls.push({ ...nth(r, 0) })), 'pool-cap: duplicate id'],
  ];
  for (const [name, problems, problem] of reported) {
    it(`fixed: reports ${name}`, () => {
      assert.deepEqual(problems(), [problem]);
    });
  }

  const notCases: Array<[string, string]> = [
    ['a line comment', `// it('${FIXED_TITLE}', () => {});`],
    ['a block comment', `/* test('${FIXED_TITLE}') */`],
    ['a string', `const note = '${FIXED_TITLE}';`],
    ['a describe title', `describe('${FIXED_TITLE}', () => {});`],
    ['a suite title', `suite('${FIXED_TITLE}', () => {});`],
    ['a table of suites', `describe.each([1])('${FIXED_TITLE}', () => {});`],
    ['another member of it', `it.extend({})('${FIXED_TITLE}', () => {});`],
    ['an each of another object', `rows.each([1])('${FIXED_TITLE}', () => {});`],
    ['an each that is not called', `it.each('${FIXED_TITLE}', () => {});`],
    ['a member of an each', `it.each.bind('${FIXED_TITLE}');`],
    ['a string called as a case', `'it'('${FIXED_TITLE}');`],
    ['the result of a case', `it('x', () => {})('${FIXED_TITLE}');`],
    ['a case with no title', `it(); const after = '${FIXED_TITLE}';`],
    ['a call with a computed title', `it(['${FIXED_TITLE}'].join(''), () => {});`],
  ];
  for (const [name, where] of notCases) {
    it(`fixed: a title left in ${name} is not a case`, () => {
      assert.deepEqual(check(leftover(where)), [MISSING_FIXED]);
    });
  }

  const stillCases: Array<[string, string]> = [
    ['test() with a template title', `test(\`${FIXED_TITLE}\`, () => {});`],
    ['it() with a double-quoted title', `it("${FIXED_TITLE}", () => {});`],
    ['a test.each table', `test.each([1])('${FIXED_TITLE}', () => {});`],
    ['an it.each table', `it.each([1])('${FIXED_TITLE}', () => {});`],
  ];
  for (const [name, where] of stillCases) {
    it(`near miss: a case written as ${name} still counts`, () => {
      assert.deepEqual(check(leftover(where)), []);
    });
  }

  it('guard flip: the raw text still holds a title left in a comment, so only the syntax tree tells it from a case', () => {
    const source = `${CONTROL_SOURCE.replace(FIXED_TITLE, 'refuses a path')}\n// it('${FIXED_TITLE}', () => {});`;
    assert.ok(source.includes(FIXED_TITLE));
    assert.ok(!caseTitles(ts, CONTROL, source).has(FIXED_TITLE));
    assert.deepEqual(check(overlay({ [CONTROL]: source })), [MISSING_FIXED]);
  });

  it('guard flip: the renamed case is the only problem, so the title check alone refuses it', () => {
    assert.ok(caseTitles(ts, CONTROL, CONTROL_SOURCE).has(FIXED_TITLE));
    assert.ok(!caseTitles(ts, CONTROL, CONTROL_SOURCE.replace(FIXED_TITLE, 'refuses a path')).has(FIXED_TITLE));
    assert.deepEqual(check(renamed()), [MISSING_FIXED]);
  });

  it('near miss: a property that disables nothing is not a skip', () => {
    assert.deepEqual(check(appended('const flags = { a: 1 };\nexpect(flags.only).toBeUndefined();\nflags.skip = flags.todo;')), []);
  });

  const unseen: Array<[string, string, string]> = [
    ['a suite skipped by computed access', "describe['skip']('x', () => {});", "describe['skip']"],
    ['a modifier of it taken as an alias', 'const s = it.skip;', 'it.skip'],
    ['a modifier of a parenthesized it', 'const s = (it).only;', '(it).only'],
    ['a computed modifier after .each', "const s = it.each([1])['skipIf'];", "it.each([1])['skipIf']"],
    ['a computed modifier after a computed member', "const s = it['each']['only'];", "it['each']['only']"],
    ['a computed modifier of it that is not called', "const s = it['skip'];", "it['skip']"],
    ['a suite modifier taken as an alias', 'const r = suite.runIf;', 'suite.runIf'],
    ['a suite reached by a computed mode', "const mode = 'skip';\ndescribe[mode]('x', () => {});", 'describe[mode]'],
    ['a modifier destructured from it', 'const { each, skip } = it;', '{ each, skip }'],
    ['a renamed modifier destructured from test', 'const { each, only: focused } = test;', '{ each, only: focused }'],
    ['a modifier destructured in a parameter default', 'function pick({ skip } = it) {\n  return skip;\n}', '{ skip }'],
    ['an alias called through a computed modifier', "check['skip']('x', () => {});", "check['skip']"],
    ['an alias table through a computed todo', 'check["todo"].each([1]);', 'check["todo"]'],
    ['an alias reached through a computed only', "check['only']['each'];", "check['only']"],
    ['node:test options that skip after another option', "test('x', { timeout: 1, skip: true }, () => {});", "test('x', { timeout: 1, skip: true }, () => {})"],
    ['node:test options that leave a todo after another option', "test('x', { timeout: 1, todo: 'later' }, () => {});", "test('x', { timeout: 1, todo: 'later' }, () => {})"],
    ['node:test options with a shorthand skip', "const skip = true;\ntest('x', { skip }, () => {});", "test('x', { skip }, () => {})"],
    ['node:test options with a quoted only', "test('x', { 'only': true }, () => {});", "test('x', { 'only': true }, () => {})"],
    ['the first of two', 'const a = it.skip;\nconst b = test.only;', 'it.skip'],
  ];
  for (const [name, code, text] of unseen) {
    it(`fixed: reports ${name}, which the text scan cannot see`, () => {
      assert.deepEqual(check(appended(code)), [uses(text)]);
    });
  }

  const harmless: Array<[string, string]> = [
    ['a computed key on another object', "const flags: Record<string, number> = {};\nflags['skip'] = 1;\nexpect(flags['only']).toBeUndefined();"],
    ['a computed index on another object', 'const rows = [[1]];\nconst at = 0;\nexpect(rows[at]).toEqual([1]);'],
    ['a member of it that is not a modifier', "const each = it['each'];"],
    ['a parenthesized other object', 'const flags = { a: 1, skip: 1 };\nconst s = (flags).skip;'],
    ['a string that reads as it', "const s = 'it'.skip;"],
    ['a destructuring from another object', 'const flags = { a: 1, skip: 2 };\nconst { skip } = flags;'],
    ['a destructuring with no initializer', 'const rows = [{ a: 1, skip: 1 }];\nfor (const { skip } of rows) expect(skip).toBe(1);'],
    ['a destructured member of it that is not a modifier', 'const { each } = it;'],
    ['options on another call', "const call = vi.fn();\ncall('x', { a: 1, skip: true });"],
    ['case options that set no modifier', "it('x', { timeout: 1, ...{}, [String('k')]: 1 }, () => {});"],
    ['a case with a string second argument', "it('x', 'skip');"],
  ];
  for (const [name, code] of harmless) {
    it(`near miss: ${name} disables nothing`, () => {
      assert.deepEqual(check(appended(code)), []);
    });
  }

  it('reads disabling syntax alone, null when there is none', () => {
    assert.equal(disablingSyntax(ts, CONTROL, CONTROL_SOURCE), null);
    assert.equal(disablingSyntax(ts, CONTROL, 'const s = it.skip;'), 'it.skip');
  });

  it('checks no gate when gates is null, and no finding when requiredFindings is', () => {
    const edit = (r: RegistryJson): void => {
      r.gates = null;
      r.requiredFindings = null;
      nth(r, 0)['gate'] = 'nightly';
      r.controls.splice(2, 1);
    };
    assert.deepEqual(check(overlay(), edit), []);
  });

  it('reads the guarded path from a guard ending "in <path>"', () => {
    assert.equal(guardedPath('max: POOL_MAX in apps/api/src/pool.ts'), 'apps/api/src/pool.ts');
    assert.equal(guardedPath('the ownership check'), null);
    assert.equal(guardedPath('in apps/x.ts'), null);
  });
});

describe('prefetch', () => {
  const recording = (base: Reader): { read: Reader; asked: string[][] } => {
    const asked: string[][] = [];
    const read: Reader = Object.assign((p: string) => base(p), {
      prefetch: (paths: readonly string[]) => {
        asked.push([...paths]);
      },
    });
    return { read, asked };
  };

  it("loads every control's file and guarded file in one call", () => {
    const { read, asked } = recording(overlay());
    check(read);
    assert.deepEqual(asked, [[POOL, 'apps/api/src/pool.ts', SEARCH, 'apps/web/src/search.ts', CONTROL, 'scripts/cleanup.ts']]);
  });

  it('falls back to the test file when a guard names no path', () => {
    const { read, asked } = recording(overlay());
    check(read, (r) => {
      r.controls = [{ ...nth(r, 2), guard: 'the ownership check' }];
      r.requiredFindings = null;
    });
    assert.deepEqual(asked, [[CONTROL, CONTROL]]);
  });
});

// ── the registry ─────────────────────────────────────────────────────────────

describe('parseRegistry', () => {
  it('reads the gates, the required findings and every control', () => {
    const registry = parseRegistry(REGISTRY_TEXT);
    assert.deepEqual(Object.keys(registry.gates ?? {}), ['tooling', 'api test', 'api integration', 'web test']);
    assert.deepEqual(registry.requiredFindings, ['F-1', 'F-2', 'F-3']);
    assert.deepEqual(
      registry.controls.map((c) => c.id),
      ['pool-cap', 'search-oracle', 'fixture-root-ownership'],
    );
    assert.equal(registry.controls[2]?.cases.fixed, FIXED_TITLE);
    assert.deepEqual(registry.skipped, []);
  });

  it('records what a registry opting gates and required findings out with null leaves unchecked', () => {
    const r = registryJson();
    r.gates = null;
    r.requiredFindings = null;
    const registry = parseRegistry(JSON.stringify(r));
    assert.equal(registry.gates, undefined);
    assert.equal(registry.requiredFindings, undefined);
    assert.deepEqual(registry.skipped, ['gates', 'requiredFindings']);
  });

  const refused: Array<[string, (r: RegistryJson) => unknown, RegExp]> = [
    ['an unknown top-level key', (r) => ({ ...r, control: [] }), /^unknown key "control"$/],
    ['a registry without gates', (r) => ({ ...r, gates: undefined }), /^"gates" is required \(null opts its check out\)$/],
    ['a registry without required findings', (r) => ({ ...r, requiredFindings: undefined }), /^"requiredFindings" is required \(null opts its check out\)$/],
    ['a registry without controls', (r) => ({ ...r, controls: undefined }), /^"controls" must be a list$/],
    ['an empty controls list', (r) => ({ ...r, controls: [] }), /^"controls" is empty, so nothing would be checked$/],
    ['a control that is not an object', (r) => ({ ...r, controls: [...r.controls, 'x'] }), /^controls\[3\] must be an object$/],
    ['a control with an unknown key', (r) => ({ ...r, controls: [{ ...nth(r, 0), owner: 'x' }] }), /^controls\[0\]: unknown key "owner"$/],
    ['a control without a file', (r) => ({ ...r, controls: [{ ...nth(r, 0), file: '' }] }), /^controls\[0\]: "file" must be a non-empty string$/],
    ['a file that leaves the root', (r) => ({ ...r, controls: [{ ...nth(r, 0), file: '../x.test.ts' }] }), /^controls\[0\]: "file": "\.\.\/x\.test\.ts" is not a normalized root-relative path$/],
    ['a control without an id', (r) => ({ ...r, controls: [{ ...nth(r, 0), id: 7 }] }), /^controls\[0\]: "id" must be a non-empty string$/],
    ['a control without cases', (r) => ({ ...r, controls: [{ ...nth(r, 0), cases: undefined }] }), /^controls\[0\]: "cases" must be an object$/],
    ['a control without a guard-flip case', (r) => ({ ...r, controls: [{ ...nth(r, 0), cases: { bad: 'a', fixed: 'b', nearMiss: 'c' } }] }), /^controls\[0\]\.cases: "guardFlip" must be a non-empty string$/],
    ['a case kind it does not know', (r) => ({ ...r, controls: [{ ...nth(r, 0), cases: { bad: 'a', fixed: 'b', nearMiss: 'c', guardFlip: 'd', extra: 'e' } }] }), /^controls\[0\]\.cases: unknown key "extra"$/],
    ['gates that are not an object', (r) => ({ ...r, gates: ['x'] }), /^"gates" must be an object$/],
    ['a gate with no pattern', (r) => ({ ...r, gates: { tooling: [] } }), /^gates: "tooling" is empty, so nothing would match$/],
    ['a gate whose pattern is not a regular expression', (r) => ({ ...r, gates: { tooling: ['('] } }), /^gates: tooling\[0\]: "\(" is not a regular expression/],
    ['required findings that are not a list', (r) => ({ ...r, requiredFindings: 'F-1' }), /^"requiredFindings" must be a list$/],
    ['a required finding that is not a string', (r) => ({ ...r, requiredFindings: ['F-1', ' '] }), /^requiredFindings\[1\] must be a non-empty string$/],
  ];
  for (const [name, edit, message] of refused) {
    it(`refuses ${name}`, () => {
      assert.throws(() => parseRegistry(JSON.stringify(edit(registryJson()))), { message });
    });
  }

  it('refuses a registry that is not JSON, or not an object', () => {
    assert.throws(() => parseRegistry('{'), { message: /^not JSON: / });
    assert.throws(() => parseRegistry('[]'), { message: /^the config must be a JSON object$/ });
  });
});

describe('formatControls', () => {
  it('says how many controls are whole and findings answered, and what it did not check', () => {
    const registry = parseRegistry(REGISTRY_TEXT);
    assert.deepEqual(formatControls([], registry, 'r.json', false), { ok: true, out: ['pariksha regression-controls: 3 control(s) whole, 3 required finding(s) answered'], err: [] });
    assert.deepEqual(formatControls([], registry, 'r.json', true).out, ['pariksha regression-controls: 3 control(s) whole (staged), 3 required finding(s) answered']);
    const r = registryJson();
    r.gates = null;
    r.requiredFindings = null;
    assert.deepEqual(formatControls([], parseRegistry(JSON.stringify(r)), 'r.json', false).out, ['pariksha regression-controls: 3 control(s) whole', 'pariksha regression-controls: not checked: gates, requiredFindings']);
  });

  it('names each problem, then the way back', () => {
    assert.deepEqual(formatControls([MISSING_FIXED], parseRegistry(REGISTRY_TEXT), 'r.json', false), {
      ok: false,
      out: [],
      err: [`pariksha regression-controls: ${MISSING_FIXED}`, "pariksha regression-controls: 1 problem(s). Each control's bad, fixed, near-miss and guard-flip tests prove its fix still bites; keep the titles in r.json in step with the tests."],
    });
  });
});

// ── the readers ──────────────────────────────────────────────────────────────

describe('parseBatch', () => {
  it('keeps a blob, and steps past a missing path and another kind of object', () => {
    const out = Buffer.from(':gone missing\nabc123 tree 3\nxyz\nabc124 blob 6\nsecond\n');
    assert.deepEqual([...parseBatch(out, ['gone', 'dir', 'b.txt'])], [
      ['gone', null],
      ['dir', null],
      ['b.txt', 'second'],
    ]);
  });

  it('reads sizes in bytes, so a multibyte body keeps the stream aligned', () => {
    const body = 'é\n';
    const out = Buffer.from(`abc blob ${Buffer.byteLength(body)}\n${body}\nabd blob 1\nx\n`);
    assert.deepEqual([...parseBatch(out, ['a', 'b'])], [
      ['a', body],
      ['b', 'x'],
    ]);
  });

  it('stops at a size past 2^53 or at output that ends early, leaving the rest absent', () => {
    assert.deepEqual([...parseBatch(Buffer.from('abc blob 99999999999999999999\nbody\n'), ['a', 'b'])], [
      ['a', null],
      ['b', null],
    ]);
    assert.deepEqual([...parseBatch(Buffer.alloc(0), ['a'])], [['a', null]]);
  });
});

describe('indexReader', () => {
  it('staged invalid, worktree valid: the index reader judges what the commit records', () => {
    const root = repo({ [CONTROL]: CONTROL_SOURCE.replace(FIXED_TITLE, 'renamed') });
    writeFileSync(join(root, CONTROL), CONTROL_SOURCE);
    assert.ok(worktreeReader(root)(CONTROL)?.includes(FIXED_TITLE));
    assert.ok(!indexReader(root, env)(CONTROL)?.includes(FIXED_TITLE));
    assert.equal(indexReader(root, env)('regression-controls.json'), null);
  });

  it('reads many paths in one batch, a missing path, a folder and a newline keeping the stream aligned', () => {
    const root = repo({ [CONTROL]: CONTROL_SOURCE, 'b.txt': 'second\n' });
    const read = indexReader(root, env);
    read.prefetch?.([CONTROL, 'gone.txt', 'scripts', 'b.txt', 'a\nb']);
    read.prefetch?.([CONTROL]);
    assert.equal(read('gone.txt'), null);
    assert.equal(read('scripts'), null);
    assert.equal(read('a\nb'), null);
    assert.equal(read('b.txt'), 'second\n');
    assert.equal(read(CONTROL), CONTROL_SOURCE);
  });

  it('reads paths relative to a root below the top level', () => {
    const top = repo({ [`sub/${CONTROL}`]: CONTROL_SOURCE, [CONTROL]: 'the top level copy\n' });
    assert.equal(indexReader(join(top, 'sub'), env)(CONTROL), CONTROL_SOURCE);
  });

  it('refuses a root in no git repository', () => {
    const root = folder();
    assert.throws(() => indexReader(root, env), /is not in a git repository, so --staged has no index to read$/);
  });

  it('reads the working tree, a folder or a missing path absent', () => {
    const root = folder();
    put(root, { [CONTROL]: CONTROL_SOURCE });
    const read = worktreeReader(root);
    assert.equal(read(CONTROL), CONTROL_SOURCE);
    assert.equal(read('scripts'), null);
    assert.equal(read('gone.ts'), null);
  });
});

// ── the subcommand ───────────────────────────────────────────────────────────

const REGISTRY = 'regression-controls.json';
const capture = (cwd: string) => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: () => cwd }, out, err };
};
const WHOLE = 'pariksha regression-controls: 3 control(s) whole, 3 required finding(s) answered';
const HINT = (shown: string): string => `pariksha regression-controls: 1 problem(s). Each control's bad, fixed, near-miss and guard-flip tests prove its fix still bites; keep the titles in ${shown} in step with the tests.`;

describe('pariksha regression-controls', () => {
  it('reports the working tree whole', () => {
    const root = repo({ ...FILES, [REGISTRY]: REGISTRY_TEXT });
    const c = capture(root);
    assert.equal(run(['regression-controls', '--config', REGISTRY, '--root', root], c.io, '1.0.0', {}), 0);
    assert.deepEqual(c.err, []);
    assert.deepEqual(c.out, [WHOLE]);
  });

  it('fails a renamed case, naming it and the way back', () => {
    const root = repo({ ...FILES, [REGISTRY]: REGISTRY_TEXT });
    writeFileSync(join(root, CONTROL), CONTROL_SOURCE.replace(FIXED_TITLE, 'refuses a path'));
    const c = capture(root);
    assert.equal(run(['regression-controls', '--config', REGISTRY, '--root', root], c.io, '1.0.0', {}), 1);
    assert.deepEqual(c.out, []);
    assert.deepEqual(c.err, [`pariksha regression-controls: ${MISSING_FIXED}`, HINT(REGISTRY)]);
  });

  it('reads the index with --staged, registry included, and says so', () => {
    const root = repo({ ...FILES, [REGISTRY]: REGISTRY_TEXT });
    // The working tree loses a test file and its registry names a case no
    // file has; the index still records both whole.
    writeFileSync(join(root, CONTROL), '');
    const r = registryJson();
    nth(r, 1)['cases'] = { bad: 'a', fixed: 'b', nearMiss: 'c', guardFlip: 'd' };
    writeFileSync(join(root, REGISTRY), JSON.stringify(r));
    const staged = capture(root);
    assert.equal(run(['regression-controls', '--config', REGISTRY, '--staged', '--root', root], staged.io, '1.0.0', {}), 0);
    assert.deepEqual(staged.err, []);
    assert.deepEqual(staged.out, ['pariksha regression-controls: 3 control(s) whole (staged), 3 required finding(s) answered']);
    const tree = capture(root);
    assert.equal(run(['regression-controls', '--config', REGISTRY, '--root', root], tree.io, '1.0.0', {}), 1);
    // Four titles of each edited control, then the way back.
    assert.equal(tree.err.length, 9);
    assert.equal(tree.err[0], 'pariksha regression-controls: search-oracle (F-2): bad case "a" is not a case in apps/web/src/search.test.tsx');
  });

  it('with --staged, reads a registry the index does not hold, or one outside the root, from the disk', () => {
    const root = repo(FILES);
    put(root, { [REGISTRY]: REGISTRY_TEXT });
    const untracked = capture(root);
    assert.equal(run(['regression-controls', '--config', REGISTRY, '--staged', '--root', root], untracked.io, '1.0.0', {}), 0);
    const elsewhere = folder();
    put(elsewhere, { [REGISTRY]: REGISTRY_TEXT });
    const outside = capture(root);
    assert.equal(run(['regression-controls', '--config', join(elsewhere, REGISTRY), '--staged', '--root', root], outside.io, '1.0.0', {}), 0);
    assert.deepEqual(outside.out, ['pariksha regression-controls: 3 control(s) whole (staged), 3 required finding(s) answered']);
  });

  it('runs on the entry .pariksha.json gives it, a file or inline', () => {
    const fileEntry = repo({ ...FILES, [`config/${REGISTRY}`]: REGISTRY_TEXT, '.pariksha.json': JSON.stringify({ checks: { 'regression-controls': `config/${REGISTRY}` } }) });
    const c = capture(fileEntry);
    assert.equal(run(['regression-controls', '--root', fileEntry, '--staged'], c.io, '1.0.0', {}), 0);
    assert.deepEqual(c.out, ['pariksha regression-controls: 3 control(s) whole (staged), 3 required finding(s) answered']);
    const inline = repo({ ...FILES, [CONTROL]: CONTROL_SOURCE.replace(FIXED_TITLE, 'refuses a path'), '.pariksha.json': JSON.stringify({ checks: { 'regression-controls': registryJson() } }) });
    const d = capture(inline);
    assert.equal(run(['regression-controls', '--root', inline, '--staged'], d.io, '1.0.0', {}), 1);
    assert.deepEqual(d.err, [`pariksha regression-controls: ${MISSING_FIXED}`, HINT('.pariksha.json (checks.regression-controls)')]);
  });

  it('says what a registry opting gates and required findings out did not check', () => {
    const r = registryJson();
    r.gates = null;
    r.requiredFindings = null;
    const root = repo({ ...FILES, [REGISTRY]: JSON.stringify(r) });
    const c = capture(root);
    assert.equal(run(['regression-controls', '--config', REGISTRY, '--root', root], c.io, '1.0.0', {}), 0);
    assert.deepEqual(c.out, ['pariksha regression-controls: 3 control(s) whole', 'pariksha regression-controls: not checked: gates, requiredFindings']);
  });

  const unchecked: Array<[string, (root: string) => readonly string[], RegExp]> = [
    ['a registry that is not JSON', (root) => (put(root, { [REGISTRY]: '{' }), ['--config', REGISTRY]), /^pariksha regression-controls: regression-controls\.json: not JSON: .*; nothing was checked, so this is not a pass$/],
    ['a malformed control', (root) => (put(root, { [REGISTRY]: JSON.stringify({ gates: null, requiredFindings: null, controls: [{}] }) }), ['--config', REGISTRY]), /^pariksha regression-controls: regression-controls\.json: controls\[0\]: "id" must be a non-empty string; nothing was checked/],
    [
      'a registry that forgets requiredFindings',
      (root) => (put(root, { [REGISTRY]: JSON.stringify({ ...registryJson(), requiredFindings: undefined }) }), ['--config', REGISTRY]),
      /^pariksha regression-controls: regression-controls\.json: "requiredFindings" is required \(null opts its check out\); nothing was checked, so this is not a pass$/,
    ],
    ['a missing registry', () => ['--config', 'gone.json'], /^pariksha regression-controls: ENOENT: .*gone\.json.*; nothing was checked, so this is not a pass$/],
  ];
  for (const [name, args, message] of unchecked) {
    it(`exits 2 on ${name}`, () => {
      const root = repo(FILES);
      const c = capture(root);
      assert.equal(run(['regression-controls', ...args(root), '--root', root], c.io, '1.0.0', {}), 2);
      assert.equal(c.err.length, 1);
      assert.match(c.err[0] ?? '', message);
    });
  }

  it('exits 2 on --staged outside a git repository', () => {
    const root = folder();
    put(root, { ...FILES, [REGISTRY]: REGISTRY_TEXT });
    const c = capture(root);
    assert.equal(run(['regression-controls', '--config', REGISTRY, '--staged', '--root', root], c.io, '1.0.0', {}), 2);
    assert.match(c.err[0] ?? '', /is not in a git repository, so --staged has no index to read; nothing was checked, so this is not a pass$/);
    // The working tree needs no git.
    const tree = capture(root);
    assert.equal(run(['regression-controls', '--config', REGISTRY, '--root', root], tree.io, '1.0.0', {}), 0);
  });

  it('exits 2 without typescript', () => {
    const root = repo({ ...FILES, [REGISTRY]: REGISTRY_TEXT });
    const c = capture(root);
    assert.equal(run(['regression-controls', '--config', REGISTRY, '--root', root], { ...c.io, typescript: () => 'needs the typescript package' }, '1.0.0', {}), 2);
    assert.deepEqual(c.err, ['pariksha regression-controls: needs the typescript package']);
  });

  const usage: Array<[string, readonly string[]]> = [
    ['no registry', []],
    ['an unknown flag', ['--config', REGISTRY, '--stagged']],
    ['a stray argument', ['--config', REGISTRY, 'stray']],
    ['--staged given twice', ['--config', REGISTRY, '--staged', '--staged']],
  ];
  for (const [name, args] of usage) {
    it(`refuses ${name} with usage exit 2`, () => {
      const root = repo({ ...FILES, [REGISTRY]: REGISTRY_TEXT });
      const c = capture(root);
      assert.equal(run(['regression-controls', ...args, '--root', root], c.io, '1.0.0', {}), 2);
      assert.match(c.err[0] ?? '', /^usage: /);
      assert.deepEqual(c.out, []);
    });
  }
});
