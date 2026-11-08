import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_LIMIT, mapPool } from './pool.ts';

describe('mapPool', () => {
  // First, so a pool that runs past its items fails here instead of hanging
  // the tests below, which would take an index past the end forever.
  it('never hands work an index past the last item', async () => {
    const indexes: number[] = [];
    const out = await mapPool(
      ['a', 'b'],
      (item, index) => {
        indexes.push(index);
        return index < 2
          ? Promise.resolve(item)
          : Promise.reject(new Error(`index ${String(index)} past the end`));
      },
      2,
    );
    assert.deepEqual(out, ['a', 'b']);
    assert.deepEqual(indexes, [0, 1]);
  });

  it('runs every item, results in order, never more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool(
      [3, 1, 2, 5, 4],
      async (item, index) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, item));
        inFlight -= 1;
        return `${String(index)}:${String(item)}`;
      },
      2,
    );
    assert.deepEqual(out, ['0:3', '1:1', '2:2', '3:5', '4:4']);
    assert.equal(peak, 2);
  });

  it('defaults to a limit of at least two', () => {
    assert.ok(DEFAULT_LIMIT >= 2);
  });

  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`refuses a limit of ${String(limit)} rather than run nothing`, async () => {
      let ran = 0;
      await assert.rejects(
        mapPool(
          [1],
          () => {
            ran += 1;
            return Promise.resolve(1);
          },
          limit,
        ),
        /limit/,
      );
      assert.equal(ran, 0);
    });
  }

  it('accepts a limit of one', async () => {
    assert.deepEqual(
      await mapPool([1, 2], item => Promise.resolve(item * 2), 1),
      [2, 4],
    );
  });

  it('runs with the default limit when none is given', async () => {
    assert.deepEqual(await mapPool([1, 2, 3], item => Promise.resolve(item)), [
      1, 2, 3,
    ]);
  });

  it('starts no item after a failure and rethrows it', async () => {
    const seen: number[] = [];
    await assert.rejects(
      mapPool(
        [1, 2, 3],
        item => {
          seen.push(item);
          return item === 1
            ? Promise.reject(new Error('boom'))
            : Promise.resolve(item);
        },
        1,
      ),
      /boom/,
    );
    assert.deepEqual(seen, [1]);
  });

  it('stops a lane still running when another lane fails', async () => {
    const seen: number[] = [];
    await assert.rejects(
      mapPool(
        [1, 2, 3],
        async item => {
          seen.push(item);
          if (item === 1) throw new Error('boom');
          // Item 2 settles after item 1 failed; its lane must not take 3.
          await new Promise(resolve => setImmediate(resolve));
          return item;
        },
        2,
      ),
      /boom/,
    );
    assert.deepEqual(seen, [1, 2]);
  });
});
