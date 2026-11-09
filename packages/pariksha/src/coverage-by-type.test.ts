import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  categoryOf,
  DEFAULT_CONFIG,
  findGaps,
  formatGaps,
  ImportWalk,
  isExcluded,
  loadTypescript,
  moduleSpecifiers,
  parseConfig,
  type Config,
  type Ts,
} from './coverage-by-type.ts';

const loaded = loadTypescript();
if (typeof loaded === 'string') throw new Error(loaded);
const ts: Ts = loaded;

/** A directory with these files written, its path returned. */
const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-cov-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

const specs = (source: string, fileName?: string) => moduleSpecifiers(ts, source, fileName);
const reaches = (root: string, test: string, subject: string, config: Config = DEFAULT_CONFIG) =>
  new ImportWalk(ts, config).reaches(join(root, test), join(root, subject));

describe('loadTypescript', () => {
  it('names the package when it is not installed', () => {
    const r = loadTypescript(() => {
      throw new Error('Cannot find module');
    });
    assert.equal(r, 'needs the typescript package (>=5.4 <6); install it beside pariksha');
  });

  it('refuses a typescript with no compiler API, naming its version', () => {
    assert.match(String(loadTypescript(() => ({ version: '7.0.2' }))), /typescript 7\.0\.2 does not export; install typescript >=5\.4 <6/);
  });
});

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

  it('reports each file missing a kind its category needs', () => {
    assert.deepEqual(findGaps(ts, DEFAULT_CONFIG, root, paths), [
      { file: 'app/services/named.ts', category: 'service', missing: ['unit'] },
      { file: 'app/services/bare.ts', category: 'service', missing: ['unit'] },
      { file: 'app/repositories/half.ts', category: 'repository', missing: ['unit'] },
      { file: 'app/components/Old.tsx', category: 'component', missing: ['ui'] },
    ]);
  });

  it('formats a pass and a failure, grouped by category with the hint last', () => {
    assert.deepEqual(formatGaps(DEFAULT_CONFIG, [], 3), { ok: true, out: ['pariksha coverage-by-type: 3 file(s) checked, each has the tests its category needs'], err: [] });
    const r = formatGaps({ ...DEFAULT_CONFIG, hint: 'See docs/testing.' }, findGaps(ts, DEFAULT_CONFIG, root, paths), paths.length);
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
    ];
    for (const [text, message] of bad) assert.throws(() => parseConfig(text), message, text);
  });
});
