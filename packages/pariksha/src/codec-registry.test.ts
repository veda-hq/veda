import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { covered, discover, expectedBaseline, fileOf, FORMATS, findings, formatFindings, checkWiring, pairsIn, parseBaseline, parseConfig, type Config, type Discovery } from './codec-registry.ts';
import { gitAt, trackedUnder } from './git.ts';
import { audit } from './registry-ratchet.ts';
import { loadTypescript, type Ts } from './typescript.ts';

const loaded = loadTypescript();
if (typeof loaded === 'string') throw new Error(loaded);
const ts: Ts = loaded;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const sh = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, env: ENV, stdio: 'ignore', timeout: 30_000 });
};
const put = (root: string, files: Record<string, string>): void => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
};
const ALL = new Set(FORMATS);

/** Discovery over these files in a throwaway repo. */
const scanFiles = (files: Record<string, string>, roots: readonly string[] = ['scripts']): Discovery => {
  const repo = mkdtempSync(join(tmpdir(), 'pariksha-codec-scan-'));
  try {
    put(repo, files);
    sh(repo, 'init', '-q');
    sh(repo, 'add', '-A');
    return discover(ts, repo, trackedUnder(gitAt(repo), repo, roots), ALL);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
};
/** Discovery over one file in a throwaway repo. */
const scan = (text: string, name = 'x.ts'): Discovery => scanFiles({ [`scripts/${name}`]: text });

const ORACLES = { markdown: 'mdast-util-from-markdown', html: 'parse5', yaml: 'js-yaml', csv: 'papaparse', shell: 'bash', ts: 'typescript' };

/** A config with these overrides on a minimal valid one. */
const config = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  baseline: 'baseline.json',
  roots: ['scripts'],
  oracles: ORACLES,
  collected: ['^scripts/.+\\.test\\.ts$'],
  surfaces: ['scripts/**/*.{differential,roundtrip}.properties.test.ts'],
  markers: { seed: 'seed: SEED', lineEndings: 'LINE_ENDINGS', golden: 'assertGolden' },
  handParsers: [{ source: 'scripts/md.ts', formats: ['markdown'], suite: 'scripts/md.differential.properties.test.ts', outOfModel: 'lists' }],
  pairs: [{ id: 'scripts/row.ts#writeRow->readRow', kind: 'round-trip', suite: 'scripts/row.roundtrip.properties.test.ts' }],
  exempt: [],
  minNoteLength: 1,
  examples: null,
  findingIds: null,
  ...over,
});
const parsed = (over: Record<string, unknown> = {}): Config => parseConfig(JSON.stringify(config(over)));

describe('discovery: what counts', () => {
  const finds: Array<[string, string, string]> = [
    ['a markdown fence regex', 'export const F = /^```/;\n', 'x.ts#markdown'],
    ['an ATX heading regex', 'export const H = /^#{1,6}\\s/;\n', 'x.ts#markdown'],
    ['an indented ATX heading regex', 'export const H = /^ {0,3}#{1,6}\\s/;\n', 'x.ts#markdown'],
    ['an optionally spaced heading regex', 'export const H = /^(?:\\s*)?#/;\n', 'x.ts#markdown'],
    ['a spaced heading regex', 'export const H = /^\\s*#/;\n', 'x.ts#markdown'],
    ['a frontmatter delimiter', "export const D = '---';\n", 'x.ts#yaml'],
    ['a backtick fence string', "export const F = '```';\n", 'x.ts#markdown'],
    ['a tilde fence string', "export const F = '~~~';\n", 'x.ts#markdown'],
    ['a script tag string', "export const S = '<script';\n", 'x.ts#html'],
    ['an import statement regex', 'export const I = /import\\s+x/;\n', 'x.ts#ts'],
    ['an HTML element regex', 'export const T = /<li>(.*?)<\\/li>/g;\n', 'x.ts#html'],
    ['an opening-tag-only regex', 'export const T = /<div[^>]*>/g;\n', 'x.ts#html'],
    ['an upper-case opening tag', 'export const T = /<TD\\b/;\n', 'x.ts#html'],
    ['a CSV split in a CSV module', "// csv rows\nexport const r = (l: string) => l.split(',');\n", 'x.ts#csv'],
  ];
  for (const [label, text, id] of finds) {
    it(`finds ${label}`, () => {
      assert.deepEqual(scan(text).handParsers, [`scripts/${id}`]);
    });
  }

  const misses: Array<[string, string, string?]> = [
    ['a comma split with no CSV in sight', "export const r = (l: string) => l.split(',');\n"],
    ['a heading regex in a test', 'export const F = /^#/;\n', 'x.test.ts'],
    ['a four-space indent, which is code', 'export const F = /^ {0,4}#/;\n'],
    ['a # after other text', 'export const F = /^a#/;\n'],
    ['a named group and its backreference', 'export const D = /(?<year>\\d{4})-\\k<year>/;\n'],
  ];
  for (const [label, text, name] of misses) {
    it(`does not count ${label} (near-miss)`, () => {
      assert.deepEqual(scan(text, name).handParsers, []);
    });
  }

  it('reports only the formats the config holds an oracle for', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pariksha-codec-formats-'));
    try {
      put(repo, { 'scripts/x.ts': "export const D = '---';\nexport const F = '```';\n" });
      sh(repo, 'init', '-q');
      sh(repo, 'add', '-A');
      assert.deepEqual(discover(ts, repo, ['scripts/x.ts'], new Set(['yaml'] as const)).handParsers, ['scripts/x.ts#yaml']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('pairs a producer and consumer of the same stem, and a versioned hash', () => {
    assert.deepEqual(pairsIn('m.ts', ['writeEntry', 'readEntry', 'parseEntry', 'readOther']), ['m.ts#writeEntry->readEntry', 'm.ts#writeEntry->parseEntry']);
    assert.deepEqual(scan("import { createHash } from 'node:crypto';\nexport const SCHEMA = 1;\nexport const k = () => createHash('sha256');\n").pairs, ['scripts/x.ts#digest']);
  });

  it('marks a hash as versioned by a schema string passed to a call, not one merely held', () => {
    const hash = "import { createHash } from 'node:crypto';\n";
    assert.deepEqual(scan(`${hash}export const k = (v: string) => createHash('sha256').update(tag('schema', v));\n`).pairs, ['scripts/x.ts#digest']);
    assert.deepEqual(scan(`${hash}const s = 'schema';\nexport const k = () => createHash(s);\n`).pairs, []);
  });

  const noPairs: Array<[string, string]> = [
    ['a schema constant with no hash', 'export const SCHEMA = 1;\nexport const k = () => foo();\n'],
    ['a hash with no schema mark', "import { createHash } from 'node:crypto';\nexport const k = () => createHash('sha256');\n"],
    ['a hash beside a SCHEMA name holding text', "import { createHash } from 'node:crypto';\nexport const SCHEMA_NAME = 'x';\nexport const k = () => createHash('sha256');\n"],
    ['a hash beside a numeric constant not named SCHEMA', "import { createHash } from 'node:crypto';\nexport const VERSION = 2;\nexport const k = () => createHash('sha256');\n"],
    ['an unexported producer', 'function writeRow() {}\nexport function readRow() {}\n'],
    ['an exported class named like a producer', 'export class writeRow {}\nexport function readRow() {}\n'],
    ['an exported constant that is not a function', 'export const writeRow = 1;\nexport function readRow() {}\n'],
    ['a listed constant that is not a function', 'const writeRow = 1;\nfunction readRow() {}\nexport { writeRow, readRow };\n'],
    ['a type-only export list', 'function writeRow() {}\nfunction readRow() {}\nexport type { writeRow, readRow };\n'],
    ['a destructured export', 'export const { writeRow, readRow } = api;\n'],
  ];
  for (const [label, text] of noPairs) {
    it(`finds no pair in ${label}`, () => {
      assert.deepEqual(scan(text).pairs, []);
    });
  }

  it('reads a regex body without its flags, and shell only with all three quote tokens', () => {
    assert.deepEqual(scan('export const R = /a</g;\n').handParsers, []);
    const quotes = `const q = ["'", '"', '\\\\'];\n`;
    assert.deepEqual(scan(`// shell tokenizer\n${quotes}`).handParsers, ['scripts/x.ts#shell']);
    assert.deepEqual(scan('// shell helper\nexport const x = 1;\n').handParsers, []);
    assert.deepEqual(scan(`// csv rows\nexport const r = (l: string[]) => l.join(',');\n`).handParsers, []);
  });

  const shell: Array<[string, string, string[]]> = [
    ['one regex naming both quotes and an escaped backslash', String.raw`const T = /'[^']*'|"(?:[^"\\]|\\.)*"|\\./g;`, ['scripts/x.ts#shell']],
    ['the quotes and the backslash spread over three regexes', `${String.raw`const A = /'/;`}\n${String.raw`const B = /"/;`}\n${String.raw`const C = /\\/;`}`, []],
    ['one regex naming both quotes and no escaped backslash', String.raw`const T = /'[^']*'|"\s*"/g;`, []],
  ];
  for (const [label, text, found] of shell) {
    it(`reads shell from ${label}`, () => {
      assert.deepEqual(scan(`// shell tokenizer\n${text}\n`).handParsers, found);
    });
  }

  const lists: Array<[string, string]> = [
    ['an export list', 'function writeRow() {}\nconst readRow = () => 1;\nexport { writeRow, readRow };\n'],
    ['an export list renaming its functions', 'function w() {}\nconst r = function () {};\nexport { w as writeRow, r as readRow };\n'],
    ['an export list beside a star re-export', "export * from './y';\nfunction writeRow() {}\nfunction readRow() {}\nexport { writeRow, readRow };\n"],
  ];
  for (const [label, text] of lists) {
    it(`pairs functions named in ${label}`, () => {
      assert.deepEqual(scan(text).pairs, ['scripts/x.ts#writeRow->readRow']);
    });
  }

  it('reads exported functions only, past exported declarations of other kinds', () => {
    assert.deepEqual(
      scan('export class Store {}\nexport interface Row { a: string }\nexport const writeRow = () => 1;\nexport function readRow() {}\nconst writeOther = () => 1;\nexport const readOther = () => 1;\n').pairs,
      ['scripts/x.ts#writeRow->readRow'],
    );
  });

  it('makes no pair of a name an export list marks type-only', () => {
    assert.deepEqual(scan('function writeRow() {}\nfunction readRow() {}\nexport { type writeRow, readRow };\n').pairs, []);
    assert.deepEqual(scan('function writeRow() {}\nfunction readRow() {}\nexport { writeRow, readRow };\n').pairs, ['scripts/x.ts#writeRow->readRow']);
  });

  it('reads the file of an id as the path before its last #', () => {
    assert.equal(fileOf('scripts/a.ts#yaml'), 'scripts/a.ts');
    assert.equal(fileOf('scripts/a#b.ts#writeRow->readRow'), 'scripts/a#b.ts');
    assert.equal(fileOf('scripts/a.ts'), 'scripts/a.ts');
  });

  it('scans the source trees in scope and nothing else, and source files only', () => {
    const yaml = "export const D = '---';\n";
    const roots = ['scripts', '.claude/scripts', 'apps/server/src', 'apps/web/src', 'apps/mobile/src', 'packages'];
    assert.deepEqual(
      scanFiles(
        {
          'scripts/a.ts': yaml,
          '.claude/scripts/b.ts': yaml,
          'apps/server/src/c.ts': yaml,
          'apps/web/src/d.ts': yaml,
          'apps/mobile/src/e.ts': yaml,
          'packages/f.ts': yaml,
          'docs/g.ts': yaml,
          'apps/server/test/h.ts': yaml,
          'scripts/notes.md': yaml,
          'scripts/types.d.ts': yaml,
          'scripts/fixtures/i.ts': yaml,
          'scripts/j.fixture.ts': yaml,
          'scripts/__mocks__/k.ts': yaml,
        },
        roots,
      ).handParsers,
      ['.claude/scripts/b.ts#yaml', 'apps/mobile/src/e.ts#yaml', 'apps/server/src/c.ts#yaml', 'apps/web/src/d.ts#yaml', 'packages/f.ts#yaml', 'scripts/a.ts#yaml'],
    );
  });
});

describe('guard removal flips it', () => {
  const found: Discovery = { handParsers: ['m.ts#yaml'], pairs: ['m.ts#writeA->readA'] };

  it('an unregistered parser is unaccounted; registering it accounts for it', () => {
    const empty = { handParsers: [], pairs: [] };
    assert.deepEqual(audit(expectedBaseline(found, new Set()), empty).unaccounted, ['m.ts#yaml', 'm.ts#writeA->readA']);
    const registered = covered({
      handParsers: [{ source: 'm.ts', formats: ['yaml'], suite: 's', outOfModel: 'x', lfOnly: undefined, motivatedBy: undefined }],
      pairs: [{ id: 'm.ts#writeA->readA', kind: 'round-trip', suite: 's', motivatedBy: undefined }],
      exempt: [],
    });
    assert.deepEqual(audit(expectedBaseline(found, registered), empty), { unaccounted: [], stale: [] });
  });

  it('an exemption accounts for an id as registering does', () => {
    const cover = covered({ handParsers: [], pairs: [], exempt: [{ id: 'm.ts#yaml', reason: 'r' }] });
    assert.deepEqual(expectedBaseline(found, cover), { handParsers: [], pairs: ['m.ts#writeA->readA'] });
  });

  it('a malformed baseline fails loudly rather than reading as empty', () => {
    assert.throws(() => parseBaseline('{"handParsers":[1],"pairs":[]}', 'b.json'), /"handParsers" must be a list of ids/);
    assert.throws(() => parseBaseline('{"handParsers":[]}', 'b.json'), /"pairs"/);
    assert.deepEqual({ ...parseBaseline('{"handParsers":["a#yaml"],"pairs":["b#digest"]}', 'b.json') }, { handParsers: ['a#yaml'], pairs: ['b#digest'] });
  });
});

describe('wiring: additions, modifications, deletions and renames are seen', () => {
  let repo = '';
  const yaml = "export const D = '---';\n";
  const baseline = { handParsers: ['scripts/old.ts#yaml'], pairs: [] };
  const state = (): ReturnType<typeof audit> => audit(expectedBaseline(discover(ts, repo, trackedUnder(gitAt(repo), repo, ['scripts', 'apps/server/src']), ALL), new Set()), baseline);

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'pariksha-codec-'));
    sh(repo, 'init', '-q');
    put(repo, { 'scripts/old.ts': yaml, 'scripts/plain.ts': 'export const x = 1;\n', 'apps/server/src/keep.ts': '' });
    sh(repo, 'add', '-A');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it('starts consistent', () => {
    assert.deepEqual(state(), { unaccounted: [], stale: [] });
  });

  it('A: a new hand parser is unaccounted', () => {
    put(repo, { 'apps/server/src/new.ts': 'export const T = /<li>(.*?)<\\/li>/g;\n' });
    sh(repo, 'add', '-A');
    assert.deepEqual(state().unaccounted, ['apps/server/src/new.ts#html']);
    sh(repo, 'rm', '-q', '-f', 'apps/server/src/new.ts');
  });

  it('M: a module gaining a format is unaccounted for that format', () => {
    put(repo, { 'scripts/plain.ts': 'export const F = /^```/;\n' });
    assert.deepEqual(state().unaccounted, ['scripts/plain.ts#markdown']);
    put(repo, { 'scripts/plain.ts': 'export const x = 1;\n' });
  });

  it('D: a deleted baselined module must leave the baseline', () => {
    rmSync(join(repo, 'scripts/old.ts'));
    assert.deepEqual(state().stale, ['scripts/old.ts#yaml']);
    sh(repo, 'checkout', '--', 'scripts/old.ts');
  });

  it('R: a renamed module is a new id and a stale one', () => {
    sh(repo, 'mv', 'scripts/old.ts', 'scripts/renamed.ts');
    assert.deepEqual(state(), { unaccounted: ['scripts/renamed.ts#yaml'], stale: ['scripts/old.ts#yaml'] });
    sh(repo, 'mv', 'scripts/renamed.ts', 'scripts/old.ts');
  });
});

describe('the config', () => {
  it('reads a valid config, defaulting the property library', () => {
    const c = parsed();
    assert.equal(c.library, 'fast-check');
    assert.equal(c.handParsers[0]?.lfOnly, undefined);
    assert.equal(c.examples, undefined);
    assert.deepEqual(c.findingIds, { motivatedBy: undefined, example: undefined });
    assert.deepEqual(c.skipped, ['examples', 'findingIds']);
    assert.equal(parsed({ library: 'fc' }).library, 'fc');
  });

  it('opts out of the surface check only by an explicit null, which it records', () => {
    const c = parsed({ surfaces: null });
    assert.equal(c.surfaces, undefined);
    assert.deepEqual(c.skipped, ['surfaces', 'examples', 'findingIds']);
  });

  it('holds motivations and examples to their own finding-id patterns', () => {
    // For example: a motivation is an M finding, an example an M or V one.
    const ids = { findingIds: { motivatedBy: '^M\\d{10}$', example: '^[MV]\\d{10}$' } };
    const fixtures = { catalogue: null, fixtures: { E: { example: 'V3586514538', test: 'scripts/e.test.ts' } } };
    assert.equal(parsed({ ...ids, examples: fixtures }).findingIds.example?.source, '^[MV]\\d{10}$');
    const vMotivation = { ...ids, pairs: [{ id: 'a.ts#digest', kind: 'golden', suite: 's.ts', motivatedBy: 'V3586514538' }] };
    assert.throws(() => parsed(vMotivation), /pairs a\.ts#digest: motivatedBy: "V3586514538" is not a finding id \(\^M\\d\{10\}\$\)/);
  });

  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an unknown key', { extra: 1 }, /^Error: unknown key "extra"$/],
    ['an unknown format in oracles', { oracles: { json: 'x' } }, /oracles: "json" is not a format discovery reads/],
    ['an oracle that names no module', { oracles: { yaml: '' } }, /oracles\.yaml must be a module name/],
    ['no oracles', { oracles: {}, handParsers: [] }, /"oracles" is empty/],
    ['no surfaces key, which would drop the surface check', { surfaces: undefined }, /"surfaces" is required \(null opts its check out\)/],
    ['an empty surface list', { surfaces: [] }, /"surfaces" is empty; name the globs a property suite must sit on, or null/],
    ['an empty surface glob', { surfaces: [''] }, /surfaces\[0\] must be a non-empty glob/],
    ['no examples key', { examples: undefined }, /"examples" is required/],
    ['no findingIds key', { findingIds: undefined }, /"findingIds" is required/],
    ['no minNoteLength', { minNoteLength: undefined }, /"minNoteLength" must be a whole number of at least 1/],
    ['an unknown marker', { markers: { seed: 'a', lineEndings: 'b', golden: 'c', other: 'd' } }, /markers: unknown key "other"/],
    ['a missing marker', { markers: { seed: 'a', lineEndings: 'b' } }, /markers: "golden" must be a non-empty string/],
    ['a hand parser with no formats', { handParsers: [{ source: 'a.ts', formats: [], suite: 's.ts', outOfModel: 'x' }] }, /handParsers\[0\]: "formats" must be a non-empty list/],
    ['a hand parser in a format with no oracle', { oracles: { yaml: 'js-yaml' } }, /handParsers\[0\]: "markdown" has no entry in "oracles"/],
    ['a hand parser saying nothing of what it leaves out', { handParsers: [{ source: 'a.ts', formats: ['yaml'], suite: 's.ts' }] }, /handParsers\[0\]: "outOfModel" must be a non-empty string/],
    ['an outOfModel shorter than minNoteLength', { minNoteLength: 21, handParsers: [{ source: 'a.ts', formats: ['yaml'], suite: 's.ts', outOfModel: 'lists' }] }, /handParsers\[0\]: "outOfModel" is shorter than minNoteLength \(21\)/],
    ['an LF-only suite with no reason', { handParsers: [{ source: 'a.ts', formats: ['yaml'], suite: 's.ts', outOfModel: 'x', lfOnly: ' ' }] }, /handParsers\[0\]: "lfOnly" must be a non-empty string/],
    ['an lfOnly shorter than minNoteLength', { minNoteLength: 21, handParsers: [{ source: 'a.ts', formats: ['yaml'], suite: 's.ts', outOfModel: 'x'.repeat(21), lfOnly: 'bash' }] }, /handParsers\[0\]: "lfOnly" is shorter than minNoteLength \(21\)/],
    ['an unknown hand-parser key', { handParsers: [{ source: 'a.ts', formats: ['yaml'], suite: 's.ts', outOfModel: 'x', why: 'y' }] }, /handParsers\[0\]: unknown key "why"/],
    ['a pair id of no known shape', { pairs: [{ id: 'a.ts#write', kind: 'round-trip', suite: 's.ts' }] }, /pairs\[0\]: "a\.ts#write" is not path#producer->consumer or path#digest/],
    ['a pair of no known kind', { pairs: [{ id: 'a.ts#digest', kind: 'other', suite: 's.ts' }] }, /pairs\[0\]: "kind" must be "round-trip" or "golden"/],
    // The kind follows from the id, so a pair cannot skip the checks its kind needs.
    ['a producer->consumer pair registered as a golden', { pairs: [{ id: 'a.ts#writeRow->readRow', kind: 'golden', suite: 's.ts' }] }, /pairs\[0\]: "kind" is "golden", but "a\.ts#writeRow->readRow" is a producer->consumer pair, which is "round-trip"/],
    ['a digest registered as a round-trip', { pairs: [{ id: 'a.ts#digest', kind: 'round-trip', suite: 's.ts' }] }, /pairs\[0\]: "kind" is "round-trip", but "a\.ts#digest" is a digest, which is "golden"/],
    ['an exemption without a reason', { exempt: [{ id: 'a.ts#yaml' }] }, /exempt\[0\]: an exemption needs a reason/],
    ['an exemption with a blank reason', { exempt: [{ id: 'a.ts#yaml', reason: '  ' }] }, /exempt\[0\]: an exemption needs a reason/],
    ['an exemption reason shorter than minNoteLength', { minNoteLength: 21, handParsers: [], exempt: [{ id: 'a.ts#yaml', reason: 'not csv' }] }, /exempt\[0\]: "reason" is shorter than minNoteLength \(21\)/],
    ['an exemption naming no id', { exempt: [{ id: 'a.ts', reason: 'r' }] }, /exempt\[0\]: "a\.ts" is not path#format or a pair id/],
    ['an id registered and exempt', { exempt: [{ id: 'scripts/md.ts#markdown', reason: 'r' }] }, /"scripts\/md\.ts#markdown" is registered or exempt more than once/],
    ['a motivation that is not a finding id', { findingIds: { motivatedBy: '^M\\d+$', example: null }, pairs: [{ id: 'a.ts#digest', kind: 'golden', suite: 's.ts', motivatedBy: 'X1' }] }, /pairs a\.ts#digest: motivatedBy: "X1" is not a finding id/],
    ['a hand-parser motivation that is not a finding id', { findingIds: { motivatedBy: '^M\\d+$', example: null }, handParsers: [{ source: 'a.ts', formats: ['yaml'], suite: 's.ts', outOfModel: 'x', motivatedBy: 'X1' }] }, /handParsers a\.ts: motivatedBy/],
    ['an example that is not a finding id', { findingIds: { motivatedBy: null, example: '^M\\d+$' }, examples: { catalogue: null, fixtures: { E: { example: 'X1', test: 'scripts/e.test.ts' } } } }, /examples\.fixtures\.E: example: "X1"/],
    ['a bad finding pattern', { findingIds: { motivatedBy: '(', example: null } }, /findingIds\.motivatedBy: "\(" is not a regular expression/],
    ['no roots', { roots: [] }, /"roots" is empty/],
    ['no collected paths', { collected: [] }, /"collected" is empty/],
    ['no baseline', { baseline: undefined }, /"baseline" must be a non-empty string/],
  ];
  for (const [label, over, message] of refusals) {
    it(`refuses ${label}`, () => {
      assert.throws(() => parseConfig(JSON.stringify(config(over))), message);
    });
  }

  it('refuses text that is not a JSON object', () => {
    assert.throws(() => parseConfig('nope'), /not JSON/);
    assert.throws(() => parseConfig('[]'), /the config must be a JSON object/);
  });
});

describe('suite wiring', () => {
  const SUITE = "import { F } from './md.ts';\nimport fc from 'fast-check';\nimport { fromMarkdown } from 'mdast-util-from-markdown';\nconst opts = { seed: SEED };\nfor (const eol of LINE_ENDINGS) {}\n";
  const PAIR = "import { writeRow, readRow } from './row.ts';\nimport fc from 'fast-check';\nconst opts = { seed: SEED };\n";
  const made: string[] = [];
  after(() => {
    for (const root of made) rmSync(root, { recursive: true, force: true });
  });
  const make = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'pariksha-codec-wiring-'));
    made.push(root);
    put(root, {
      'scripts/md.ts': 'export const F = /^```/;\n',
      'scripts/md.differential.properties.test.ts': SUITE,
      'scripts/row.ts': 'export function writeRow() {}\nexport function readRow() {}\n',
      'scripts/row.roundtrip.properties.test.ts': PAIR,
      ...files,
    });
    return root;
  };

  it('passes a suite that imports its module, the library and the oracle, with a seed and both line endings', () => {
    assert.deepEqual(checkWiring(ts, make({}), parsed()), []);
  });

  it('refuses each part a hand-parser suite lacks', () => {
    const root = make({ 'scripts/md.differential.properties.test.ts': "import { F } from '../other/md.ts';\n" });
    assert.deepEqual(checkWiring(ts, root, parsed()), [
      'hand parser scripts/md.ts: scripts/md.differential.properties.test.ts does not import scripts/md.ts',
      'hand parser scripts/md.ts: scripts/md.differential.properties.test.ts does not import fast-check',
      'hand parser scripts/md.ts: scripts/md.differential.properties.test.ts does not import mdast-util-from-markdown, the markdown reference',
      'hand parser scripts/md.ts: scripts/md.differential.properties.test.ts runs no fixed seed (seed: SEED)',
      'hand parser scripts/md.ts: scripts/md.differential.properties.test.ts runs LF only; run CRLF too (LINE_ENDINGS) or give lfOnly a reason',
    ]);
  });

  it('reads the imports of a suite, not a comment or a string that looks like one', () => {
    const commented = SUITE.replace("import { F } from './md.ts';", "// import { F } from './md.ts';").replace("import fc from 'fast-check';", "const note = \"from 'fast-check'\";");
    assert.deepEqual(checkWiring(ts, make({ 'scripts/md.differential.properties.test.ts': commented }), parsed()), [
      'hand parser scripts/md.ts: scripts/md.differential.properties.test.ts does not import scripts/md.ts',
      'hand parser scripts/md.ts: scripts/md.differential.properties.test.ts does not import fast-check',
    ]);
  });

  it('lets an LF-only suite with a reason go without CRLF, and no other', () => {
    const root = make({ 'scripts/md.differential.properties.test.ts': SUITE.replace('LINE_ENDINGS', 'LF') });
    assert.equal(checkWiring(ts, root, parsed()).length, 1);
    const lfOnly = parsed({ handParsers: [{ source: 'scripts/md.ts', formats: ['markdown'], suite: 'scripts/md.differential.properties.test.ts', outOfModel: 'x', lfOnly: 'bash reads CR as a word' }] });
    assert.deepEqual(checkWiring(ts, root, lfOnly), []);
  });

  it('refuses a missing source, a missing suite, an uncollected one and one off the surface', () => {
    const root = make({});
    rmSync(join(root, 'scripts/md.ts'));
    rmSync(join(root, 'scripts/row.roundtrip.properties.test.ts'));
    const c = parsed({ handParsers: [{ source: 'scripts/md.ts', formats: ['markdown'], suite: 'docs/md.test.ts', outOfModel: 'x' }] });
    assert.deepEqual(checkWiring(ts, root, c), [
      'hand parser scripts/md.ts: docs/md.test.ts is not on a property-suite surface (scripts/**/*.{differential,roundtrip}.properties.test.ts)',
      'hand parser scripts/md.ts: scripts/md.ts does not exist',
      'hand parser scripts/md.ts: no runner collects docs/md.test.ts',
      'hand parser scripts/md.ts: the suite docs/md.test.ts does not exist',
      'pair scripts/row.ts#writeRow->readRow: the suite scripts/row.roundtrip.properties.test.ts does not exist',
    ]);
  });

  it('refuses a round-trip suite with no library or seed, or off the surface', () => {
    const root = make({ 'scripts/row.test.ts': "import { writeRow } from './row.ts';\n" });
    const c = parsed({ pairs: [{ id: 'scripts/row.ts#writeRow->readRow', kind: 'round-trip', suite: 'scripts/row.test.ts' }] });
    assert.deepEqual(checkWiring(ts, root, c), [
      'pair scripts/row.ts#writeRow->readRow: scripts/row.test.ts is not on a property-suite surface (scripts/**/*.{differential,roundtrip}.properties.test.ts)',
      'pair scripts/row.ts#writeRow->readRow: scripts/row.test.ts does not import fast-check',
      'pair scripts/row.ts#writeRow->readRow: scripts/row.test.ts runs no fixed seed (seed: SEED)',
    ]);
  });

  it('holds a golden to its assertion only, on any surface', () => {
    const root = make({ 'scripts/digest.ts': '', 'scripts/digest.test.ts': "import { key } from './digest.ts';\nassertGolden(key());\n", 'scripts/bare.test.ts': "import { key } from './digest.ts';\n" });
    assert.deepEqual(checkWiring(ts, root, parsed({ pairs: [{ id: 'scripts/digest.ts#digest', kind: 'golden', suite: 'scripts/digest.test.ts' }] })), []);
    assert.deepEqual(checkWiring(ts, root, parsed({ pairs: [{ id: 'scripts/digest.ts#digest', kind: 'golden', suite: 'scripts/bare.test.ts' }] })), ['pair scripts/digest.ts#digest: scripts/bare.test.ts pins no golden (assertGolden)']);
  });

  it('puts a suite anywhere when the surface check is opted out with null', () => {
    const root = make({ 'scripts/row.test.ts': PAIR });
    assert.deepEqual(checkWiring(ts, root, parsed({ surfaces: null, pairs: [{ id: 'scripts/row.ts#writeRow->readRow', kind: 'round-trip', suite: 'scripts/row.test.ts' }] })), []);
  });

  it('names no repository’s check ids in its messages, only the kind', () => {
    const root = make({ 'scripts/md.differential.properties.test.ts': '' });
    for (const line of checkWiring(ts, root, parsed())) assert.match(line, /^(?:hand parser|pair) scripts\//);
  });
});

describe('findings', () => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-codec-findings-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const c = parsed({ handParsers: [], pairs: [], exempt: [{ id: 'scripts/gone.ts#yaml', reason: 'r' }] });

  it('names a registered or exempt id discovery no longer finds, the unaccounted, the stale and the grown', () => {
    const found = { handParsers: ['scripts/a.ts#yaml'], pairs: [] };
    assert.deepEqual(findings(ts, root, c, found, { handParsers: ['scripts/old.ts#yaml'], pairs: [] }, ['scripts/old.ts#yaml']), [
      'scripts/gone.ts#yaml: registered or exempt, but discovery does not find it; drop the entry, or fix what it names',
      'scripts/a.ts#yaml: discovered and unaccounted; register a suite for it, or exempt it with a reason',
      'scripts/old.ts#yaml: in baseline.json, but registered, exempt, gone or in the wrong list; remove it from the baseline',
      'scripts/old.ts#yaml: added to baseline.json since the merge base; the baseline only shrinks, so register a suite instead',
    ]);
  });

  it('checks the catalogue examples when the config names them', () => {
    const withExamples = parsed({ handParsers: [], pairs: [], examples: { catalogue: null, fixtures: { 'EDGE-12': { example: 'V1', test: 'scripts/e.test.ts' } } } });
    assert.deepEqual(findings(ts, root, withExamples, { handParsers: [], pairs: [] }, { handParsers: [], pairs: [] }, []), ['scripts/e.test.ts: the EDGE-12 example suite does not exist']);
  });

  it('summarises a clean run, says what it did not check, and lists a failing one', () => {
    const found = { handParsers: ['a#yaml'], pairs: ['b#digest'] };
    assert.deepEqual(formatFindings([], found, { handParsers: ['a#yaml'], pairs: [] }, [], true).out, [
      'pariksha codec-registry: 1 hand parser(s) and 1 pair(s) discovered, each registered, exempt or among the 1 baselined; the baseline does not grow',
    ]);
    assert.deepEqual(formatFindings([], found, { handParsers: [], pairs: [] }, ['surfaces', 'baseline growth (--no-base)'], false).out, [
      'pariksha codec-registry: 1 hand parser(s) and 1 pair(s) discovered, each registered, exempt or among the 0 baselined',
      'pariksha codec-registry: not checked: surfaces, baseline growth (--no-base)',
    ]);
    assert.deepEqual(formatFindings(['x'], found, {}, [], true).err, ['pariksha codec-registry: x', 'pariksha codec-registry: 1 problem(s). Register a suite for a discovered parser or pair, or exempt it with a reason; the baseline only shrinks.']);
  });
});