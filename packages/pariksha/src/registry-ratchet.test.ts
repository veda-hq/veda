import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileAt, gitAt, mergeBaseOf, parseRenames, renamesSince, trackedUnder } from './git.ts';
import {
  audit,
  checkExamples,
  checkFindingIds,
  emptyRoots,
  formatOutcome,
  grownEntries,
  growthSince,
  importSpecifiers,
  importsModule,
  importsPackage,
  isCollected,
  minNoteLength,
  namesModule,
  note,
  object,
  onlyKeys,
  optionalText,
  parseBaseline,
  parseExamples,
  parseFindingIds,
  parseJson,
  required,
  path,
  paths,
  readBaseline,
  readText,
  reason,
  records,
  regex,
  regexes,
  text,
  type Examples,
} from './registry-ratchet.ts';
import { loadTypescript, type Ts } from './typescript.ts';

const loaded = loadTypescript();
if (typeof loaded === 'string') throw new Error(loaded);
const ts: Ts = loaded;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
const put = (root: string, files: Record<string, string>): void => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
};
/** An Examples value with plain objects, for a strict deep comparison. */
const plainExamples = (e: Examples | undefined) => (e === undefined ? undefined : { catalogue: e.catalogue, fixtures: { ...e.fixtures } });
const LONG = `${'x'.repeat(80)}.json`;

describe('config helpers', () => {
  it('reads strings, paths, lists and regexes, naming the key a bad value breaks', () => {
    assert.equal(text({ a: 'x' }, 'a', ''), 'x');
    assert.throws(() => text({ a: ' ' }, 'a', 'w: '), /^Error: w: "a" must be a non-empty string$/);
    assert.equal(optionalText({}, 'a', ''), undefined);
    assert.throws(() => optionalText({ a: '' }, 'a', ''), /"a" must be a non-empty string/);
    assert.equal(path({ a: 'x/y.ts' }, 'a', ''), 'x/y.ts');
    for (const bad of ['/abs', '../up', 'a/./b', 'a/', '.']) assert.throws(() => path({ a: bad }, 'a', ''), /is not a normalized root-relative path/);
    // A backslash is a separator to Windows path operations, so `..\x` or `a\..\..\x` could leave the root; a NUL truncates.
    for (const bad of ['..\\up', 'a\\..\\..\\up', 'a\\b.ts', 'C:\\x', 'a\0b']) assert.throws(() => path({ a: bad }, 'a', ''), /is not a normalized root-relative path/);
    assert.equal(path({ a: 'a#b.ts' }, 'a', ''), 'a#b.ts');
    assert.deepEqual(paths({ a: ['x', 'y/z.ts'] }, 'a', ''), ['x', 'y/z.ts']);
    assert.throws(() => paths({}, 'a', ''), /"a" is empty, so nothing would be read/);
    assert.throws(() => paths({ a: [1] }, 'a', ''), /a\[0\]: 1 is not a normalized root-relative path/);
    assert.throws(() => paths({ a: 'x' }, 'a', ''), /"a" must be a list/);
    assert.equal(regex('^a$', 'k', 'i').flags, 'i');
    assert.throws(() => regex('(', 'k'), /k: "\(" is not a regular expression/);
    assert.throws(() => regex('', 'k'), /k must be a non-empty regular expression/);
    assert.equal(regexes({ a: ['x'] }, 'a', '').length, 1);
    assert.throws(() => regexes({ a: [] }, 'a', ''), /"a" is empty, so nothing would match/);
    assert.deepEqual(object({ a: { b: 1 } }, 'a', ''), { b: 1 });
    assert.throws(() => object({ a: [] }, 'a', ''), /"a" must be an object/);
    assert.throws(() => onlyKeys({ a: 1, b: 2 }, ['a'], 'w: '), /^Error: w: unknown key "b"$/);
    assert.throws(() => records([1], 'list'), /list\[0\] must be an object/);
    assert.deepEqual(records([{}], 'list'), [{ raw: {}, where: 'list[0]: ' }]);
  });

  it('needs a reason for an exemption, of at least minNoteLength characters trimmed', () => {
    assert.equal(reason({ reason: 'reads only' }, ''), 'reads only');
    assert.throws(() => reason({ reason: '  ' }, 'exempt[0]: '), /exempt\[0\]: an exemption needs a reason/);
    assert.throws(() => reason({}, ''), /an exemption needs a reason/);
    // A rule of more than 20 characters, so 21.
    assert.equal(reason({ reason: `  ${'x'.repeat(21)}  ` }, '', 21).trim().length, 21);
    assert.throws(() => reason({ reason: `  ${'x'.repeat(20)}  ` }, 'exempt[0]: ', 21), /exempt\[0\]: "reason" is shorter than minNoteLength \(21\): say why in words/);
  });

  it('holds a note to minNoteLength when present, and to presence when required', () => {
    assert.equal(note({}, 'uncovered', '', 21, false), undefined);
    assert.equal(note({ uncovered: 'x'.repeat(21) }, 'uncovered', '', 21, false), 'x'.repeat(21));
    assert.throws(() => note({ uncovered: 'x'.repeat(20) }, 'uncovered', 'consumers[0]: ', 21, false), /consumers\[0\]: "uncovered" is shorter than minNoteLength \(21\)/);
    assert.throws(() => note({}, 'outOfModel', 'w: ', 1, true), /w: "outOfModel" must be a non-empty string/);
  });

  it('needs minNoteLength as a whole number of at least 1', () => {
    assert.equal(minNoteLength({ minNoteLength: 21 }), 21);
    for (const bad of [undefined, 0, 1.5, '21']) assert.throws(() => minNoteLength({ minNoteLength: bad }), /"minNoteLength" must be a whole number of at least 1/);
  });

  it('requires a key whose absence would drop a check, null recording the opt-out', () => {
    const skipped: string[] = [];
    assert.throws(() => required({}, 'surfaces', '', skipped, () => 1), /^Error: "surfaces" is required \(null opts its check out\)$/);
    assert.equal(required({ surfaces: null }, 'surfaces', '', skipped, () => 1), undefined);
    assert.equal(required({ catalogue: null }, 'catalogue', 'examples: ', skipped, () => 1), undefined);
    assert.equal(required({ surfaces: ['a'] }, 'surfaces', '', skipped, () => 7), 7);
    assert.deepEqual(skipped, ['surfaces', 'examples.catalogue']);
  });

  it('reads the finding-id patterns, each required, each or all opted out by null', () => {
    const skipped: string[] = [];
    const ids = parseFindingIds({ findingIds: { motivatedBy: '^M\\d{10}$', example: null } }, skipped);
    assert.equal(ids.motivatedBy?.source, '^M\\d{10}$');
    assert.equal(ids.example, undefined);
    assert.deepEqual(skipped, ['findingIds.example']);
    const none: string[] = [];
    assert.deepEqual(parseFindingIds({ findingIds: null }, none), { motivatedBy: undefined, example: undefined });
    assert.deepEqual(none, ['findingIds']);
    assert.throws(() => parseFindingIds({}, []), /"findingIds" is required/);
    assert.throws(() => parseFindingIds({ findingIds: { motivatedBy: null } }, []), /findingIds: "example" is required/);
    assert.throws(() => parseFindingIds({ findingIds: { motivatedBy: null, example: null, other: 1 } }, []), /findingIds: unknown key "other"/);
    assert.throws(() => parseFindingIds({ findingIds: { motivatedBy: '(', example: null } }, []), /findingIds\.motivatedBy: "\(" is not a regular expression/);
  });

  it('reads a JSON object, refusing anything else', () => {
    assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
    assert.throws(() => parseJson('{'), /^Error: not JSON: /);
    assert.throws(() => parseJson('[]'), /the config must be a JSON object/);
  });

  it('holds finding ids to the pattern when one is given', () => {
    checkFindingIds(undefined, [['x', 'anything']]);
    checkFindingIds(/^M\d+$/, [['x', 'M1'], ['y', undefined]]);
    assert.throws(() => checkFindingIds(/^M\d+$/, [['consumers a: motivatedBy', 'Q1']]), /consumers a: motivatedBy: "Q1" is not a finding id \(\^M\\d\+\$\)/);
  });
});

describe('the baseline', () => {
  it('reads a well-formed baseline and names the list a malformed one breaks', () => {
    assert.deepEqual({ ...parseBaseline('{"cli": ["a.ts"], "server": ["s.ts"]}', ['cli', 'server'], 'b.json', 'paths') }, { cli: ['a.ts'], server: ['s.ts'] });
    assert.throws(() => parseBaseline('{"cli": "x", "server": []}', ['cli', 'server'], 'b.json', 'paths'), /^Error: b\.json: "cli" must be a list of paths$/);
    assert.throws(() => parseBaseline('{"cli": [], "server": [1]}', ['cli', 'server'], 'b.json', 'paths'), /"server" must be a list of paths/);
    assert.throws(() => parseBaseline('{"cli": []}', ['cli', 'server'], 'b.json', 'paths'), /"server" must be a list of paths/);
    assert.throws(() => parseBaseline('[]', ['cli', 'server'], 'b.json', 'paths'), /^Error: b\.json: must be an object with "cli" and "server" lists$/);
    assert.throws(() => parseBaseline('{"cli": [], "server": [], "extra": []}', ['cli', 'server'], 'b.json', 'paths'), /b\.json: unknown list "extra"/);
    assert.throws(() => parseBaseline('nope', ['cli'], 'b.json', 'paths'), /^Error: b\.json: not JSON: /);
  });

  it('reads the merge base’s baseline against today’s lists: one added since is empty, one removed since is ignored', () => {
    // A group added since the merge base: the base has no list for it.
    assert.deepEqual({ ...parseBaseline('{"cli": ["a.ts"]}', ['cli', 'server'], 'b.json', 'paths', true) }, { cli: ['a.ts'], server: [] });
    // A group removed since: its list at the base is not read.
    assert.deepEqual({ ...parseBaseline('{"cli": ["a.ts"], "server": ["s.ts"]}', ['cli'], 'b.json', 'paths', true) }, { cli: ['a.ts'] });
    // A list it does hold must still be well formed.
    assert.throws(() => parseBaseline('{"cli": "x"}', ['cli'], 'b.json', 'paths', true), /"cli" must be a list of paths/);
    assert.throws(() => parseBaseline('[]', ['cli'], 'b.json', 'paths', true), /must be an object/);
  });

  it('audits what must be baselined against what is', () => {
    assert.deepEqual(audit({ a: ['x', 'y'], b: ['z'] }, { a: ['y', 'gone'], b: [] }), { unaccounted: ['x', 'z'], stale: ['gone'] });
    assert.deepEqual(audit({ a: ['x'] }, { a: ['x'] }), { unaccounted: [], stale: [] });
  });

  it('audits list by list: an id in the wrong list is unaccounted in its own and stale in the other', () => {
    assert.deepEqual(audit({ cli: ['a.ts'], server: [] }, { cli: [], server: ['a.ts'] }), { unaccounted: ['a.ts'], stale: ['a.ts'] });
    // A list one side lacks reads as empty.
    assert.deepEqual(audit({ cli: ['a.ts'] }, { cli: ['a.ts'], tools: ['t.ts'] }), { unaccounted: [], stale: ['t.ts'] });
    assert.deepEqual(audit({ cli: [], tools: ['t.ts'] }, { cli: [] }), { unaccounted: ['t.ts'], stale: [] });
  });

  it('reads a list named __proto__ or constructor as a list, never the prototype', () => {
    const b = parseBaseline('{"__proto__": ["p.ts"], "constructor": ["c.ts"]}', ['__proto__', 'constructor'], 'b.json', 'paths');
    assert.deepEqual(Object.keys(b), ['__proto__', 'constructor']);
    assert.deepEqual(b['__proto__'], ['p.ts']);
    assert.equal(Object.getPrototypeOf(b), null);
    // A list the text lacks is not read from the prototype.
    assert.throws(() => parseBaseline('{}', ['constructor'], 'b.json', 'paths'), /"constructor" must be a list of paths/);
    assert.deepEqual({ ...parseBaseline('{}', ['constructor'], 'b.json', 'paths', true) }, { constructor: [] });
    assert.deepEqual(audit({ constructor: ['c.ts'] }, {}), { unaccounted: ['c.ts'], stale: [] });
  });

  it('reports only entries added since the base', () => {
    assert.deepEqual(grownEntries({ cli: ['a.ts', 'b.ts'], server: ['s.ts'] }, { cli: ['b.ts', 'n.ts'], server: [] }), ['n.ts']);
    assert.deepEqual(grownEntries({ handParsers: [], pairs: [] }, { handParsers: ['m.ts#yaml'], pairs: [] }), ['m.ts#yaml']);
  });

  it('does not count an entry whose file only moved as growth', () => {
    assert.deepEqual(grownEntries({ cli: ['old/a.ts'] }, { cli: ['new/a.ts', 'n.ts'] }, new Map([['new/a.ts', 'old/a.ts']])), ['n.ts']);
    const base = { handParsers: ['old/m.ts#yaml'], pairs: ['old/p.ts'] };
    const head = { handParsers: ['new/m.ts#yaml', 'new/m.ts#json'], pairs: ['new/p.ts', 'q.ts'] };
    const renamed = new Map([
      ['new/m.ts', 'old/m.ts'],
      ['new/p.ts', 'old/p.ts'],
    ]);
    const beforeHash = (id: string): string => id.slice(0, id.lastIndexOf('#') === -1 ? id.length : id.lastIndexOf('#'));
    assert.deepEqual(grownEntries(base, head, renamed, beforeHash), ['new/m.ts#json', 'q.ts']);
    assert.deepEqual(grownEntries(base, head, new Map(), beforeHash), ['new/m.ts#yaml', 'new/m.ts#json', 'new/p.ts', 'q.ts']);
  });

  it('looks a moved file up by the whole id unless told where its path ends, so a path may hold a #', () => {
    // A fault id is a path, and a path may hold a #: the whole id is looked up.
    assert.deepEqual(grownEntries({ cli: ['old/a#b.ts'] }, { cli: ['new/a#b.ts'] }, new Map([['new/a#b.ts', 'old/a#b.ts']])), []);
    // The first # is not the split: a codec id's path ends at its last #.
    const renamed = new Map([['new/a#b.ts', 'old/a#b.ts']]);
    assert.deepEqual(grownEntries({ handParsers: ['old/a#b.ts#yaml'] }, { handParsers: ['new/a#b.ts#yaml'] }, renamed, (id) => id.slice(0, id.lastIndexOf('#'))), []);
    assert.deepEqual(grownEntries({ handParsers: ['old/a#b.ts#yaml'] }, { handParsers: ['new/a#b.ts#yaml'] }, renamed), ['new/a#b.ts#yaml']);
  });

  it('counts an entry that only changed list as no growth', () => {
    assert.deepEqual(grownEntries({ cli: ['a.ts'], server: [] }, { cli: [], server: ['a.ts'] }), []);
  });

  it('names a root no tracked file lies under', () => {
    assert.deepEqual(emptyRoots(['scripts/a.ts', 'one.ts'], ['scripts', 'one.ts', 'script', 'docs']), ['script', 'docs']);
  });
});

describe('suite wiring', () => {
  const imports = (source: string, file = 'scripts/x.test.ts'): string[] => importSpecifiers(ts, file, source);

  it('reads the imports from the syntax tree: declarations, re-exports and literal dynamic imports', () => {
    const source = [
      "import { a } from './a.ts';",
      "import b from './b';",
      "import * as c from './c.js';",
      "import './side-effect';",
      "export { d } from './d';",
      "export * from './e';",
      "const f = await import('./f.ts');",
      'const g = await import(`./g.ts`);',
      "import fc from 'fast-check';",
    ].join('\n');
    assert.deepEqual(imports(source), ['./a.ts', './b', './c.js', './side-effect', './d', './e', './f.ts', './g.ts', 'fast-check']);
  });

  it('takes no specifier from a comment, another string, a type-only import or a computed import', () => {
    const source = [
      "// import { a } from './target.ts';",
      "/* } from './target.ts' */",
      "const s = \"from './target.ts'\";",
      "const t = `from 'fast-check'`;",
      "import type { T } from './target.ts';",
      "export type { U } from './target.ts';",
      "const name = './target.ts'; await import(name);",
    ].join('\n');
    assert.deepEqual(imports(source), []);
    assert.equal(importsModule('scripts/x.test.ts', imports(source), 'scripts/target.ts'), false);
    assert.equal(importsPackage(imports(source), 'fast-check'), false);
  });

  it('resolves a relative specifier against the suite, extension or not', () => {
    const suite = 'scripts/validations/records/paths.differential.properties.test.ts';
    const target = 'scripts/validations/records/paths.ts';
    assert.equal(importsModule(suite, ['./paths.ts'], target), true);
    assert.equal(importsModule(suite, ['../records/paths'], target), true);
    assert.equal(importsModule(suite, ['./paths.js'], target), true);
    // Same basename, another directory: not the registered source.
    assert.equal(importsModule(suite, ['../documentation/paths.ts'], target), false);
    assert.equal(importsModule(suite, ['paths'], target), false);
  });

  it('takes a folder import as its index module', () => {
    const target = 'packages/h/src/fault/index.ts';
    assert.equal(importsModule('scripts/x.test.ts', ['../packages/h/src/fault/index.ts'], target), true);
    assert.equal(importsModule('scripts/x.test.ts', ['../packages/h/src/fault'], target), true);
    assert.equal(importsModule('scripts/x.test.ts', ['../packages/h/src/fault/'], target), true);
    assert.equal(importsModule('scripts/x.test.ts', ['../packages/h/src/faults'], target), false);
    assert.equal(importsModule('scripts/x.test.ts', ['./index'], 'scripts/y.ts'), false);
  });

  it('reads a package import by its exact specifier, and a quoted module name in either quote', () => {
    assert.equal(importsPackage(imports("import fc from 'fast-check';"), 'fast-check'), true);
    assert.equal(importsPackage(imports('import fc from "fast-check";'), 'fast-check'), true);
    assert.equal(importsPackage(imports("import fc from 'fast-check/x';"), 'fast-check'), false);
    assert.equal(namesModule("await import('parse5')", 'parse5'), true);
    assert.equal(namesModule('const m = "parse5";', 'parse5'), true);
    assert.equal(namesModule('parse5 is mentioned', 'parse5'), false);
  });

  it('collects a suite by any collected pattern', () => {
    assert.equal(isCollected([/^scripts\/.+\.test\.ts$/], 'scripts/a.test.ts'), true);
    assert.equal(isCollected([/^scripts\/.+\.test\.ts$/], 'docs/a.test.ts'), false);
  });
});

describe('catalogue examples', () => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-examples-'));
  const catalogue = { checks: [{ id: 'A-1', slice: 'S', example: 'M1: a thing' }, { id: 'B-2', slice: 'S', example: 'M2: b thing' }, { id: 'C-3', slice: 'other', example: 'M3: c' }] };
  put(root, {
    'cat.json': JSON.stringify(catalogue),
    'scripts/a.test.ts': 'M1 check(',
    'scripts/b.test.ts': 'M2',
    'docs/c.test.ts': 'nothing',
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  const collected = [/^scripts\//];

  it('reads the examples key, required, null opting it or its catalogue out', () => {
    assert.throws(() => parseExamples({}, []), /"examples" is required \(null opts its check out\)/);
    const skipped: string[] = [];
    assert.equal(parseExamples({ examples: null }, skipped), undefined);
    assert.deepEqual(skipped, ['examples']);
    const fixtures = { 'A-1': { example: 'M1', test: 'scripts/a.test.ts' } };
    assert.deepEqual(plainExamples(parseExamples({ examples: { catalogue: { path: 'cat.json', slice: 'S' }, fixtures } }, [])), { catalogue: { path: 'cat.json', slice: 'S' }, fixtures });
    const noCatalogue: string[] = [];
    assert.equal(parseExamples({ examples: { catalogue: null, fixtures } }, noCatalogue)?.catalogue, undefined);
    assert.deepEqual(noCatalogue, ['examples.catalogue']);
    assert.throws(() => parseExamples({ examples: { fixtures } }, []), /examples: "catalogue" is required/);
    assert.throws(() => parseExamples({ examples: { catalogue: { path: 'cat.json' }, fixtures } }, []), /examples\.catalogue: "slice" must be a non-empty string/);
    assert.throws(() => parseExamples({ examples: { catalogue: { path: 'cat.json', slice: 'S', x: 1 }, fixtures } }, []), /examples\.catalogue: unknown key "x"/);
    assert.throws(() => parseExamples({ examples: { catalogue: null, fixtures: {} } }, []), /"fixtures" is empty/);
    assert.throws(() => parseExamples({ examples: { catalogue: null, fixtures: { a: 1 } } }, []), /examples\.fixtures\.a must be an object/);
    assert.throws(() => parseExamples({ examples: { catalogue: null, fixtures: { a: { example: 'M1', test: 'a.ts', extra: 1 } } } }, []), /examples\.fixtures\.a: unknown key "extra"/);
    assert.throws(() => parseExamples({ examples: { other: 1 } }, []), /examples: unknown key "other"/);
  });

  it('keeps a fixture keyed __proto__ as a fixture, and finds no fixture a catalogue id names only by inheritance', () => {
    const raw = JSON.parse('{"examples": {"catalogue": null, "fixtures": {"__proto__": {"example": "M1", "test": "scripts/a.test.ts"}}}}') as Record<string, unknown>;
    const parsed = parseExamples(raw, []);
    assert.deepEqual(Object.keys(parsed?.fixtures ?? {}), ['__proto__']);
    assert.equal(Object.getPrototypeOf(parsed?.fixtures), null);
    put(root, { 'proto.json': JSON.stringify({ checks: [{ id: 'constructor', slice: 'P', example: 'M1: x' }, { id: 'toString', slice: 'P', example: 'M2: y' }] }) });
    const examples = parseExamples({ examples: { catalogue: { path: 'proto.json', slice: 'P' }, fixtures: { A: { example: 'M1', test: 'scripts/a.test.ts' } } } }, []);
    assert.ok(examples !== undefined);
    assert.deepEqual(checkExamples(root, examples, [/^scripts\//]).slice(0, 2), ['proto.json: constructor (slice P) has no example fixture', 'proto.json: toString (slice P) has no example fixture']);
  });

  it('passes fixtures that cover the slice, each from its own example, collected and naming it', () => {
    const fixtures = { 'A-1': { example: 'M1', test: 'scripts/a.test.ts' }, 'B-2': { example: 'M2', test: 'scripts/b.test.ts' } };
    assert.deepEqual(checkExamples(root, { catalogue: { path: 'cat.json', slice: 'S' }, fixtures }, collected), []);
    assert.deepEqual(checkExamples(root, { catalogue: undefined, fixtures }, collected, (id, body) => (body.includes('check(') ? [] : [`${id} calls nothing`])), ['scripts/b.test.ts: B-2 calls nothing']);
  });

  it('refuses a missing, extra, mismatched, absent, uncollected or unnamed fixture', () => {
    const fixtures = {
      'A-1': { example: 'M9', test: 'scripts/a.test.ts' },
      'C-3': { example: 'M3', test: 'docs/c.test.ts' },
      'D-4': { example: 'M4', test: 'scripts/gone.test.ts' },
    };
    assert.deepEqual(checkExamples(root, { catalogue: { path: 'cat.json', slice: 'S' }, fixtures }, collected), [
      'examples.fixtures.A-1: the catalogue\'s example is not M9 ("M1: a thing")',
      'cat.json: B-2 (slice S) has no example fixture',
      'examples.fixtures.C-3: not a check cat.json gives slice S',
      'examples.fixtures.D-4: not a check cat.json gives slice S',
      'scripts/a.test.ts: the A-1 example suite does not name M9',
      'docs/c.test.ts: no runner collects the C-3 example suite',
      'docs/c.test.ts: the C-3 example suite does not name M3',
      'scripts/gone.test.ts: the D-4 example suite does not exist',
    ]);
  });

  it('stops on a catalogue it cannot read', () => {
    put(root, { 'bad.json': '{', 'shape.json': '{"checks":[{"id":1}]}' });
    const fixtures = { 'A-1': { example: 'M1', test: 'scripts/a.test.ts' } };
    assert.throws(() => checkExamples(root, { catalogue: { path: 'none.json', slice: 'S' }, fixtures }, collected), /the catalogue none\.json is not a readable file/);
    assert.throws(() => checkExamples(root, { catalogue: { path: 'bad.json', slice: 'S' }, fixtures }, collected), /the catalogue bad\.json: not JSON/);
    assert.throws(() => checkExamples(root, { catalogue: { path: 'shape.json', slice: 'S' }, fixtures }, collected), /"checks" must be a list of \{ id, slice, example \}/);
  });

  it('reads a file only when it is a readable file', () => {
    assert.equal(readText(root, 'scripts/b.test.ts'), 'M2');
    assert.equal(readText(root, 'scripts'), undefined);
    assert.equal(readText(root, 'none'), undefined);
    put(root, { 'locked.txt': 'x' });
    chmodSync(join(root, 'locked.txt'), 0o000);
    try {
      // root reads anything; anyone else cannot.
      assert.equal(readText(root, 'locked.txt'), process.getuid?.() === 0 ? 'x' : undefined);
    } finally {
      chmodSync(join(root, 'locked.txt'), 0o644);
    }
  });

  it('reads a baseline file, refusing one that is missing', () => {
    put(root, { 'base.json': '{"a":["x"]}' });
    const parse = (s: string, w: string) => parseBaseline(s, ['a'], w, 'ids');
    assert.deepEqual({ ...readBaseline(root, 'base.json', parse) }, { a: ['x'] });
    assert.throws(() => readBaseline(root, 'none.json', parse), /the baseline none\.json is not a readable file/);
  });
});

describe('the verdict', () => {
  it('prints a summary when clean and every finding with a hint when not', () => {
    assert.deepEqual(formatOutcome('p:', [], 'all good', 'fix it'), { ok: true, out: ['p: all good'], err: [] });
    assert.deepEqual(formatOutcome('p:', ['a', 'b'], 'all good', 'fix it'), { ok: false, out: [], err: ['p: a', 'p: b', 'p: 2 problem(s). fix it'] });
  });

  it('says what it did not check, on a pass and a refusal alike', () => {
    assert.deepEqual(formatOutcome('p:', [], 'all good', 'fix it', ['surfaces', 'baseline growth (--no-base)']).out, ['p: all good', 'p: not checked: surfaces, baseline growth (--no-base)']);
    assert.deepEqual(formatOutcome('p:', ['a'], 'all good', 'fix it', ['surfaces']).out, ['p: not checked: surfaces']);
  });
});

describe('git: tracked files, the merge base and a file at a commit', () => {
  let repo = '';
  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'pariksha-ratchet-'));
    sh(repo, 'init', '-q', '-b', 'main');
    put(repo, { 'baseline.json': '{"at":"base"}\n', 'dir/a.ts': '', 'one.ts': '', '[x].ts': '' });
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');
    sh(repo, 'checkout', '-q', '-b', 'topic');
    // A listing longer than 64 bytes: a buffer sized in bytes, not MiB, fails.
    put(repo, { 'baseline.json': '{"at":"head"}\n', 'new.json': '{}\n', [LONG]: '{}\n' });
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'head');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it('lists tracked files under literal roots that still exist, leaving out deleted ones', () => {
    const git = gitAt(repo);
    rmSync(join(repo, 'new.json'));
    try {
      assert.deepEqual(trackedUnder(git, repo, ['.']).sort(), [LONG, '[x].ts', 'baseline.json', 'dir/a.ts', 'one.ts'].sort());
      assert.deepEqual(trackedUnder(git, repo, ['dir', 'one.ts']), ['dir/a.ts', 'one.ts']);
      // A root is a literal path, never a glob: `[x].ts` names only itself.
      assert.deepEqual(trackedUnder(git, repo, ['[x].ts']), ['[x].ts']);
    } finally {
      put(repo, { 'new.json': '{}\n' });
    }
  });

  it('names the merge base as a full sha, and throws when the base does not resolve', () => {
    const git = gitAt(repo);
    assert.equal(mergeBaseOf(git, 'main'), sh(repo, 'rev-parse', 'main').trim());
    assert.throws(() => mergeBaseOf(git, 'no-such-ref'), /git merge-base HEAD no-such-ref failed/);
  });

  it('reads a file at a commit, null only where the commit lacks it', () => {
    const git = gitAt(repo);
    assert.equal(fileAt(git, 'main', 'baseline.json'), '{"at":"base"}\n');
    assert.equal(fileAt(git, 'topic', 'baseline.json'), '{"at":"head"}\n');
    assert.equal(fileAt(git, 'main', 'new.json'), null);
    assert.throws(() => fileAt(git, 'no-such-ref', 'baseline.json'), /failed/);
  });

  it('holds the head baseline to the merge base: growth, none, or no baseline there yet', () => {
    const git = gitAt(repo);
    const parse = (s: string, where: string) => parseBaseline(s, ['a'], where, 'ids');
    put(repo, { 'b.json': '{"a":["x"]}' });
    sh(repo, 'add', 'b.json');
    sh(repo, 'commit', '-q', '-m', 'b');
    sh(repo, 'branch', '-f', 'main');
    assert.deepEqual(growthSince(git, 'main', 'b.json', { a: ['x', 'y'] }, parse), ['y']);
    assert.deepEqual(growthSince(git, 'main', 'b.json', { a: [] }, parse), []);
    assert.deepEqual(growthSince(git, 'main', 'absent.json', { a: ['y'] }, parse), []);
    put(repo, { 'bad.json': '[]' });
    sh(repo, 'add', 'bad.json');
    sh(repo, 'commit', '-q', '-m', 'bad');
    sh(repo, 'branch', '-f', 'main');
    assert.throws(() => growthSince(git, 'main', 'bad.json', { a: [] }, parse), /bad\.json at the merge base [0-9a-f]{12}: must be an object with "a" lists/);
  });
});

describe('git: renames since the merge base', () => {
  let repo = '';
  const BODY = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');
  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'pariksha-renames-'));
    sh(repo, 'init', '-q', '-b', 'main');
    put(repo, { 'old/moved.ts': BODY, 'old/edited.ts': BODY, 'old/café.ts': BODY, 'kept.ts': BODY });
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');
    sh(repo, 'checkout', '-q', '-b', 'topic');
    mkdirSync(join(repo, 'new'));
    sh(repo, 'mv', 'old/moved.ts', 'new/moved.ts');
    sh(repo, 'mv', 'old/café.ts', 'new/café.ts');
    sh(repo, 'mv', 'old/edited.ts', 'new/edited.ts');
    // A move with a path edit, as a moved script's root depth changes.
    put(repo, { 'new/edited.ts': `${BODY}line 40\n`, 'kept.ts': `${BODY}more\n` });
    sh(repo, 'add', '-A');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it('maps each renamed file, an edited one included, to its old path, a non-ASCII name as committed', () => {
    const git = gitAt(repo);
    const renamed = renamesSince(git, mergeBaseOf(git, 'main'));
    assert.deepEqual([...renamed].sort(), [
      ['new/café.ts', 'old/café.ts'],
      ['new/edited.ts', 'old/edited.ts'],
      ['new/moved.ts', 'old/moved.ts'],
    ]);
  });

  it('counts a rename only, never a copy, an edit or an addition', () => {
    const fields = ['C075', 'src/b.ts', 'R-copy/b.ts', 'M', 'RENAMED.md', 'R087', 'old/a.ts', 'new/a.ts', 'A', 'added.ts', 'R100', 'old/c d.ts', 'new/c d.ts', 'D', 'gone.ts', ''];
    assert.deepEqual([...parseRenames(fields.join('\0'))], [
      ['new/a.ts', 'old/a.ts'],
      ['new/c d.ts', 'old/c d.ts'],
    ]);
  });

  it('reads nothing from a truncated rename', () => {
    assert.equal(parseRenames(['R100', 'old/a.ts'].join('\0')).size, 0);
    assert.equal(parseRenames('').size, 0);
  });

  it('throws when the commit cannot be read, rather than finding no renames', () => {
    assert.throws(() => renamesSince(gitAt(repo), 'no-such-ref'), /git diff --name-status -z -M --no-ext-diff no-such-ref failed/);
  });
});
