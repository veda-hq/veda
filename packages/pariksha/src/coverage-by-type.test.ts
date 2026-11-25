import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  categoryOf,
  DEFAULT_CONFIG,
  entries,
  findGaps,
  formatGaps,
  ImportWalk,
  isExcluded,
  listedPaths,
  moduleSpecifiers,
  parseConfig,
  treePaths,
  type Config,
} from './coverage-by-type.ts';
import { loadTypescript, type Ts } from './typescript.ts';

const loaded = loadTypescript();
if (typeof loaded === 'string') throw new Error(loaded);
const ts: Ts = loaded;

const temps: string[] = [];
/** A fresh temporary directory, removed when this file's tests end. */
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A directory with these files written, its path returned. */
const tree = (files: Record<string, string>): string => {
  const root = temp('pariksha-cov-');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

const specs = (source: string, fileName?: string) => moduleSpecifiers(ts, source, fileName);
const reaches = (root: string, test: string, subject: string, config: Config = DEFAULT_CONFIG) =>
  new ImportWalk(ts, config).reaches(join(root, test), join(root, subject));

describe('moduleSpecifiers', () => {
  it('reads static, dynamic, require and importActual forms', () => {
    const src = [
      "import a from './a';",
      "export { b } from './b';",
      "const c = await import('./c');",
      "const d = require(`./d`);",
      "const e = await vi.importActual<typeof import('./e')>('./e');",
      "jest.requireActual('./f');",
    ].join('\n');
    assert.deepEqual(specs(src), ['./a', './b', './c', './d', './e', './f']);
  });

  it('drops what is erased: import type, all-type named clauses, export type, type positions', () => {
    const src = [
      "import type { A } from './a';",
      "import { type B } from './b';",
      "export type { C } from './c';",
      "export { type D } from './d';",
      "let x: typeof import('./e');",
    ].join('\n');
    assert.deepEqual(specs(src), []);
  });

  it('keeps mixed, default-with-type, namespace, side-effect and export-star forms', () => {
    const src = [
      "import { type A, a } from './mixed';",
      "import def, { type T } from './def';",
      "import * as ns from './ns';",
      "import './side';",
      "export * from './star';",
      "export { e, type E } from './mixed-export';",
    ].join('\n');
    assert.deepEqual(specs(src), ['./mixed', './def', './ns', './side', './star', './mixed-export']);
  });

  it('keeps `export * as ns from`, drops `export type * from`', () => {
    assert.deepEqual(specs("export * as ns from './ns';\nexport type * from './types';"), ['./ns']);
  });

  it('skips templates with substitutions, quoted words, other callees and local export lists', () => {
    const src = ["const n = 'x'; require(`./${n}`);", "const s = './not-an-import';", "load('./nope');", 'const z = 1; export { z };', 'require();'].join('\n');
    assert.deepEqual(specs(src), []);
  });

  it('parses JSX in a .tsx file and keeps the <T> assertion in a .ts file', () => {
    assert.deepEqual(specs("import A from './a';\nconst el = <A />;", 'x.tsx'), ['./a']);
    assert.deepEqual(specs("const v = <string>require('./b');", 'x.ts'), ['./b']);
    assert.deepEqual(specs("import A from './a';\nconst el = <A />;"), ['./a']);
  });
});

describe('ImportWalk', () => {
  it('counts a suite that imports its subject, with or without an extension', () => {
    const root = tree({ 'src/s.ts': 'export const s = 1;', 'src/s.test.ts': "import { s } from './s';", 'src/t.ts': '', 'src/t.test.ts': "import './t.js';" });
    assert.equal(reaches(root, 'src/s.test.ts', 'src/s.ts'), true);
    assert.equal(reaches(root, 'src/t.test.ts', 'src/t.ts'), true);
  });

  it('refuses a suite that only shares its subject’s name, imports nothing, or imports only types', () => {
    const root = tree({
      'src/s.ts': '',
      'src/other.ts': '',
      'src/name.test.ts': "import { o } from './other';",
      'src/empty.test.ts': 'it("x", () => {});',
      'src/types.test.ts': "import type { S } from './s';",
    });
    assert.equal(reaches(root, 'src/name.test.ts', 'src/s.ts'), false);
    assert.equal(reaches(root, 'src/empty.test.ts', 'src/s.ts'), false);
    assert.equal(reaches(root, 'src/types.test.ts', 'src/s.ts'), false);
  });

  it('follows one hop (a barrel, a collaborator) and stops at two', () => {
    const root = tree({
      'src/s.ts': '',
      'src/index.ts': "export * from './s';",
      'src/barrel.test.ts': "import './index';",
      'src/mid.ts': "import './index';",
      'src/far.test.ts': "import './mid';",
    });
    assert.equal(reaches(root, 'src/barrel.test.ts', 'src/s.ts'), true);
    assert.equal(reaches(root, 'src/far.test.ts', 'src/s.ts'), false);
    assert.equal(reaches(root, 'src/far.test.ts', 'src/s.ts', { ...DEFAULT_CONFIG, maxHops: 2 }), true);
  });

  it('does not let a type-only hop carry the walk, and survives a cycle', () => {
    const root = tree({
      'src/s.ts': '',
      'src/hop.ts': "import type { S } from './s';",
      'src/via-type.test.ts': "import './hop';",
      'src/a.ts': "import './b';",
      'src/b.ts': "import './a';",
      'src/cycle.test.ts': "import './a';",
    });
    assert.equal(reaches(root, 'src/via-type.test.ts', 'src/s.ts'), false);
    assert.equal(reaches(root, 'src/cycle.test.ts', 'src/s.ts', { ...DEFAULT_CONFIG, maxHops: 5 }), false);
  });

  it('follows a configured alias to the workspace directory, and no other', () => {
    const files = { 'app/package.json': '{}', 'app/src/lib/s.ts': '', 'app/src/x.test.ts': "import '@/lib/s';", 'app/src/y.test.ts': "import '~/lib/s';" };
    const root = tree(files);
    const config = { ...DEFAULT_CONFIG, aliases: new Map([['@/', 'src']]) };
    assert.equal(reaches(root, 'app/src/x.test.ts', 'app/src/lib/s.ts', config), true);
    assert.equal(reaches(root, 'app/src/y.test.ts', 'app/src/lib/s.ts', config), false);
    assert.equal(reaches(root, 'app/src/x.test.ts', 'app/src/lib/s.ts'), false);
  });

  it('follows no alias outside any workspace', () => {
    const root = tree({ 'src/s.ts': '', 'src/x.test.ts': "import '@/s';" });
    assert.equal(reaches(root, 'src/x.test.ts', 'src/s.ts', { ...DEFAULT_CONFIG, aliases: new Map([['@/', 'src']]) }), false);
  });

  it('resolves a directory import to its index, and skips packages and missing files', () => {
    const root = tree({
      'src/feature/index.ts': "export * from './s';",
      'src/feature/s.ts': '',
      'src/dir.test.ts': "import './feature';",
      'src/idx.test.ts': "import './feature';",
      'src/pkg.test.ts': "import 'react'; import './missing';",
    });
    assert.equal(reaches(root, 'src/dir.test.ts', 'src/feature/s.ts'), true);
    assert.equal(reaches(root, 'src/idx.test.ts', 'src/feature/index.ts'), true);
    assert.equal(reaches(root, 'src/pkg.test.ts', 'src/feature/s.ts'), false);
  });
});

describe('categoryOf and isExcluded', () => {
  it('takes the first matching category', () => {
    assert.equal(categoryOf(DEFAULT_CONFIG, 'apps/x/src/services/a.ts'), 'service');
    assert.equal(categoryOf(DEFAULT_CONFIG, 'apps/x/src/repositories/r.ts'), 'repository');
    assert.equal(categoryOf(DEFAULT_CONFIG, 'apps/x/src/components/C.tsx'), 'component');
    assert.equal(categoryOf(DEFAULT_CONFIG, 'apps/x/src/hooks/useThing.ts'), 'hook');
    assert.equal(categoryOf(DEFAULT_CONFIG, 'apps/x/src/plain/a.ts'), undefined);
  });

  it('excludes tests, declarations, configs, barrels, types and mocks', () => {
    for (const p of ['a/lib/x.test.ts', 'a/lib/x.d.ts', 'a/vite.config.ts', 'a/lib/index.ts', 'a/lib/x.types.ts', 'a/types/x.ts', 'a/__mocks__/x.ts', 'a/e2e/x.ts']) {
      assert.equal(isExcluded(DEFAULT_CONFIG, p), true, p);
    }
    assert.equal(isExcluded(DEFAULT_CONFIG, 'a/lib/x.ts'), false);
  });
});

describe('findGaps', () => {
  const root = tree({
    'app/services/ok.ts': '',
    'app/services/ok.test.ts': "import './ok';",
    'app/services/named.ts': '',
    'app/services/named.test.ts': "import './ok';",
    'app/services/bare.ts': '',
    'app/repositories/repo.ts': '',
    'app/repositories/repo.test.ts': "import './repo';",
    'app/repositories/__tests__/integration/repo.test.ts': "import '../../repo';",
    'app/repositories/half.ts': '',
    'app/repositories/half.integration.test.ts': "import './half';",
    'app/components/Card.tsx': '',
    'app/components/__tests__/Card.test.tsx': "import '../Card';",
    'app/components/Old.tsx': '',
    'app/components/Old.test.ts': "import './Old';",
    'app/services/index.ts': '',
    'app/plain/x.ts': '',
    'README.md': '',
  });
  const paths = [
    'app/services/ok.ts',
    'app/services/named.ts',
    'app/services/bare.ts',
    'app/repositories/repo.ts',
    'app/repositories/half.ts',
    'app/components/Card.tsx',
    'app/components/Old.tsx',
    'app/services/index.ts',
    'app/plain/x.ts',
    'README.md',
  ];

  it('reports each file missing a kind its category needs, counting only files judged', () => {
    assert.deepEqual(findGaps(ts, DEFAULT_CONFIG, root, paths), {
      gaps: [
        { file: 'app/services/named.ts', category: 'service', missing: ['unit'] },
        { file: 'app/services/bare.ts', category: 'service', missing: ['unit'] },
        { file: 'app/repositories/half.ts', category: 'repository', missing: ['unit'] },
        { file: 'app/components/Old.tsx', category: 'component', missing: ['ui'] },
      ],
      judged: 7,
      listed: 10,
    });
  });

  it('reads a $ in a path as text and a template with no {dir} from the root', () => {
    const r2 = tree({ 'app/components/$$x.tsx': '', 'app/components/$$x.test.tsx': "import './$$x';", 'app/services/s.ts': '', 's.test.ts': "import './app/services/s';" });
    assert.deepEqual(findGaps(ts, DEFAULT_CONFIG, r2, ['app/components/$$x.tsx']).gaps, []);
    const flat = { ...DEFAULT_CONFIG, tests: new Map([...DEFAULT_CONFIG.tests, ['unit', ['{name}.test.ts']]]) };
    assert.deepEqual(findGaps(ts, flat, r2, ['app/services/s.ts']).gaps, []);
  });

  it('formats a pass and a failure, grouped by category with the hint last', () => {
    assert.deepEqual(formatGaps(DEFAULT_CONFIG, { gaps: [], judged: 2, listed: 3 }), { ok: true, out: ['pariksha coverage-by-type: 2 of 3 listed file(s) judged, each has the tests its category needs'], err: [] });
    const r = formatGaps({ ...DEFAULT_CONFIG, hint: 'See docs/testing.' }, findGaps(ts, DEFAULT_CONFIG, root, paths));
    assert.equal(r.ok, false);
    assert.deepEqual(r.err, [
      'pariksha coverage-by-type: service (needs: unit tests)',
      '  app/services/named.ts: missing unit',
      '  app/services/bare.ts: missing unit',
      'pariksha coverage-by-type: repository (needs: unit, integration tests)',
      '  app/repositories/half.ts: missing unit',
      'pariksha coverage-by-type: component (needs: ui tests)',
      '  app/components/Old.tsx: missing ui',
      '',
      'pariksha coverage-by-type: 4 file(s) missing required tests. A suite counts only when it imports its subject at runtime.',
      'See docs/testing.',
    ]);
  });
});

describe('parseConfig', () => {
  it('replaces only the keys it names', () => {
    const c = parseConfig(JSON.stringify({ exclude: ['^scripts/'], aliases: { '@/': 'src' }, hint: 'h', maxHops: 0 }));
    assert.deepEqual(
      c.exclude.map((r) => r.source),
      ['^scripts\\/'],
    );
    assert.deepEqual([...c.aliases], [['@/', 'src']]);
    assert.equal(c.maxHops, 0);
    assert.equal(c.hint, 'h');
    assert.equal(c.categories, DEFAULT_CONFIG.categories);
    const full = parseConfig(JSON.stringify({ categories: { lib: '/lib/' }, required: { lib: ['unit'] }, tests: { unit: ['{dir}/{name}.spec.ts'] } }));
    assert.deepEqual(
      full.categories.map(([n, r]) => [n, r.source]),
      [['lib', '\\/lib\\/']],
    );
  });

  it('refuses what would check the wrong thing', () => {
    const bad: Array<[string, RegExp]> = [
      ['nope', /not JSON/],
      ['[]', /must be a JSON object/],
      ['{"extra": 1}', /unknown key "extra"/],
      ['{"categories": {"a": 1}}', /"categories" must map names to strings/],
      ['{"required": {"a": "unit"}}', /"required" must map names to lists of strings/],
      ['{"categories": {"a": "("}}', /categories\.a: /],
      ['{"exclude": "x"}', /"exclude" must be a list of strings/],
      ['{"exclude": ["["]}', /exclude\[0\]: /],
      ['{"maxHops": -1}', /"maxHops" must be a whole number/],
      ['{"maxHops": 1.5}', /"maxHops" must be a whole number/],
      ['{"hint": 3}', /"hint" must be a string/],
      ['{"categories": {"a": "x"}}', /category "a" has no "required" entry/],
      ['{"categories": {"a": "x"}, "required": {"a": ["e2e"]}}', /requires "e2e", which "tests" does not define/],
      ['{"tests": {"unit": ["{dir}/x.test.ts"], "integration": [], "ui": []}}', /has no \{name\}/],
      ['{"categories": {}, "required": {}}', /"categories" is empty/],
      ['{"exclude": [""]}', /exclude\[0\]: an empty pattern matches every path/],
      ['{"categories": {"a": ""}, "required": {"a": ["unit"]}}', /categories\.a: an empty pattern/],
      ['{"categories": {"a": "x"}, "required": {"a": []}}', /category "a" requires no test/],
      ['{"categories": {"b": "x", "2": "y"}, "required": {"b": ["unit"], "2": ["unit"]}}', /category "2": a name that is a number/],
    ];
    for (const [text, message] of bad) assert.throws(() => parseConfig(text), message, text);
  });
});

describe('entries, treePaths and listedPaths', () => {
  it('splits lines (LF or CRLF) or NULs, dropping blanks and a BOM', () => {
    assert.deepEqual(entries('﻿a.ts\r\nb.ts\n\n'), ['a.ts', 'b.ts']);
    assert.deepEqual(entries('a.ts\0b\nc.ts\0'), ['a.ts', 'b\nc.ts']);
    assert.deepEqual(entries(''), []);
  });

  it('keeps tracked regular files only: no deleted file, no symlink', () => {
    const root = tree({ 'app/services/real.ts': '' });
    symlinkSync('real.ts', join(root, 'app/services/link.ts'));
    assert.deepEqual(treePaths(root, 'app/services/real.ts\0app/services/link.ts\0app/services/gone.ts\0'), ['app/services/real.ts']);
  });

  it('reads relative and absolute entries against the real root, skipping symlinks and directories', () => {
    const root = realpathSync(tree({ 'scripts/services/tool.ts': '', 'app/services/s.ts': '' }));
    symlinkSync('s.ts', join(root, 'app/services/link.ts'));
    const alias = join(temp('pariksha-alias-'), 'checkout');
    symlinkSync(root, alias);
    const listed = listedPaths(root, [join(alias, 'scripts/services/tool.ts'), 'app/services/s.ts', 'app/services/link.ts', 'app'].join('\n'));
    assert.deepEqual(listed, ['scripts/services/tool.ts', 'app/services/s.ts']);
  });

  it('refuses an entry naming nothing or outside the root', () => {
    const root = tree({ 'a.ts': '' });
    const other = tree({ 'b.ts': '' });
    assert.throws(() => listedPaths(root, 'ghost.ts'), /listed file ghost\.ts does not exist/);
    assert.throws(() => listedPaths(root, join(other, 'b.ts')), /is outside/);
    assert.throws(() => listedPaths(root, 'a.ts/x'), /does not exist/);
    // Any other stat failure is raised as itself, never read as "no such file".
    assert.throws(() => listedPaths(root, 'x'.repeat(300)), /ENAMETOOLONG/);
  });

  it('skips a listed symlink before asking where it is, and refuses the root’s parent', () => {
    const root = realpathSync(tree({ 'a.ts': '' }));
    const other = realpathSync(tree({ 'b.ts': '' }));
    symlinkSync(join(other, 'b.ts'), join(other, 'link.ts'));
    assert.deepEqual(listedPaths(root, join(other, 'link.ts')), []);
    assert.throws(() => listedPaths(root, '..'), /listed file \.\. is outside/);
  });
});

describe('the default vocabulary', () => {
  it('reads each category by its folder, singular or plural, to the end of the path', () => {
    const cases: ReadonlyArray<readonly [string, string | undefined]> = [
      ['a/domain/d.ts', 'service'],
      // `repositories?` makes only the last `s` optional: it reads `repositorie/`, never `repository/`.
      ['a/repositorie/r.ts', 'repository'],
      ['a/repository/r.ts', undefined],
      ['a/component/C.tsx', 'component'],
      ['a/screen/S.tsx', 'screen'],
      ['a/screens/Home.tsx', 'screen'],
      ['a/hook/useThing.ts', 'hook'],
      ['a/utils/format.ts', 'utility'],
      ['a/context/Auth.tsx', 'context'],
      ['a/services/x.ts.md', undefined],
      ['a/repositories/x.ts.md', undefined],
      ['a/components/C.tsx.md', undefined],
      ['a/screens/S.tsx.md', undefined],
      ['a/hooks/useThing.ts.md', undefined],
      ['a/utils/x.ts.md', undefined],
      ['a/context/A.tsx.md', undefined],
    ];
    for (const [path, category] of cases) assert.equal(categoryOf(DEFAULT_CONFIG, path), category, path);
  });

  it('excludes by a name’s end, and a types folder at the root', () => {
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ['a/lib/x.test.ts.md', false],
      ['a/lib/x.d.ts.md', false],
      ['a/lib/x.config.ts.md', false],
      ['a/lib/index.ts.md', false],
      ['a/lib/x.types.ts.md', false],
      ['a/lib/x.type.ts', true],
      ['types/x.ts', true],
    ];
    for (const [path, excluded] of cases) assert.equal(isExcluded(DEFAULT_CONFIG, path), excluded, path);
  });

  it('looks for each kind of test where the defaults say', () => {
    assert.deepEqual(
      DEFAULT_CONFIG.tests,
      new Map([
        [
          'unit',
          [
            '{dir}/{name}.test.ts',
            '{dir}/{name}.test.tsx',
            '{dir}/__tests__/{name}.test.ts',
            '{dir}/__tests__/{name}.test.tsx',
            '{dir}/test/{name}.test.ts',
            '{dir}/test/{name}.test.tsx',
            '{dir}/tests/{name}.test.ts',
            '{dir}/tests/{name}.test.tsx',
          ],
        ],
        [
          'integration',
          [
            '{dir}/{name}.integration.test.ts',
            '{dir}/{name}.integration.test.tsx',
            '{dir}/__tests__/integration/{name}.test.ts',
            '{dir}/__tests__/integration/{name}.test.tsx',
            '{dir}/test/integration/{name}.test.ts',
            '{dir}/test/integration/{name}.test.tsx',
            '{dir}/tests/integration/{name}.test.ts',
            '{dir}/tests/integration/{name}.test.tsx',
          ],
        ],
        ['ui', ['{dir}/{name}.test.tsx', '{dir}/__tests__/{name}.test.tsx', '{dir}/test/{name}.test.tsx', '{dir}/tests/{name}.test.tsx']],
      ]),
    );
  });
});

describe('parseConfig edges', () => {
  it('refuses a config that is no object, and lists that hold anything but strings', () => {
    const bad: Array<[string, RegExp]> = [
      ['null', /must be a JSON object/],
      ['"x"', /must be a JSON object/],
      ['{"exclude": [1]}', /"exclude" must be a list of strings/],
      ['{"required": {"service": ["unit"], "b": "x"}}', /"required" must map names to lists of strings/],
      ['{"maxHops": "1"}', /"maxHops" must be a whole number/],
      ['{"categories": {"b": "x", "12": "y"}, "required": {"b": ["unit"], "12": ["unit"]}}', /category "12": a name that is a number/],
    ];
    for (const [text, message] of bad) assert.throws(() => parseConfig(text), message, text);
  });

  it('reads a name only as a number when it is one whole', () => {
    const c = parseConfig('{"categories": {"1a": "x", "a1": "y"}, "required": {"1a": ["unit"], "a1": ["unit"]}}');
    assert.deepEqual(
      c.categories.map(([name]) => name),
      ['1a', 'a1'],
    );
  });
});

describe('moduleSpecifiers edges', () => {
  it('parses as TSX by default, and reads only string specifiers', () => {
    assert.deepEqual(specs("const v = <string>require('./b');"), []);
    assert.deepEqual(specs('const x = require(name);\nimport a from b;'), []);
  });
});

describe('ImportWalk edges', () => {
  it('reads each file once per walk', () => {
    const root = tree({ 'src/s.ts': '', 'src/s.test.ts': "import './s';" });
    const walk = new ImportWalk(ts, DEFAULT_CONFIG);
    assert.equal(walk.reaches(join(root, 'src/s.test.ts'), join(root, 'src/s.ts')), true);
    writeFileSync(join(root, 'src/s.test.ts'), '');
    assert.equal(walk.reaches(join(root, 'src/s.test.ts'), join(root, 'src/s.ts')), true);
    assert.equal(reaches(root, 'src/s.test.ts', 'src/s.ts'), false);
  });

  it('walks a cycle once, however many hops are allowed', () => {
    const root = tree({ 'src/s.ts': '', 'src/c.test.ts': "import './a';", 'src/a.ts': "import './b';", 'src/b.ts': "import './a';\nimport './c.test';" });
    const probes = (maxHops: number): number => {
      let asked = 0;
      const walk = new ImportWalk(ts, { ...DEFAULT_CONFIG, maxHops }, (path) => {
        asked += 1;
        return existsSync(path);
      });
      assert.equal(walk.reaches(join(root, 'src/c.test.ts'), join(root, 'src/s.ts')), false);
      return asked;
    };
    // One probe each for a.ts and b.ts, then one for each of b's imports: a.ts again and c.test.ts, the way back to the test.
    assert.equal(probes(2), 4);
    assert.equal(probes(50), 4);
  });

  it('counts a suite that imports its subject by name, even before the subject exists', () => {
    const root = tree({ 'src/t.test.ts': "import './ghost';" });
    assert.equal(reaches(root, 'src/t.test.ts', 'src/ghost.ts'), true);
  });

  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']) {
    it(`follows an import with no extension to a ${ext} module, and to a folder's index${ext}`, () => {
      const root = tree({ [`src/x${ext}`]: '', [`src/d/index${ext}`]: '', 'src/hop.test.ts': "import './x';\nimport './d';" });
      assert.equal(reaches(root, 'src/hop.test.ts', `src/x${ext}`), true);
      assert.equal(reaches(root, 'src/hop.test.ts', `src/d/index${ext}`), true);
      assert.equal(reaches(root, 'src/hop.test.ts', 'src/y.ts'), false);
    });
  }
});

describe('findGaps and formatGaps edges', () => {
  it('judges only .ts and .tsx paths, whatever the categories match', () => {
    const config = { ...DEFAULT_CONFIG, categories: [['service', /\/services\//]] as const };
    assert.deepEqual(findGaps(ts, config, tree({}), ['app/services/x.ts.md']), { gaps: [], judged: 0, listed: 1 });
  });

  it('finds no gap where a category requires nothing', () => {
    const root = tree({ 'app/services/bare.ts': '' });
    assert.deepEqual(findGaps(ts, { ...DEFAULT_CONFIG, required: new Map() }, root, ['app/services/bare.ts']), { gaps: [], judged: 1, listed: 1 });
  });

  it('lists every missing kind, with no hint when the config has none', () => {
    assert.deepEqual(formatGaps(DEFAULT_CONFIG, { gaps: [{ file: 'a/repositories/r.ts', category: 'repository', missing: ['unit', 'integration'] }], judged: 1, listed: 2 }), {
      ok: false,
      out: [],
      err: [
        'pariksha coverage-by-type: repository (needs: unit, integration tests)',
        '  a/repositories/r.ts: missing unit, integration',
        '',
        'pariksha coverage-by-type: 1 file(s) missing required tests. A suite counts only when it imports its subject at runtime.',
      ],
    });
    assert.equal(formatGaps({ ...DEFAULT_CONFIG, required: new Map() }, { gaps: [{ file: 'x.ts', category: 'odd', missing: ['unit'] }], judged: 1, listed: 1 }).err[0], 'pariksha coverage-by-type: odd (needs:  tests)');
  });
});
