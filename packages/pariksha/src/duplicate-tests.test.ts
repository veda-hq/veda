import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type * as TS from 'typescript';
import {
  areOppositeScenarios,
  areSameFileComplementary,
  compositeSimilarity,
  DEFAULT_CONFIG,
  extractTestName,
  extractTestSignatures,
  findDuplicates,
  parseConfig,
  patternSimilarity,
  runDuplicateTests,
  stringSimilarity,
  type Config,
  type TestSignature,
} from './duplicate-tests.ts';
import { loadTypescript, type Ts } from './typescript.ts';

const loaded = loadTypescript();
if (typeof loaded === 'string') throw new Error(loaded);
const ts: Ts = loaded;

const signatures = (file: string, content: string): TestSignature[] => extractTestSignatures(ts, file, content).signatures;
const dups = (sigs: TestSignature[], config: Config = DEFAULT_CONFIG) => findDuplicates(config, sigs);

/** The name the first call in `describe(<arg>, () => {})` gives. */
const nameOf = (arg: string): string => {
  const source = `describe(${arg}, () => {})`;
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = sf.statements[0] as TS.ExpressionStatement;
  return extractTestName(ts, sf, statement.expression as TS.CallExpression);
};

const repositoryTestFile = (describeArg: string, table: string, req: string): string => `
import { describe, expect, it } from 'vitest';

describe(${describeArg}, () => {
  it('enqueues with INSERT OR IGNORE keyed on idempotency_key (${req})', () => {
    const sql = 'INSERT OR IGNORE INTO ${table}';
    expect(sql).toContain('INSERT OR IGNORE');
    expect(sql).toContain('${table}');
    expect(sql).toMatch(/idempotency/);
  });
});
`;

describe('extractTestName', () => {
  it('names `describe(X.name)` after X, keeping the object path of a longer chain', () => {
    assert.equal(nameOf('AttendanceSyncRepository.name'), 'AttendanceSyncRepository');
    assert.equal(nameOf('Repo.prototype.enqueue.name'), 'Repo.prototype.enqueue');
    assert.equal(nameOf('(Repo).name'), 'Repo');
  });

  it('returns the source text of other non-literal arguments', () => {
    assert.equal(nameOf("Repo['name']"), "Repo['name']");
    assert.equal(nameOf('titleFor(Repo)'), 'titleFor(Repo)');
    assert.equal(nameOf('`${Repo.name} sync`'), '`${Repo.name} sync`');
    assert.equal(nameOf('Repo?.name'), 'Repo?.name');
    assert.equal(nameOf('Repo.other'), 'Repo.other');
    assert.equal(nameOf('((a, b))'), 'a, b');
  });

  it('reads literal names as their value', () => {
    assert.equal(nameOf("'EventSyncRepositoryImpl'"), 'EventSyncRepositoryImpl');
    assert.equal(nameOf('`plain template`'), 'plain template');
    assert.equal(nameOf("('wrapped')"), 'wrapped');
  });

  it('falls back to the placeholder only when there is no argument', () => {
    const sf = ts.createSourceFile('x.ts', 'describe()', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const statement = sf.statements[0] as TS.ExpressionStatement;
    assert.equal(extractTestName(ts, sf, statement.expression as TS.CallExpression), 'unnamed test');
  });
});

const body = 'expect(a).toBe(1); expect(b).toEqual(2); expect(c).toMatch(/x/);';

describe('extractTestSignatures', () => {
  it('reads each test with an assertion, under its describe path, at its line', () => {
    const sigs = signatures('a.test.ts', `\ndescribe('A', () => {\n  it('one', () => { ${body} });\n  describe('B', () => {\n    test('two', () => { expect(x).toBe(1); });\n  });\n  it('none', () => { run(); });\n});\nit('top', () => { expect(y).toStrictEqual(z); });\n`);
    assert.deepEqual(sigs, [
      { file: 'a.test.ts', testName: 'one', describePath: ['A'], assertionPattern: ['toBe', 'expect()', 'toEqual', 'expect()', 'toMatch', 'expect()'], line: 3 },
      { file: 'a.test.ts', testName: 'two', describePath: ['A', 'B'], assertionPattern: ['toBe', 'expect()'], line: 5 },
      { file: 'a.test.ts', testName: 'top', describePath: [], assertionPattern: ['toStrictEqual', 'expect()'], line: 9 },
    ]);
  });

  it('counts the calls a Babel CallExpression visitor reaches, and no optional-chain call', () => {
    const [sig] = signatures('o.test.ts', `it('o', () => { ${body} expect(a)?.toBe(1); a?.b.toEqual(1); expect?.(1); (a?.b).toX(); (a?.toY)(); (expect(a).toBe)(1); ((expect))(1); a[toZ](); a['toW'](); a[(toV)](); super.toString(); a.notTo(); });`);
    assert.deepEqual(sig?.assertionPattern, ['toBe', 'expect()', 'toEqual', 'expect()', 'toMatch', 'expect()', 'expect()', 'toX', 'toBe', 'expect()', 'expect()', 'toZ', 'toV', 'toString']);
  });

  it('tracks a parenthesised describe and test, a describe nested in a test, and pops each describe', () => {
    const sigs = signatures('n.test.ts', `(describe)('P', () => { (it)('p', () => { ${body} describe('Q', () => { it('q', () => { ${body} }); }); }); }); it('after', () => { ${body} });`);
    assert.deepEqual(
      sigs.map((s) => [s.testName, s.describePath]),
      [
        ['p', ['P']],
        ['q', ['P', 'Q']],
        ['after', []],
      ],
    );
  });

  it('reads `<T>(x) => x` in a .ts file as a generic arrow, and JSX in a .tsx file', () => {
    assert.equal(signatures('g.test.ts', `const p = <T>(x: T): T => x;\ndescribe('G', () => { it('g', () => { ${body} }); });`).length, 1);
    assert.equal(signatures('j.test.tsx', `describe('J', () => { it('j', () => { const el = <div onClick={() => f()}>{g()}</div>; ${body} }); });`).length, 1);
    assert.equal(signatures('g.test.js', `const p = <T,>(x) => x;\ndescribe('G', () => { it('g', () => { ${body} }); });`).length, 1);
  });

  it('reads JSX in a .ts file, as the Babel parse did', () => {
    assert.deepEqual(extractTestSignatures(ts, 'x.test.ts', `describe('X', () => { it('x', () => { const el = <div />; ${body} }); });`).signatures.length, 1);
  });

  it('gives no signatures for a file Babel could not parse: a syntax error, or a <T>value assertion in a .ts file', () => {
    assert.deepEqual(extractTestSignatures(ts, 'b.test.ts', `describe('B', () => { it('b', () => { ${body} }); ); ) ) }`), { signatures: [], parseError: 'Declaration or statement expected. (1:107)' });
    assert.deepEqual(extractTestSignatures(ts, 'a.test.ts', `describe('A', () => { it('a', () => { const v = <number>w; ${body} }); });`), {
      signatures: [],
      parseError: 'a <T>value type assertion, which a JSX parse reads as an unterminated element (1:48)',
    });
  });

  it('gives no signatures for syntax Babel had no plugin for: an accessor field, a decorator after export', () => {
    const tests = `\ndescribe('D', () => { it('d', () => { ${body} }); });`;
    assert.deepEqual(extractTestSignatures(ts, 'a.test.ts', `class K { static accessor x = 1; }${tests}`), { signatures: [], parseError: 'an accessor field, which needs the decoratorAutoAccessors parser plugin (1:10)' });
    assert.deepEqual(extractTestSignatures(ts, 'e.test.ts', `export @dec class K {}${tests}`), { signatures: [], parseError: 'a decorator after export, which legacy decorators do not take (1:0)' });
    for (const ok of ['@dec export class K {}', 'export default @dec class K {}', '@dec export default class K {}', 'const C = @dec class {};', 'export class K { accessor() {} accessor; }', 'class K { constructor(@inject() a: A) {} }']) {
      assert.equal(signatures('ok.test.ts', `${ok}${tests}`).length, 1, ok);
    }
  });

  it('counts lines as Babel does, across CRLF, CR and U+2028', () => {
    const [sig] = signatures('l.test.ts', `\r\n\r\ndescribe('L', () => {  it('l', () => {\r ${body} }); });`);
    assert.equal(sig?.line, 4);
  });
});

describe('findDuplicates with describe(X.name)', () => {
  it('does not match near-identical tests under different classes', () => {
    const sigs = [...signatures('attendance-sync-repository.test.ts', repositoryTestFile('AttendanceSyncRepository.name', 'PendingAttendanceSync', 'REQ-009')), ...signatures('event-sync-repository-impl.test.ts', repositoryTestFile('EventSyncRepositoryImpl.name', 'PendingEventSync', 'REQ-005'))];
    assert.deepEqual(
      sigs.map((s) => s.describePath),
      [['AttendanceSyncRepository'], ['EventSyncRepositoryImpl']],
    );
    assert.deepEqual(dups(sigs), []);
  });

  it('still matches near-identical tests under the same class', () => {
    const sigs = [...signatures('attendance-sync-repository.test.ts', repositoryTestFile('AttendanceSyncRepository.name', 'PendingAttendanceSync', 'REQ-009')), ...signatures('attendance-sync-repository.copy.test.ts', repositoryTestFile('AttendanceSyncRepository.name', 'PendingAttendanceSync', 'REQ-005'))];
    const matches = dups(sigs);
    assert.equal(matches.length, 1);
    assert.ok((matches[0]?.similarity ?? 0) >= 0.95);
  });
});

const renumberFile = (first: string, second: string): string => `
import { describe, expect, it } from 'vitest';

describe('rewriteRelationships', () => {
  it('${first}', () => {
    const after = rewrite('0040', '0099');
    expect(after).toContain("supersedes: '0040'");
    expect(after).toContain("related_rfc: '0099'");
  });

  it('${second}', () => {
    const after = rewrite('0040', '0099');
    expect(after).toContain("supersedes: '0099'");
    expect(after).toContain("related_rfc: '0040'");
  });
});
`;

const guardFile = (title: string): string => `
import { expect, it } from 'vitest';

it('${title}', () => {
  const run = refuse({ VITEST_MAX_WORKERS: '8' });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('Unset VITEST_MAX_WORKERS');
});
`;

describe('findDuplicates with mirrored titles in one file', () => {
  it('does not match two titles that swap the same words', () => {
    const sigs = signatures('renumber-doc.test.ts', renumberFile('does not let an RFC renumber touch an ADR-namespaced key', 'does not let an ADR renumber touch the RFC-namespaced key'));
    assert.equal(sigs.length, 2);
    assert.deepEqual(dups(sigs), []);
  });

  it('still matches two titles that differ only in filler words', () => {
    const sigs = signatures('renumber-doc.test.ts', renumberFile('does not let an RFC renumber touch an ADR-namespaced key', 'does not let the RFC renumber touch the ADR-namespaced key'));
    assert.equal(dups(sigs).length, 1);
  });

  it('does not excuse swapped titles across two files', () => {
    const sigs = [...signatures('renumber-doc.test.ts', renumberFile('mirror of RFC renumber into ADR key', 'unrelated first')), ...signatures('renumber-doc.copy.test.ts', renumberFile('mirror of ADR renumber into RFC key', 'unrelated second'))].filter((s) =>
      s.testName.startsWith('mirror'),
    );
    assert.equal(sigs.length, 2);
    assert.equal(dups(sigs).length, 1);
  });
});

describe('findDuplicates across files with no describe block', () => {
  it('does not match two differently named files', () => {
    const sigs = [
      ...signatures('scripts/performance/compare-workers.integration.test.ts', guardFile('refuses an inherited VITEST_MAX_WORKERS before any trial exists')),
      ...signatures('scripts/performance/test-shards.integration.test.ts', guardFile('refuses an inherited VITEST_MAX_WORKERS before execution')),
    ];
    assert.deepEqual(
      sigs.map((s) => s.describePath),
      [[], []],
    );
    assert.deepEqual(dups(sigs), []);
  });

  it('still matches a copy that keeps its file name', () => {
    const sigs = [
      ...signatures('scripts/performance/test-shards.integration.test.ts', guardFile('refuses an inherited VITEST_MAX_WORKERS before execution')),
      ...signatures('apps/mobile/scripts/test-shards.integration.test.ts', guardFile('refuses an inherited VITEST_MAX_WORKERS before execution')),
    ];
    const matches = dups(sigs);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.similarity, 1);
  });
});

const sig = (over: Partial<TestSignature>): TestSignature => ({ file: 'a.test.ts', testName: 'builds an order', describePath: ['Orders'], assertionPattern: ['toBe', 'expect()', 'toEqual'], line: 1, ...over });

describe('findDuplicates: what is skipped', () => {
  it('skips a test with fewer than three assertions, counting repeats', () => {
    const two = ['toBe', 'expect()'];
    assert.deepEqual(dups([sig({ assertionPattern: two }), sig({ file: 'b.test.ts', assertionPattern: two })]), []);
    const repeats = ['toBe', 'toBe', 'toBe'];
    assert.equal(dups([sig({ assertionPattern: repeats }), sig({ file: 'b.test.ts', assertionPattern: repeats })]).length, 1);
  });

  it('skips a generic name: equal to a common one, or starting with it and a space', () => {
    assert.deepEqual(dups([sig({ testName: 'Should Return ' }), sig({ file: 'b.test.ts', testName: 'should return' })]), []);
    assert.deepEqual(dups([sig({ testName: 'should return totals' }), sig({ file: 'b.test.ts', testName: 'should return totals' })]), []);
    assert.equal(dups([sig({ testName: 'should returned' }), sig({ file: 'b.test.ts', testName: 'should returned' })]).length, 1);
  });

  it('records each pair once, and holds a cross-file pair to 0.95 whatever the threshold', () => {
    const a = sig({});
    // a against the second copy has the same key as against the first; the two copies share a file and a name.
    assert.equal(dups([a, sig({ file: 'b.test.ts' }), sig({ file: 'b.test.ts', line: 9 })]).length, 1);
    const near = sig({ file: 'b.test.ts', testName: 'builds an orders' });
    const score = compositeSimilarity(a, near);
    assert.ok(score < 1 && score >= 0.95, String(score));
    const far = sig({ file: 'b.test.ts', describePath: ['Ordering'] });
    assert.ok(compositeSimilarity(a, far) < 0.95);
    assert.deepEqual(dups([a, far], { ...DEFAULT_CONFIG, threshold: 0.5 }), []);
    assert.equal(dups([a, sig({ testName: 'builds an order', describePath: ['Orderz'], line: 3 })], { ...DEFAULT_CONFIG, threshold: 0.5 }).length, 0);
  });

  it('applies the threshold within one file', () => {
    const a = sig({ testName: 'builds an order' });
    const b = sig({ testName: 'builds the order', line: 5, assertionPattern: ['toBe', 'expect()', 'toMatch'] });
    const score = compositeSimilarity(a, b);
    assert.equal(dups([a, b], { ...DEFAULT_CONFIG, threshold: score }).length, 1);
    assert.equal(dups([a, b], { ...DEFAULT_CONFIG, threshold: score + 0.01 }).length, 0);
  });
});

describe('the similarity measures', () => {
  it('scores strings by edit distance over the longer length, ignoring case', () => {
    assert.equal(stringSimilarity('', ''), 1);
    assert.equal(stringSimilarity('Abc', 'abc'), 1);
    assert.equal(stringSimilarity('kitten', 'sitting'), 1 - 3 / 7);
    assert.equal(stringSimilarity('abc', ''), 0);
  });

  it('scores matcher lists as sets', () => {
    assert.equal(patternSimilarity([], []), 0);
    assert.equal(patternSimilarity(['a', 'a', 'b'], ['b', 'c']), 1 / 3);
  });

  it('weighs matchers, name and describe path 50/20/30, with no credit when only one has a describe path', () => {
    const a = sig({});
    assert.equal(compositeSimilarity(a, sig({ describePath: [] })), 0.7);
    assert.equal(compositeSimilarity(sig({ describePath: [] }), sig({ describePath: [], file: 'x/a.copy.test.ts' })), 1);
    assert.equal(compositeSimilarity(sig({ describePath: [], file: 'a.test.ts' }), sig({ describePath: [], file: 'ab.test.ts' })), 0.7 + 0.3 * 0.5);
  });
});

describe('areOppositeScenarios', () => {
  const opposite = (a: string, b: string, config: Config = DEFAULT_CONFIG): boolean => areOppositeScenarios(config, a, b);

  it('finds an opposite pair either way round, in lowercase', () => {
    assert.equal(opposite('handles Success', 'handles failure'), true);
    assert.equal(opposite('handles failure', 'handles success'), true);
    assert.equal(opposite('handles it', 'handles them'), false);
  });

  it('matches a configured pair against lowercased names, so an uppercase pair never matches', () => {
    const config: Config = { ...DEFAULT_CONFIG, oppositePairs: [['Display', 'Box'], ['returns_v2', 'pi_v3']] };
    assert.equal(opposite('moves Display to Box', 'moves Box to Display', config), false);
    assert.equal(opposite('rolls back returns_v2', 'rolls back pi_v3', config), true);
  });

  it('tells HTTP methods and statuses apart, in any case', () => {
    assert.equal(opposite('returns 200', 'returns 404'), true);
    assert.equal(opposite('get list', 'POST list'), true);
    assert.equal(opposite('returns 200 x', 'returns 200 y'), false);
    assert.equal(opposite('returns 200', 'returns nothing'), false);
  });

  it('tells uppercase AND/OR apart, and ignores prose and/or', () => {
    assert.equal(opposite('joins with AND', 'joins with OR'), true);
    assert.equal(opposite('joins with AND OR', 'joins with AND'), true);
    assert.equal(opposite('joins with AND', 'joins with AND'), false);
    assert.equal(opposite('joins x and y', 'joins x or y'), false);
  });

  it('tells endpoints apart by the first one named', () => {
    assert.equal(opposite('serves /health', 'serves /nonexistent'), true);
    assert.equal(opposite('serves /health then /a', 'serves /health then /b'), false);
    assert.equal(opposite('serves /health', 'serves health'), false);
  });
});

describe('areSameFileComplementary', () => {
  const same = (a: string, b: string, f2 = 'a.test.ts'): boolean => areSameFileComplementary(DEFAULT_CONFIG, 'a.test.ts', f2, a, b);

  it('only judges two tests in one file', () => {
    assert.equal(same('x one', 'x two', 'b.test.ts'), false);
  });

  it('excuses opposite names, the same name, and a word only one name has', () => {
    assert.equal(same('handles success', 'handles failure'), true);
    assert.equal(same('delegates', 'delegates'), true);
    assert.equal(same('rejects zero quantity', 'rejects quantity'), true);
  });

  it('excuses the same words in another order, not names that differ only in filler', () => {
    assert.equal(same('an RFC renumber touches an ADR key', 'an ADR renumber touches the RFC key'), true);
    assert.equal(same('an RFC renumber touches an ADR key', 'the RFC renumber touches the ADR key'), false);
    assert.equal(same('it is a: b', 'it is a b!'), false);
  });
});

describe('parseConfig', () => {
  it('defaults each field, and replaces the ones given', () => {
    assert.equal(parseConfig(undefined), DEFAULT_CONFIG);
    assert.deepEqual(parseConfig('{}'), DEFAULT_CONFIG);
    const config = parseConfig('{"include":"\\\\.spec\\\\.ts$","threshold":0.9,"commonNames":["it works"],"oppositePairs":[["up","down"]]}');
    assert.deepEqual([config.include.source, config.threshold, config.commonNames, config.oppositePairs], ['\\.spec\\.ts$', 0.9, ['it works'], [['up', 'down']]]);
  });

  for (const [text, message] of [
    ['[]', 'the config is not a JSON object'],
    ['{"pairs":[]}', 'the config has unknown field(s): pairs'],
    ['{"include":1}', 'include is not a regex string'],
    ['{"threshold":"0.9"}', 'threshold is not a number'],
    ['{"commonNames":[1]}', 'commonNames is not a list of strings'],
    ['{"oppositePairs":[["a"]]}', 'oppositePairs is not a list of [word, word] pairs'],
    ['{"oppositePairs":"a"}', 'oppositePairs is not a list of [word, word] pairs'],
  ] as const) {
    it(`refuses ${text}`, () => {
      assert.throws(() => parseConfig(text), { message });
    });
  }
});

describe('runDuplicateTests', () => {
  const listed = (files: Record<string, string>) => Object.entries(files).map(([file, text]) => ({ file, path: `/repo/${file}`, read: () => text }));
  const order = (name: string): string => `describe('Orders', () => { it('${name}', () => { ${body} }); });`;

  it('says so when no file is listed, and passes', () => {
    assert.deepEqual(runDuplicateTests(ts, DEFAULT_CONFIG, 'all', []), { code: 0, out: ['🔍 Searching for duplicate tests (Threshold: 0.85)...', '   Mode: all', 'No files found to analyze.'], err: [] });
  });

  it('passes a clean set', () => {
    assert.deepEqual(runDuplicateTests(ts, DEFAULT_CONFIG, 'files', listed({ 'a.test.ts': order('handles success'), 'b.test.ts': order('handles failure') })), {
      code: 0,
      out: ['🔍 Searching for duplicate tests (Threshold: 0.85)...', '   Mode: files', '   Analyzing 2 files...', '   Extracted 2 test signatures.', '', '✅ No duplicates found.'],
      err: [],
    });
  });

  it('refuses a copied test, best match first, and warns of a file it could not read or parse', () => {
    const files = [
      ...listed({ 'a.test.ts': order('builds an order'), 'b.test.ts': order('builds an order'), 'c.test.ts': `describe('Orders', () => { it('builds an order', () => { ${body} }); it('builds an orders', () => { ${body} }); });`, 'd.test.ts': ') )' }),
      {
        file: 'gone.test.ts',
        path: '/repo/gone.test.ts',
        read: () => {
          throw new Error('ENOENT: no such file or directory');
        },
      },
    ];
    const result = runDuplicateTests(ts, { ...DEFAULT_CONFIG, threshold: 0.9 }, 'files', files);
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, ['❌ Parse error: Declaration or statement expected. (1:0)', '⚠️  Failed to parse /repo/gone.test.ts: ENOENT: no such file or directory']);
    assert.deepEqual(result.out.slice(0, 6), ['🔍 Searching for duplicate tests (Threshold: 0.9)...', '   Mode: files', '   Analyzing 5 files...', '   Extracted 4 test signatures.', '', '❌ Found potential duplicate tests:']);
    assert.deepEqual(result.out.slice(6, 10), ['', '   100% Match:', '     A: a.test.ts:1 "builds an order"', '     B: b.test.ts:1 "builds an order"']);
    assert.equal(result.out.at(-1), `Total potential duplicates: ${String((result.out.length - 8) / 4)}`);
    assert.ok(result.out.some((l) => l.includes('c.test.ts:1 "builds an orders"')));
  });
});
