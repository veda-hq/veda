// The expect and vi subset the page and services tests use, on node:assert.
// No tests of its own: a `.test.ts` name keeps it out of the build and the
// coverage figures. Those tests came from vitest, so their cases keep
// vitest's meaning: toEqual ignores undefined properties, toThrow(text)
// matches part of the message, toHaveBeenCalledWith compares deeply, and the
// asymmetric matchers (stringContaining, stringMatching, any,
// objectContaining, arrayContaining) match at any depth.
import assert from 'node:assert/strict';
import { it as nodeIt } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

/** A recorded function: vitest's `vi.fn` shape, as far as the tests read it. */
export interface Mock<F extends (...args: never[]) => unknown> {
  (...args: Parameters<F>): ReturnType<F>;
  mock: { calls: Parameters<F>[]; lastCall: Parameters<F> | undefined };
  mockReturnValue: (value: ReturnType<F>) => Mock<F>;
  mockImplementation: (impl: F) => Mock<F>;
  mockRestore: () => void;
}

type AnyFn = (...args: never[]) => unknown;

function record<F extends AnyFn>(impl: F | undefined, restore: () => void = () => undefined): Mock<F> {
  let body: AnyFn | undefined = impl;
  const calls: Parameters<F>[] = [];
  const fn = ((...args: Parameters<F>) => {
    calls.push(args);
    return body?.(...args);
  }) as Mock<F>;
  fn.mock = {
    calls,
    get lastCall() {
      return calls.at(-1);
    },
  };
  fn.mockReturnValue = value => {
    body = () => value;
    return fn;
  };
  fn.mockImplementation = next => {
    body = next;
    return fn;
  };
  fn.mockRestore = restore;
  return fn;
}

const stubbed = new Map<string, string | undefined>();

export const vi = {
  fn: <F extends AnyFn = (...args: unknown[]) => undefined>(impl?: F): Mock<F> => record(impl),
  spyOn<T extends object, K extends keyof T>(target: T, key: K): Mock<T[K] extends AnyFn ? T[K] : never> {
    const original = target[key];
    const spy = record<T[K] extends AnyFn ? T[K] : never>(
      ((...args: never[]) => (original as AnyFn).apply(target, args)) as T[K] extends AnyFn ? T[K] : never,
      () => {
        target[key] = original;
      },
    );
    target[key] = spy as T[K];
    return spy;
  },
  stubEnv(name: string, value: string): void {
    if (!stubbed.has(name)) stubbed.set(name, process.env[name]);
    process.env[name] = value;
  },
  unstubAllEnvs(): void {
    for (const [name, value] of stubbed) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    stubbed.clear();
  },
  /** Retries `check` until it stops throwing, or rethrows its last failure at `timeout` ms. */
  async waitFor<T>(check: () => T | Promise<T>, { timeout = 1_000, interval = 50 }: { timeout?: number; interval?: number } = {}): Promise<T> {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        return await check();
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      await sleep(interval);
    }
  },
};

/** An asymmetric matcher: matches what its test accepts, wherever it stands in an expected value. */
class Asymmetric {
  readonly test: (actual: unknown) => boolean;
  readonly label: string;
  constructor(test: (actual: unknown) => boolean, label: string) {
    this.test = test;
    this.label = label;
  }
  toJSON(): string {
    return this.label;
  }
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** The keys whose values are not undefined, as vitest's toEqual counts them. */
const definedKeys = (value: Record<string, unknown>): string[] =>
  Object.keys(value)
    .filter(key => value[key] !== undefined)
    .sort();

/** vitest's toEqual: deep, undefined properties ignored, asymmetric matchers at any depth. */
function equals(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Asymmetric) return expected.test(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => equals(actual[index], item));
  }
  if (isPlain(expected)) {
    if (!isPlain(actual)) return false;
    const keys = definedKeys(expected);
    return keys.join('\0') === definedKeys(actual).join('\0') && keys.every(key => equals(actual[key], expected[key]));
  }
  try {
    assert.deepEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

function subset(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Asymmetric) return expected.test(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => subset(actual[index], item));
  }
  if (typeof expected !== 'object' || expected === null) return equals(actual, expected);
  if (typeof actual !== 'object' || actual === null) return false;
  return Object.entries(expected).every(([key, item]) => subset((actual as Record<string, unknown>)[key], item));
}

function thrown(run: () => unknown): { threw: boolean; error: unknown } {
  try {
    run();
    return { threw: false, error: undefined };
  } catch (error) {
    return { threw: true, error };
  }
}

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

type Expected = string | RegExp | (new (...args: never[]) => unknown) | undefined;

/** Whether `error` is what `expected` names: part of its message, a pattern, or its class. */
function fitsError(error: unknown, expected: Expected): boolean {
  const text = error instanceof Error ? error.message : String(error);
  if (expected === undefined) return true;
  if (typeof expected === 'string') return text.includes(expected);
  if (expected instanceof RegExp) return expected.test(text);
  return error instanceof expected;
}

function matchers(actual: unknown, negate: boolean, message: string | undefined) {
  const check = (pass: boolean, what: string): void => {
    if (pass === negate) assert.fail(message ?? `expected ${show(actual)} ${negate ? 'not ' : ''}${what}`);
  };
  const calls = (): unknown[][] => (actual as Mock<AnyFn>).mock.calls;
  const number = (test: (value: number) => boolean, what: string): void => check(typeof actual === 'number' && test(actual), what);
  return {
    toBe: (expected: unknown) => check(Object.is(actual, expected), `to be ${show(expected)}`),
    toEqual: (expected: unknown) => check(equals(actual, expected), `to equal ${show(expected)}`),
    toMatchObject: (expected: object) => check(subset(actual, expected), `to match ${show(expected)}`),
    toContain: (part: unknown) =>
      check(
        (typeof actual === 'string' && typeof part === 'string' && actual.includes(part)) ||
          (Array.isArray(actual) && actual.includes(part)),
        `to contain ${show(part)}`,
      ),
    toContainEqual: (item: unknown) => check(Array.isArray(actual) && actual.some(entry => equals(entry, item)), `to contain an item equal to ${show(item)}`),
    toMatch: (pattern: RegExp | string) =>
      check(typeof actual === 'string' && (typeof pattern === 'string' ? actual.includes(pattern) : pattern.test(actual)), `to match ${String(pattern)}`),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeDefined: () => check(actual !== undefined, 'to be defined'),
    toBeGreaterThan: (bound: number) => number(value => value > bound, `to be greater than ${bound}`),
    toBeGreaterThanOrEqual: (bound: number) => number(value => value >= bound, `to be at least ${bound}`),
    toBeLessThan: (bound: number) => number(value => value < bound, `to be less than ${bound}`),
    toBeLessThanOrEqual: (bound: number) => number(value => value <= bound, `to be at most ${bound}`),
    /** vitest's: within half a unit of the `digits`th decimal place. */
    toBeCloseTo: (expected: number, digits = 2) => number(value => Math.abs(value - expected) < 10 ** -digits / 2, `to be close to ${expected}`),
    toHaveLength: (length: number) => check((typeof actual === 'string' || Array.isArray(actual)) && actual.length === length, `to have length ${length}`),
    toHaveProperty: (key: string) => check(typeof actual === 'object' && actual !== null && key in actual, `to have property ${key}`),
    toThrow: (expected?: Expected) => {
      const { threw, error } = thrown(actual as () => unknown);
      const text = error instanceof Error ? error.message : String(error);
      check(threw && fitsError(error, expected), `to throw ${String(expected ?? '')} (threw ${threw ? text : 'nothing'})`);
    },
    toHaveBeenCalled: () => check(calls().length > 0, 'to have been called'),
    toHaveBeenCalledTimes: (times: number) => check(calls().length === times, `to have been called ${times} times (was ${calls().length})`),
    toHaveBeenCalledWith: (...args: unknown[]) =>
      check(
        calls().some(call => equals(call, args)),
        `to have been called with ${show(args)}`,
      ),
    toHaveBeenLastCalledWith: (...args: unknown[]) =>
      check(equals(calls().at(-1), args), `to have been last called with ${show(args)}`),
  };
}

/** `expect(promise).rejects`: the promise must reject, and its reason meet the matcher. */
function rejects(actual: unknown, message: string | undefined) {
  const reason = async (): Promise<unknown> => {
    try {
      await (actual as Promise<unknown>);
    } catch (error) {
      return error;
    }
    return assert.fail(message ?? 'expected the promise to reject, and it resolved');
  };
  return {
    toThrow: async (expected?: Expected): Promise<void> => {
      const error = await reason();
      if (!fitsError(error, expected)) assert.fail(message ?? `expected a rejection with ${String(expected)}, got ${error instanceof Error ? error.message : String(error)}`);
    },
    toMatchObject: async (expected: object): Promise<void> => {
      const error = await reason();
      if (!subset(error, expected)) assert.fail(message ?? `expected the rejection to match ${show(expected)}`);
    },
  };
}

export function expect(actual: unknown, message?: string) {
  return { ...matchers(actual, false, message), not: matchers(actual, true, message), rejects: rejects(actual, message) };
}
expect.stringContaining = (part: string): Asymmetric => new Asymmetric(actual => typeof actual === 'string' && actual.includes(part), `stringContaining ${part}`);
expect.stringMatching = (pattern: RegExp): Asymmetric => new Asymmetric(actual => typeof actual === 'string' && pattern.test(actual), `stringMatching ${String(pattern)}`);
expect.any = (kind: StringConstructor | NumberConstructor | (new (...args: never[]) => unknown)): Asymmetric =>
  new Asymmetric(
    actual => (kind === String ? typeof actual === 'string' : kind === Number ? typeof actual === 'number' : actual instanceof (kind as new (...args: never[]) => unknown)),
    `any ${kind.name}`,
  );
expect.objectContaining = (part: object): Asymmetric => new Asymmetric(actual => subset(actual, part), `objectContaining ${show(part)}`);
/** vitest's: an array holding an item equal to each of `items`, in any order, among others. */
expect.arrayContaining = (items: readonly unknown[]): Asymmetric =>
  new Asymmetric(actual => Array.isArray(actual) && items.every(item => actual.some(entry => equals(entry, item))), `arrayContaining ${show(items)}`);

/** `it`, plus vitest's `it.each` with `%s` names. */
export const it = Object.assign(
  (name: string, fn: () => void | Promise<void>) => nodeIt(name, fn),
  {
    each:
      <const T>(table: readonly T[]) =>
      (name: string, fn: (...args: T extends readonly unknown[] ? [...T] : [T]) => void | Promise<void>) => {
        for (const row of table) {
          const args = (Array.isArray(row) ? row : [row]) as T extends readonly unknown[] ? [...T] : [T];
          let used = 0;
          // `%s` is the value as text, `%j` as JSON.
          const title = name.replace(/%[sj]/g, token => {
            const value: unknown = args[used++];
            return token === '%j' ? show(value) : String(value);
          });
          // Returned, so an async row's failure fails its test.
          nodeIt(title, () => fn(...args));
        }
      },
  },
);
