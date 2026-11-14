// The expect and vi subset the page tests use, on node:assert. No tests of
// its own: a `.test.ts` name keeps it out of the build and the coverage
// figures. The page tests came from vitest, so their cases
// keep vitest's meaning: toEqual ignores undefined properties, toThrow(text)
// matches part of the message, toHaveBeenCalledWith compares deeply.
import assert from 'node:assert/strict';
import { it as nodeIt } from 'node:test';

/** A recorded function: vitest's `vi.fn` shape, as far as the tests read it. */
export interface Mock<F extends (...args: never[]) => unknown> {
  (...args: Parameters<F>): ReturnType<F>;
  mock: { calls: Parameters<F>[]; lastCall: Parameters<F> | undefined };
  mockReturnValue: (value: ReturnType<F>) => Mock<F>;
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
};

/** `expect.stringContaining`: matches any string that holds `part`. */
class StringContaining {
  readonly part: string;
  constructor(part: string) {
    this.part = part;
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
  if (expected instanceof StringContaining) return typeof actual === 'string' && actual.includes(expected.part);
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

function matchers(actual: unknown, negate: boolean, message: string | undefined) {
  const check = (pass: boolean, what: string): void => {
    if (pass === negate) assert.fail(message ?? `expected ${show(actual)} ${negate ? 'not ' : ''}${what}`);
  };
  const calls = (): unknown[][] => (actual as Mock<AnyFn>).mock.calls;
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
    toMatch: (pattern: RegExp | string) =>
      check(typeof actual === 'string' && (typeof pattern === 'string' ? actual.includes(pattern) : pattern.test(actual)), `to match ${String(pattern)}`),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeGreaterThan: (bound: number) => check(typeof actual === 'number' && actual > bound, `to be greater than ${bound}`),
    toHaveProperty: (key: string) => check(typeof actual === 'object' && actual !== null && key in actual, `to have property ${key}`),
    toThrow: (expected?: string | RegExp) => {
      const { threw, error } = thrown(actual as () => unknown);
      const text = error instanceof Error ? error.message : String(error);
      const fits = expected === undefined || (typeof expected === 'string' ? text.includes(expected) : expected.test(text));
      check(threw && fits, `to throw ${String(expected ?? '')} (threw ${threw ? text : 'nothing'})`);
    },
    toHaveBeenCalled: () => check(calls().length > 0, 'to have been called'),
    toHaveBeenCalledWith: (...args: unknown[]) =>
      check(
        calls().some(call => equals(call, args)),
        `to have been called with ${show(args)}`,
      ),
    toHaveBeenLastCalledWith: (...args: unknown[]) =>
      check(equals(calls().at(-1), args), `to have been last called with ${show(args)}`),
  };
}

export function expect(actual: unknown, message?: string) {
  return { ...matchers(actual, false, message), not: matchers(actual, true, message) };
}
expect.stringContaining = (part: string): StringContaining => new StringContaining(part);

/** `it`, plus vitest's `it.each` with `%s` names. */
export const it = Object.assign(
  (name: string, fn: () => void | Promise<void>) => nodeIt(name, fn),
  {
    each:
      <const T>(table: readonly T[]) =>
      (name: string, fn: (...args: T extends readonly unknown[] ? [...T] : [T]) => void) => {
        for (const row of table) {
          const args = (Array.isArray(row) ? row : [row]) as T extends readonly unknown[] ? [...T] : [T];
          let used = 0;
          const title = name.replace(/%s/g, () => String(args[used++]));
          nodeIt(title, () => {
            fn(...args);
          });
        }
      },
  },
);
