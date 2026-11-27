import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  grants,
  inLine,
  inUse,
  quantile,
  replay,
  summarize,
  widthOf,
  type Logged,
  type Request,
  type TurnClass,
} from "./turn-queue.ts";

const request = (
  token: string,
  askedAt: number,
  extra: Partial<Request> = {},
): Request => ({
  token,
  class: "other",
  exclusive: false,
  askedAt,
  grantedAt: null,
  ...extra,
});

const held = (token: string, extra: Partial<Request> = {}): Request =>
  request(token, 0, { grantedAt: 0, ...extra });

const tokens = (list: readonly { token: string }[]): string[] =>
  list.map((entry) => entry.token);

const BOUND = 30 * 60_000;

describe("widthOf", () => {
  it("is one turn shared, every turn exclusive", () => {
    assert.equal(widthOf({ exclusive: false }, 3), 1);
    assert.equal(widthOf({ exclusive: true }, 3), 3);
  });
});

describe("inUse", () => {
  it("sums the widths of granted requests only", () => {
    assert.equal(
      inUse([held("a"), held("b", { exclusive: true }), request("c", 5)], 2),
      3,
    );
    assert.equal(inUse([request("c", 5)], 2), 0);
    assert.equal(inUse([], 2), 0);
  });
});

describe("inLine", () => {
  it("orders the waiting by class, pushes first, then arrival, then token", () => {
    const line = inLine([
      request("late-other", 30),
      held("holder"),
      request("early-other", 10),
      request("late-push", 40, { class: "push" }),
      request("b-tie", 20),
      request("a-tie", 20),
      request("early-push", 35, { class: "push" }),
    ]);
    assert.deepEqual(tokens(line), [
      "early-push",
      "late-push",
      "early-other",
      "a-tie",
      "b-tie",
      "late-other",
    ]);
  });

  it("leaves the requests it was given in their order", () => {
    const given = [request("b", 2), request("a", 1)];
    inLine(given);
    assert.deepEqual(tokens(given), ["b", "a"]);
  });
});

describe("grants", () => {
  it("grants in line while the widths fit", () => {
    assert.deepEqual(grants([request("a", 1), request("b", 2), request("c", 3)], 2, 3, BOUND), [
      { token: "a", overBound: false },
      { token: "b", overBound: false },
    ]);
  });

  it("counts the turns already held", () => {
    assert.deepEqual(tokens(grants([held("h"), request("a", 1), request("b", 2)], 2, 3, BOUND)), [
      "a",
    ]);
    assert.deepEqual(grants([held("h"), held("i"), request("a", 1)], 2, 3, BOUND), []);
  });

  it("lets no one overtake a head that does not fit", () => {
    // The exclusive head needs both turns; the shared request behind it would fit in one.
    const queue = [held("h"), request("x", 1, { exclusive: true }), request("s", 2)];
    assert.deepEqual(grants(queue, 2, 3, BOUND), []);
  });

  it("grants an exclusive request the whole machine once it is free", () => {
    assert.deepEqual(tokens(grants([request("x", 1, { exclusive: true }), request("s", 2)], 2, 3, BOUND)), [
      "x",
    ]);
  });

  it("serves a later push before an earlier request of another class", () => {
    assert.deepEqual(
      tokens(grants([held("h"), request("other", 1), request("push", 2, { class: "push" })], 2, 3, BOUND)),
      ["push"],
    );
  });

  it("grants a request that waited the bound, whatever is in use, and only it", () => {
    const queue = [held("h"), held("i"), request("old", 100), request("young", 101)];
    assert.deepEqual(grants(queue, 2, 100 + BOUND, BOUND), [{ token: "old", overBound: true }]);
    assert.deepEqual(grants(queue, 2, 100 + BOUND - 1, BOUND), []);
  });

  it("grants past the bound behind a blocked head too", () => {
    const queue = [
      held("h"),
      request("push", 500, { class: "push", exclusive: true }),
      request("old", 0),
    ];
    assert.deepEqual(grants(queue, 2, BOUND, BOUND), [{ token: "old", overBound: true }]);
  });

  it("grants nothing to granted requests", () => {
    assert.deepEqual(grants([held("h")], 2, 3, BOUND), []);
  });
});

const logged = (
  id: string,
  askedAt: number,
  runMs: number,
  extra: Partial<Logged> = {},
): Logged => ({
  id,
  class: "other" as TurnClass,
  exclusive: false,
  askedAt,
  startedAt: askedAt + 5,
  endedAt: askedAt + 5 + runMs,
  ...extra,
});

const waits = (lines: readonly Logged[], count: number, bound = BOUND): number[] =>
  replay(lines, count, bound).map((entry) => entry.waitMs);

describe("replay", () => {
  it("waits nobody when the turns suffice", () => {
    assert.deepEqual(waits([logged("a", 0, 100), logged("b", 10, 100)], 2), [0, 0]);
  });

  it("queues the third of three overlapping requests on two turns until the first ends", () => {
    const lines = [logged("a", 0, 100), logged("b", 10, 100), logged("c", 20, 100)];
    assert.deepEqual(waits(lines, 2), [0, 0, 80]);
    assert.deepEqual(waits(lines, 1), [0, 90, 180]);
    assert.deepEqual(waits(lines, 3), [0, 0, 0]);
  });

  it("gives each its own run time, from its start, not its asking", () => {
    // a ran 100 ms after a 5 ms start; b, asked meanwhile, waits until 100.
    assert.deepEqual(waits([logged("a", 0, 100), logged("b", 1, 7)], 1), [0, 99]);
  });

  it("never gives a negative run time", () => {
    const backwards = { ...logged("a", 0, 0), startedAt: 50, endedAt: 10 };
    assert.deepEqual(waits([backwards, logged("b", 1, 1)], 1), [0, 0]);
  });

  it("answers in the order given, whatever the order of asking", () => {
    const result = replay([logged("late", 50, 10), logged("early", 0, 100)], 1, BOUND);
    assert.deepEqual(result, [
      { id: "late", waitMs: 50, overBound: false },
      { id: "early", waitMs: 0, overBound: false },
    ]);
  });

  it("serves a waiting push before an earlier request of another class", () => {
    const lines = [
      logged("first", 0, 100),
      logged("other", 10, 100),
      logged("push", 20, 100, { class: "push" }),
    ];
    assert.deepEqual(waits(lines, 1), [0, 190, 80]);
  });

  it("holds the machine for an exclusive request, and back the requests behind it", () => {
    const lines = [
      logged("a", 0, 100),
      logged("x", 10, 50, { exclusive: true }),
      logged("b", 20, 10),
    ];
    // x waits for a to end at 100, runs to 150; b, which fit beside a, waits behind x.
    assert.deepEqual(waits(lines, 2), [0, 90, 130]);
  });

  it("runs a request at the bound and records it", () => {
    const result = replay([logged("a", 0, 1000), logged("b", 0, 10)], 1, 300);
    assert.deepEqual(result, [
      { id: "a", waitMs: 0, overBound: false },
      { id: "b", waitMs: 300, overBound: true },
    ]);
  });

  it("frees a zero-length run at once", () => {
    assert.deepEqual(waits([logged("a", 0, 0), logged("b", 0, 0), logged("c", 0, 0)], 1), [0, 0, 0]);
  });

  it("counts each loop pass as a step, and throws past its limit", () => {
    // One request: arrival (grant, then a pass with nothing to grant), its end
    // (a pass with nothing), then the pass that finds nothing left: 6 steps.
    const one = [logged("a", 0, 100)];
    assert.deepEqual(waits(one, 1), [0]);
    assert.deepEqual(
      replay(one, 1, BOUND, 6).map((entry) => entry.waitMs),
      [0],
    );
    assert.throws(() => replay(one, 1, BOUND, 5), /^Error: replay did not settle in 5 steps$/);
    assert.deepEqual(replay([], 1, BOUND, 1), []);
    assert.throws(() => replay([], 1, BOUND, 0), /^Error: replay did not settle in 0 steps$/);
  });

  it("replays nothing to nothing", () => {
    assert.deepEqual(replay([], 2, BOUND), []);
  });

  it("ends with no bound at all", () => {
    assert.deepEqual(
      waits([logged("a", 0, 100), logged("b", 0, 100)], 1, Number.POSITIVE_INFINITY),
      [0, 100],
    );
  });
});

describe("quantile", () => {
  it("is the nearest-rank value, 0 for none", () => {
    assert.equal(quantile([], 0.5), 0);
    assert.equal(quantile([30, 10, 20], 0.5), 20);
    assert.equal(quantile([10, 20, 30, 40], 0.5), 20);
    assert.equal(quantile([10, 20, 30, 40], 0.95), 40);
    assert.equal(quantile([10, 20, 30, 40], 0.75), 30);
    assert.equal(quantile([5], 0), 5);
  });

  it("leaves its input unsorted", () => {
    const values = [3, 1, 2];
    quantile(values, 0.5);
    assert.deepEqual(values, [3, 1, 2]);
  });
});

describe("summarize", () => {
  it("sums the replay at a count", () => {
    const lines = [logged("a", 0, 100), logged("b", 10, 100), logged("c", 20, 100), logged("d", 500, 10)];
    assert.deepEqual(summarize(lines, 2, BOUND), {
      count: 2,
      boundMs: BOUND,
      requests: 4,
      waited: 1,
      totalWaitMs: 80,
      p50WaitMs: 0,
      p95WaitMs: 80,
      maxWaitMs: 80,
      overBound: 0,
    });
  });

  it("counts the requests run at the bound", () => {
    const summary = summarize([logged("a", 0, 1000), logged("b", 0, 10), logged("c", 0, 10)], 1, 300);
    assert.equal(summary.overBound, 2);
    assert.equal(summary.waited, 2);
    assert.equal(summary.maxWaitMs, 300);
  });

  it("is all zeros for an empty log", () => {
    assert.deepEqual(summarize([], 2, 60), {
      count: 2,
      boundMs: 60,
      requests: 0,
      waited: 0,
      totalWaitMs: 0,
      p50WaitMs: 0,
      p95WaitMs: 0,
      maxWaitMs: 0,
      overBound: 0,
    });
  });
});
