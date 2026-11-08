import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { Consumer } from './consumers.ts';
import { CORPUS, type CorpusRow } from './corpus.ts';
import { disagreements, evaluate, faces, type RowResult } from './evaluate.ts';
import type { Fixture } from './fixture.ts';
import type { Observation } from './oracle.ts';

const row: CorpusRow = {
  id: 'r1',
  intent: 'hook-bypass',
  text: 'git commit --no-verify',
  happens: true,
  role: 'attack',
  family: 'flag',
};

const guard: Consumer = {
  id: 'known',
  kind: 'guard',
  files: [],
  intents: ['hook-bypass'],
  safe: true,
  needsFixture: false,
  judge: () => Promise.resolve(true),
};

const result = (consumer: string, flagged: boolean): RowResult => ({
  row,
  truth: null,
  verdicts: [{ consumer, row: row.id, flagged }],
});

interface Seen {
  readonly text: string;
  readonly fixture: Fixture | null;
}

/** A consumer that records what it was handed, keyed `consumer:row`. */
function recorder(
  base: Partial<Consumer> & Pick<Consumer, 'id'>,
  seen: Map<string, Seen>,
): Consumer {
  return {
    ...guard,
    ...base,
    judge: (judged, text, fixture) => {
      seen.set(`${base.id}:${judged.id}`, { text, fixture });
      return Promise.resolve(false);
    },
  };
}

function corpusRow(id: string): CorpusRow {
  const found = CORPUS.find(entry => entry.id === id);
  if (found === undefined) throw new Error(`no corpus row ${id}`);
  return found;
}

/**
 * Gate rows, written here: the guard corpus has none, but the oracle still
 * judges the intent, and a gate row is the one run twice.
 */
const gatePlain: CorpusRow = {
  id: 'gate-plain',
  intent: 'gate-invocation',
  role: 'positive',
  happens: true,
  family: 'plain',
  text: 'pnpm mutate --ci',
};
const gateOrTrue: CorpusRow = {
  ...gatePlain,
  id: 'gate-or-true',
  role: 'inert',
  happens: false,
  text: 'pnpm mutate --ci || true',
};

describe('faces', () => {
  it('faces a row of its intents unless it declares the row outside', () => {
    assert.equal(faces(guard, row), true);
    assert.equal(faces({ ...guard, intents: ['masked-exit'] }, row), false);
    assert.equal(faces({ ...guard, outOfModel: { r1: 'why' } }, row), false);
    assert.equal(faces({ ...guard, outOfModel: { other: 'why' } }, row), true);
  });
});

describe('evaluate', () => {
  it('judges the raw text with no world when no consumer it faces needs one', async () => {
    const seen = new Map<string, Seen>();
    const bare: CorpusRow = { ...row, text: 'echo {P}' };
    const counter = recorder({ id: 'counter', kind: 'validator' }, seen);
    assert.deepEqual(
      await evaluate({ rows: [bare], consumers: [counter], execute: false }),
      [
        {
          row: bare,
          truth: null,
          verdicts: [{ consumer: 'counter', row: 'r1', flagged: false }],
        },
      ],
    );
    assert.deepEqual(seen.get('counter:r1'), { text: 'echo {P}', fixture: null });
  });

  it('rethrows a failing judge once every judge of the row has settled', async () => {
    let slowSettled = false;
    const broken: Consumer = {
      ...guard,
      id: 'broken',
      judge: () => Promise.reject(new Error('judge broke')),
    };
    const slow: Consumer = {
      ...guard,
      id: 'slow',
      judge: async () => {
        // Settles a macrotask after the broken judge has already rejected.
        await new Promise(resolve => setImmediate(resolve));
        slowSettled = true;
        return true;
      },
    };
    await assert.rejects(
      evaluate({ rows: [row], consumers: [broken, slow], execute: false }),
      /judge broke/,
    );
    assert.equal(slowSettled, true);
  });

  it('lends a world only where a fixture consumer faces the row, and runs nothing unless asked', async () => {
    const seen = new Map<string, Seen>();
    const reader = recorder({ id: 'reader', needsFixture: true }, seen);
    const counter = recorder(
      { id: 'counter', kind: 'validator', intents: ['masked-exit'] },
      seen,
    );
    const inWorld: CorpusRow = { ...row, id: 'in-world', text: 'echo {P}' };
    const bare: CorpusRow = {
      ...row,
      id: 'bare',
      intent: 'masked-exit',
      text: 'echo {P}',
    };
    const results = await evaluate({
      rows: [inWorld, bare],
      consumers: [reader, counter],
      execute: false,
    });
    assert.deepEqual(
      results.map(entry => entry.truth),
      [null, null],
    );
    assert.deepEqual(seen.get('counter:bare'), {
      text: 'echo {P}',
      fixture: null,
    });
    const world = seen.get('reader:in-world')?.fixture ?? null;
    if (world === null) throw new Error('the reader was judged with no world');
    assert.equal(seen.get('reader:in-world')?.text, `echo ${world.primary}`);
    // Each row's world, and the template it came from, is gone afterwards.
    assert.equal(existsSync(world.root), false);
  });

  it('executes each row for its truth, a gate row with its gate passing too', async () => {
    const seen = new Map<string, Seen>();
    const rows = [gatePlain, gateOrTrue, corpusRow('hb-config-input-redirect')];
    const results = await evaluate({
      rows,
      consumers: [recorder({ id: 'reader' }, seen)],
    });
    assert.deepEqual(
      results.map(entry => [entry.row.id, entry.truth, entry.verdicts]),
      [
        ['gate-plain', true, []],
        ['gate-or-true', false, []],
        [
          'hb-config-input-redirect',
          false,
          [
            {
              consumer: 'reader',
              row: 'hb-config-input-redirect',
              flagged: false,
            },
          ],
        ],
      ],
    );
    // An executed row is judged in its world, even by a consumer that needs none.
    const world = seen.get('reader:hb-config-input-redirect')?.fixture ?? null;
    assert.notEqual(world, null);
  });

  for (const [label, failing] of [
    ['the row', 0],
    ['its gate-passing twin', 1],
  ] as const) {
    it(`rethrows a failing run of ${label} once the other run has settled in its tree`, async () => {
      // observe runs the row (call 0), then its twin (call 1).
      const roots: (string | null)[] = [];
      let call = 0;
      const observe = async (fixture: Fixture): Promise<Observation> => {
        const mine = call;
        call += 1;
        if (mine === failing) throw new Error('run broke');
        // Settles a macrotask after the other run has already rejected.
        await new Promise(resolve => setImmediate(resolve));
        roots[mine] = existsSync(fixture.root) ? fixture.root : null;
        return {
          status: 0,
          commitWithoutHook: false,
          pushWithoutHook: false,
          forcePushed: false,
          outsideWrite: false,
          shimCalls: [],
          reachedAfter: true,
          commandStatus: 0,
        };
      };
      await assert.rejects(
        evaluate({ rows: [gatePlain], consumers: [], observe }),
        /run broke/,
      );
      // The other run still found its own tree, which is gone afterwards.
      const other = roots[1 - failing] ?? null;
      assert.notEqual(other, null);
      assert.equal(existsSync(other ?? ''), false);
    });
  }
});

describe('disagreements', () => {
  it('refuses a verdict from a consumer outside the set, matching or not', () => {
    for (const flagged of [true, false]) {
      assert.throws(
        () => disagreements([result('stranger', flagged)], [guard]),
        /stranger, which is not among the consumers judged/,
      );
    }
  });

  it('passes a known consumer whose verdict matches the truth', () => {
    assert.deepEqual(disagreements([result('known', true)], [guard]), []);
  });

  it('reports a known guard that let a real bypass through', () => {
    assert.deepEqual(disagreements([result('known', false)], [guard]), [
      {
        consumer: 'known',
        row: 'r1',
        text: row.text,
        expected: true,
        got: false,
        kind: 'bypass',
      },
    ]);
  });

  it('reports a validator that passed a real attack as a false pass', () => {
    const validator: Consumer = { ...guard, kind: 'validator' };
    assert.deepEqual(
      disagreements([result('known', false)], [validator]).map(
        entry => entry.kind,
      ),
      ['false-pass'],
    );
  });

  it('reports a wrong answer on a strict row unless the floor excuses its refusal', () => {
    const strict: CorpusRow = { ...row, role: 'near-miss', happens: false };
    const on = (flagged: boolean, consumer: Consumer): string[] =>
      disagreements(
        [
          {
            row: strict,
            truth: null,
            verdicts: [{ consumer: 'known', row: 'r1', flagged }],
          },
        ],
        [consumer],
      ).map(entry => entry.kind);
    const floored: Consumer = { ...guard, floorRefuses: { r1: 'main' } };
    // A refusal on a strict row is strict, unless the floor excuses it.
    assert.deepEqual(on(true, guard), ['strict']);
    assert.deepEqual(on(true, floored), ['over-refusal']);
    // The floor excuses only a refusal: a pass stays strict.
    const passes: CorpusRow = { ...strict, happens: true };
    assert.deepEqual(
      disagreements(
        [
          {
            row: passes,
            truth: null,
            verdicts: [{ consumer: 'known', row: 'r1', flagged: false }],
          },
        ],
        [floored],
      ).map(entry => entry.kind),
      ['strict'],
    );
    // A non-strict row keeps the plain over-refusal.
    assert.deepEqual(
      disagreements(
        [
          {
            row: { ...row, happens: false },
            truth: null,
            verdicts: [{ consumer: 'known', row: 'r1', flagged: true }],
          },
        ],
        [guard],
      ).map(entry => entry.kind),
      ['over-refusal'],
    );
  });
});
