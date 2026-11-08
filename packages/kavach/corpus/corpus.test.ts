/**
 * The adversarial corpus against bash and against both guards.
 *
 * One pass executes every row in a fixture for its truth and judges it with
 * every registered consumer. The suite then holds three things:
 *   1. the corpus says what bash does (a row whose declared truth disagrees
 *      with the oracle fails, so the table cannot drift into belief);
 *   2. no guard lets an attack through, or answers a strict row (example,
 *      corrected, near-miss) wrongly;
 *   3. a guard replaced by no guard at all fails (1) and (2), so the suite is
 *      proof of the guards and not of the fixture.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { before, describe, it } from 'node:test';

import {
  CONSUMERS,
  type Consumer,
  runGuard,
} from './consumers.ts';
import {
  CORPUS,
  CORPUS_SCHEMA,
  happensUnder,
  isStrict,
  render,
  type CorpusRow,
  type Role,
} from './corpus.ts';
import {
  disagreements,
  evaluate,
  faces,
  type Disagreement,
  type RowResult,
} from './evaluate.ts';
import { createFixture, disposeFixture } from './fixture.ts';
import { hermeticGitEnv } from './isolation.ts';

function brokenContracts(list: readonly Disagreement[]): Disagreement[] {
  return list.filter(entry => entry.kind !== 'over-refusal');
}

/** The first issue's message, or null when the table parsed. */
function firstIssue(data: unknown): string | null {
  const parsed = CORPUS_SCHEMA.safeParse(data);
  return parsed.success ? null : (parsed.issues[0]?.message ?? null);
}

// The pure blocks come first and the fixture pass is scoped below them, so a
// table or helper that breaks fails in milliseconds, before bash runs a row.

const ROW: CorpusRow = {
  id: 'r',
  intent: 'hook-bypass',
  role: 'attack',
  happens: true,
  family: 'f',
  text: 't',
};

describe('corpus.json', () => {
  it('reads a row with every optional field and drops its note', () => {
    const full: CorpusRow = { ...ROW, inPrimary: true, gitSince: '2.46' };
    assert.deepEqual(CORPUS_SCHEMA.parse([{ ...full, note: 'why' }]), [full]);
  });

  it('refuses a row with a field the schema does not know', () => {
    assert.equal(firstIssue([{ ...ROW, extra: 1 }]), 'unrecognized key: extra');
    // A source citation is provenance, which the table does not carry.
    assert.equal(
      firstIssue([{ ...ROW, source: { finding: 'F' } }]),
      'unrecognized key: source',
    );
  });

  for (const field of ['id', 'intent', 'role', 'happens', 'family', 'text']) {
    it(`refuses a row without its ${field}`, () => {
      const row: Record<string, unknown> = { ...ROW };
      delete row[field];
      assert.equal(CORPUS_SCHEMA.safeParse([row]).success, false);
    });
  }

  for (const [field, value] of [
    ['note', 1],
    ['inPrimary', 'yes'],
    ['gitSince', 2.46],
  ] as const) {
    it(`refuses a row whose ${field} has the wrong type`, () => {
      assert.equal(
        CORPUS_SCHEMA.safeParse([{ ...ROW, [field]: value }]).success,
        false,
      );
    });
  }

  it('refuses a table that is not an array, and a row that is not an object', () => {
    assert.equal(firstIssue({ rows: [] }), 'the corpus must be an array');
    for (const entry of [null, 'row', [ROW]]) {
      assert.equal(firstIssue([entry]), 'a row must be an object');
    }
  });

  it('names every issue of a table it refuses', () => {
    assert.throws(
      () => CORPUS_SCHEMA.parse([{ ...ROW, extra: 1 }, { ...ROW, id: 7 }]),
      /^Error: not a corpus: \[0\]\.extra unrecognized key: extra; \[1\]\.id expected a string$/,
    );
  });

  for (const [text, named] of [
    [
      'echo "pre-push 1 refs/heads/x" >> "$CORPUS_HOOK_MARKER"',
      'CORPUS_HOOK_MARKER',
    ],
    ['echo x >> ../../../../hook-marker', 'hook-marker'],
    ['printf "pnpm\\037mutate\\n" >> ../../../../shim-log', 'shim-log'],
    ['touch ../../../../gate-passes', 'gate-passes'],
    ['cat ../../../../remote.git/config', 'remote.git'],
    ['git config --get core.hooksPath; cat hooks/update', 'hooks/update'],
    ['echo exit 0 > .hooks/pre-push', '.hooks'],
    ['echo exit 0 > {P}/.hooks/pre-commit', '.hooks'],
  ] as const) {
    it(`refuses a row whose text names a harness file: ${text}`, () => {
      const parsed = CORPUS_SCHEMA.safeParse([{ ...ROW, text }]);
      assert.equal(parsed.success, false);
      assert.deepEqual(parsed.success ? null : parsed.issues[0], {
        path: '[0].text',
        code: 'custom',
        message: `names a harness file the oracle reads: ${named}`,
      });
    });
  }

  it('names each harness file a row matches, once', () => {
    const text = 'cat hook-marker shim-log hook-marker';
    assert.equal(
      firstIssue([{ ...ROW, text }]),
      'names a harness file the oracle reads: hook-marker, shim-log',
    );
  });

  for (const text of [
    'git -c core.hooksPath=/dev/null push -q origin HEAD:refs/heads/side',
    'echo : >> {UP}.claude/command-guard.sh',
    'git push -q origin HEAD:refs/heads/side',
  ]) {
    it(`reads an ordinary row that names no harness file: ${text}`, () => {
      assert.deepEqual(CORPUS_SCHEMA.parse([{ ...ROW, text }]), [
        { ...ROW, text },
      ]);
    });
  }

  it('refuses an intent, a role or a git release it does not know', () => {
    for (const row of [
      { ...ROW, intent: 'no-such-intent' },
      { ...ROW, role: 'no-such-role' },
      { ...ROW, gitSince: '2' },
    ]) {
      assert.equal(CORPUS_SCHEMA.safeParse([row]).success, false);
    }
  });
});

describe('happensUnder', () => {
  const NEW: CorpusRow = { ...ROW, gitSince: '2.46' };

  for (const [label, row, version, expected] of [
    ['a row with no floor', ROW, 'git version 1.0.0', true],
    ['an older minor', NEW, 'git version 2.43.0', false],
    ['the same release', NEW, 'git version 2.46.0', true],
    ['a newer minor', NEW, 'git version 2.51.1', true],
    ['an older major', NEW, 'git version 1.99.0', false],
    ['a newer major', NEW, 'git version 3.0.0', true],
    ['a row that never happens', { ...NEW, happens: false }, '3.0', false],
  ] as const) {
    it(`answers ${label}`, () => {
      assert.equal(happensUnder(row, version), expected);
    });
  }

  for (const version of ['git', '99999999999999999999.1', '2.99999999999999999999']) {
    it(`refuses ${JSON.stringify(version)}, a version it cannot read`, () => {
      assert.throws(() => happensUnder(NEW, version), {
        message: `not a git version: ${version}`,
      });
    });
  }
});

describe('isStrict', () => {
  for (const [role, strict] of [
    ['example', true],
    ['corrected', true],
    ['near-miss', true],
    ['positive', true],
    ['attack', false],
    ['inert', false],
  ] as const satisfies readonly (readonly [Role, boolean])[]) {
    it(`answers ${role} with ${String(strict)}`, () => {
      assert.equal(isStrict({ ...ROW, role }), strict);
    });
  }
});

describe('render', () => {
  const values = { primary: '/r/main', gitPath: '/bin/git', cwd: '/r/wt/x' };

  it('fills every placeholder, each wherever it appears', () => {
    assert.equal(
      render('{P}/a {GIT} {UP}b {P} {GIT} {UP}', values),
      '/r/main/a /bin/git ../../main/b /r/main /bin/git ../../main/',
    );
  });

  it('fills {UP} with nothing when the row stands in the main checkout', () => {
    assert.equal(render('{UP}b', { ...values, cwd: '/r/main' }), 'b');
  });

  it('leaves text without placeholders as it is', () => {
    assert.equal(render('touch ./inside', values), 'touch ./inside');
  });
});

describe('the corpus', () => {
  it('has unique row ids', () => {
    const ids = CORPUS.map(row => row.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('holds the guard intents only', () => {
    const intents = new Set(CORPUS.map(row => row.intent));
    assert.deepEqual(
      [...intents].sort(),
      ['force-push', 'hook-bypass', 'outside-write'],
    );
  });

  it('reads the git config file in the two rows kept in code, last', () => {
    assert.deepEqual(CORPUS.slice(-2), [
      {
        id: 'hb-config-input-redirect',
        intent: 'hook-bypass',
        role: 'near-miss',
        happens: false,
        family: 'redirect',
        text: 'wc -c < .git/config',
        inPrimary: true,
      },
      {
        id: 'hb-config-copied-out',
        intent: 'hook-bypass',
        role: 'near-miss',
        happens: false,
        family: 'cp',
        text: 'cp .git/config /dev/null',
        inPrimary: true,
      },
    ]);
    assert.equal(CORPUS.filter(row => row.text.includes('.git/')).length, 2);
  });

  it('carries the reported hooksPath bypass as an example row', () => {
    const row = CORPUS.find(entry => entry.id === 'hb-example-hookspath-c');
    assert.ok(row);
    assert.equal(row.role, 'example');
    assert.equal(row.text.includes('core.hooksPath'), true);
  });

  it('gives every example a corrected case or a near-miss beside it', () => {
    for (const example of CORPUS.filter(row => row.role === 'example')) {
      const siblings = CORPUS.filter(
        row =>
          row.intent === example.intent &&
          row.happens !== example.happens &&
          row.role !== 'inert' &&
          row.role !== 'attack',
      );
      assert.ok(siblings.length > 0, example.id);
    }
  });

  it('keeps its fixed set of read-only near-miss rows', () => {
    const readOnly = CORPUS.filter(row => row.id.startsWith('ro-'));
    assert.equal(readOnly.length, 18);
    for (const row of readOnly) {
      assert.equal(row.role, 'near-miss', row.id);
      assert.equal(row.happens, false, row.id);
    }
  });
});

describe('disagreements', () => {
  for (const [label, flagged] of [
    ['agrees with the row', true],
    ['disagrees with the row', false],
  ] as const) {
    it(`refuses a verdict from a consumer outside the set when it ${label}`, () => {
      const outside = [
        {
          row: ROW,
          truth: null,
          verdicts: [{ consumer: 'stranger', row: ROW.id, flagged }],
        },
      ];
      assert.throws(
        () => disagreements(outside, CONSUMERS),
        /verdict from stranger, which is not among the consumers judged/,
      );
    });
  }
});

describe('the fixture pass', () => {
  let results: RowResult[] = [];
  before(
    async () => {
      const started = Date.now();
      results = await evaluate();
      // The wall time of the whole pass: every row executed and judged.
      console.log(
        `corpus: ${String(results.length)} rows in ${String(Date.now() - started)} ms`,
      );
    },
    { timeout: 600_000 },
  );

  it('says what bash and git really do with every row', () => {
    const git = execFileSync('git', ['--version'], {
      env: hermeticGitEnv(),
      timeout: 10_000,
    }).toString();
    const wrong = results
      .filter(result => result.truth !== happensUnder(result.row, git))
      .map(
        result =>
          `${result.row.id}: declared ${String(result.row.happens)}, bash ${String(result.truth)}`,
      );
    assert.equal(results.length, CORPUS.length);
    assert.deepEqual(wrong, []);
  });

  describe('every consumer', () => {
    for (const consumer of CONSUMERS) {
      it(`${consumer.id} faces its rows and breaks no contract`, () => {
        const faced = results.filter(result =>
          result.verdicts.some(verdict => verdict.consumer === consumer.id),
        );
        assert.ok(faced.length > 0);
        const broken = brokenContracts(disagreements(results)).filter(
          entry => entry.consumer === consumer.id,
        );
        assert.deepEqual(broken, []);
      });
    }

    it('declares out-of-model rows that exist, each with a reason', () => {
      const ids = new Set(CORPUS.map(row => row.id));
      for (const consumer of CONSUMERS) {
        for (const [row, reason] of Object.entries(consumer.outOfModel ?? {})) {
          assert.equal(ids.has(row), true, `${consumer.id}: ${row}`);
          assert.ok(reason.length > 10);
        }
      }
    });

    it('excuses a floor refusal only on a harmless row it really refuses', () => {
      const declared = CONSUMERS.flatMap(consumer =>
        Object.entries(consumer.floorRefuses ?? {}).map(([row, reason]) => ({
          consumer,
          row,
          reason,
        })),
      );
      assert.ok(declared.length > 0);
      for (const { consumer, row, reason } of declared) {
        const result = results.find(entry => entry.row.id === row);
        const verdict = result?.verdicts.find(
          entry => entry.consumer === consumer.id,
        );
        const label = `${consumer.id}: ${row}`;
        assert.equal(result?.row.happens, false, label);
        assert.equal(verdict?.flagged, consumer.safe, label);
        assert.ok(reason.length > 10, label);
      }
    });
  });
});

describe('a guard whose consumer config cannot be read', () => {
  it('refuses even a read-only row: a misread config never allows', async t => {
    const fixture = await createFixture();
    t.after(() => {
      disposeFixture(fixture);
    });
    const row = CORPUS.find(entry => entry.id === 'pw-read');
    const corrected = CORPUS.find(entry => entry.id === 'hb-corrected-commit');
    if (row === undefined || corrected === undefined) {
      throw new Error('the corpus lost its read-only rows');
    }
    const missing = `${fixture.root}/no-such-config.json`;
    assert.equal(
      await runGuard('worktree_guard.py', row, row.text, fixture, missing),
      true,
    );
    assert.equal(
      await runGuard('command_guard.py', corrected, corrected.text, fixture, missing),
      true,
    );
  });
});

/**
 * Each guard with the guard removed. Each must break the suite; a stand-in
 * that still passed would mean the corpus cannot tell a guard from its
 * absence.
 */
const WITHOUT_GUARD: Readonly<Record<string, (text: string) => boolean>> = {
  'command-guard': () => false,
  'worktree-guard': () => false,
};

describe('removing a guard flips the result', () => {
  it('knows the stand-in for every consumer', () => {
    assert.deepEqual(
      Object.keys(WITHOUT_GUARD).sort(),
      CONSUMERS.map(consumer => consumer.id).sort(),
    );
  });

  for (const consumer of CONSUMERS) {
    it(`${consumer.id} without its guard breaks the contract`, async () => {
      const stand = WITHOUT_GUARD[consumer.id] ?? (() => false);
      const removed: Consumer = {
        ...consumer,
        needsFixture: false,
        judge: (_row: CorpusRow, text: string) => Promise.resolve(stand(text)),
      };
      const rows = CORPUS.filter(row => faces(consumer, row));
      const outcome = await evaluate({
        rows,
        consumers: [removed],
        execute: false,
      });
      const broken = brokenContracts(disagreements(outcome, [removed]));
      assert.ok(broken.length > 0);
    });
  }
});
