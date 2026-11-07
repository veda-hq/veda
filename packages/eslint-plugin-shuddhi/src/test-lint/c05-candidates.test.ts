import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';

import { c05CandidateRules } from './c05-candidates.js';
import { c05Rules } from './c05.js';
import { TEST_FILE_RULES } from './configs.js';
import * as helpers from './helpers.js';
import { C05_CANDIDATE_RULES, rules as pluginRules } from './index.js';
import { gitSpawnEnv, SHELL_SPAWNERS, SPAWNERS } from './process-hygiene.js';
import { fakeTimersRestored } from './test-structure.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The candidate extensions: rules that each close one shape of review
 * finding. Each `invalid` case is a finding reduced to the shape that
 * reproduces it; each `valid` case is the corrected code or a near miss.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

type AnyRule = Parameters<RuleTester['run']>[1];

/** The module under test, wired as the family entry wires it. */
const c05 = c05Rules(helpers);
const candidates = c05CandidateRules({
  ...helpers,
  SPAWNERS,
  SHELL_SPAWNERS,
  someNode: c05.someNode,
  OWNED_ROOT_CALLS: c05.OWNED_ROOT_CALLS,
  SOURCE_EXTENSIONS: c05.SOURCE_EXTENSIONS,
});

const rules = {
  'no-fixed-sleep': candidates.noFixedSleep,
  'specific-rejection': candidates.specificRejection,
  'call-specific-matcher': candidates.callSpecificMatcher,
  'independent-expectation': candidates.independentExpectation,
  'owned-db-schema': candidates.ownedDbSchema,
  'teardown-in-finally': candidates.teardownInFinally,
  'cleanup-loop-settles': candidates.cleanupLoopSettles,
  'parse-structured-config': candidates.parseStructuredConfig,
  'mock-state-reset': candidates.mockStateReset,
  'mock-export-parity': candidates.mockExportParity,
  'spawn-result-checked': candidates.spawnResultChecked,
  'local-tool-spawn': candidates.localToolSpawn,
  'fixture-root-tracked': candidates.fixtureRootTracked,
  // Extensions of rules other modules own, replayed here.
  'fake-timers-restored': fakeTimersRestored,
  'no-silent-early-return': c05.noSilentEarlyReturn,
  'git-spawn-env': gitSpawnEnv,
} as unknown as Record<string, AnyRule>;

/** Removes a directory this suite made with `mkdtempSync`. */
const removeRoot = (root: string) => {
  rmSync(root, { recursive: true, force: true });
};

const TEST_FILE = 'probe.test.ts';
const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

describe('candidate rules are wired', () => {
  it('binds every candidate rule at error in TEST_FILE_RULES', () => {
    assert.equal(C05_CANDIDATE_RULES.length, 13);
    for (const name of C05_CANDIDATE_RULES) {
      assert.ok(Object.hasOwn(pluginRules, name), name);
      assert.equal(
        (TEST_FILE_RULES as Record<string, unknown>)[`shuddhi/${name}`],
        'error',
        name,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// no-fixed-sleep
// ---------------------------------------------------------------------------

ruleTester.run('no-fixed-sleep', rules['no-fixed-sleep']!, {
  valid: [
    // Corrected: wait for the state.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { render(); await vi.waitFor(() => expect(shown()).toBe(true)); });`,
    },
    // Near miss: a zero delay yields a tick, it does not guess a duration.
    { filename: TEST_FILE, code: `async function f() { await sleep(0); }` },
    // Near miss: a short interval between polls of a condition.
    {
      filename: TEST_FILE,
      code: `async function f() { while (!done()) await sleep(50); }`,
    },
    {
      filename: TEST_FILE,
      code: `async function poll() { if (done()) return; await pause(200); return poll(); }`,
    },
    // Near miss: the delay is not fixed in the source.
    { filename: TEST_FILE, code: `async function f(ms) { await sleep(ms); }` },
    // Near miss: not a sleep.
    {
      filename: TEST_FILE,
      code: `async function f() { await new Promise(r => setImmediate(r)); await new Promise(r => r(1)); await fetchPage(100); await obj.sleep(100); await setTimeout(cb, 10); await sleep(); }`,
    },
    {
      filename: TEST_FILE,
      code: `async function f() { await new Promise(r => setTimeout(r, delay)); await new Promise(fn); await new Other(r => setTimeout(r, 5)); }`,
    },
  ],
  invalid: [
    // A fixed wait stands in for the render.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { render(); await new Promise(r => setTimeout(r, 500)); expect(shown()).toBe(true); });`,
      errors: [{ messageId: 'fixedSleep', data: { ms: '500' } }],
    },
    // A debounce waited out with a named helper.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { type('a'); await act(async () => { await wait(600); }); });`,
      errors: [{ messageId: 'fixedSleep' }],
    },
    // A constant delay is still fixed.
    {
      filename: TEST_FILE,
      code: `const HOLD = 2 * 1000; it('a', async () => { await sleep(HOLD); });`,
      errors: [{ messageId: 'fixedSleep', data: { ms: '2000' } }],
    },
    // Ten seconds per poll is a fixed sleep, not an interval.
    {
      filename: TEST_FILE,
      code: `async function settle() { if (await ready()) return; await pause(10_000); return settle(); }`,
      errors: [{ messageId: 'fixedSleep' }],
    },
    {
      filename: TEST_FILE,
      code: `const settle = async () => { for (;;) { await delay(5000); } };`,
      errors: [{ messageId: 'fixedSleep' }],
    },
    // timers/promises: the delay is the first argument.
    {
      filename: TEST_FILE,
      code: `async function f() { await setTimeout(250); }`,
      errors: [{ messageId: 'fixedSleep' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// specific-rejection
// ---------------------------------------------------------------------------

ruleTester.run('specific-rejection', rules['specific-rejection']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `it('a', async () => { await expect(guard.check(ctx)).rejects.toThrow(ForbiddenException); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(res.status).toBe(403); expect(res.status).not.toBe(500); expect(() => f()).not.toThrow(); });`,
    },
    // Near miss: a non-empty count of something that is not an error.
    { filename: TEST_FILE, code: `expect(items.length).toBeGreaterThan(0);` },
    // Near miss: the count is a precondition for an entry assertion.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const errors = validate(x); expect(errors.length).toBeGreaterThan(0); expect(errors[0].property).toBe('name'); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(result.issues).not.toHaveLength(0); expect(result.issues).toContainEqual(expect.objectContaining({ code: 'x' })); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(errors).toHaveLength(0); expect(errors.length).toBeGreaterThan(1); expect(errors.length).not.toBe(2); expect(errors).not.toEqual([1]); expect(errors).not.toEqual(other); });`,
    },
    {
      filename: TEST_FILE,
      code: `expect(other.length).toBe(0); expect(f()).toBe(1);`,
    },
  ],
  invalid: [
    // Any error rejects the guard.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { await expect(guard.canActivate(ctx)).rejects.toThrow(); });`,
      errors: [{ messageId: 'bareThrow' }],
    },
    // not.toBe(201) accepts a 500.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const res = await post(); expect(res.status).not.toBe(201); });`,
      errors: [
        { messageId: 'notSuccess', data: { matcher: 'toBe', status: '201' } },
      ],
    },
    // Any validation error satisfies the count.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const errors = await validate(dto); expect(errors.length).toBeGreaterThan(0); });`,
      errors: [{ messageId: 'anyError', data: { name: 'errors' } }],
    },
    // The same, through a helper call.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(problemsFor(config).length).toBeGreaterThanOrEqual(1); });`,
      errors: [{ messageId: 'anyError', data: { name: 'problemsFor' } }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', async () => { expect((await lint()).errors).not.toHaveLength(0); expect(violations).not.toEqual([]); expect(findings.length).not.toBe(0); });`,
      errors: [
        { messageId: 'anyError' },
        { messageId: 'anyError' },
        { messageId: 'anyError' },
      ],
    },
    {
      filename: TEST_FILE,
      code: `expect(res.statusCode).not.toEqual(200);`,
      errors: [{ messageId: 'notSuccess' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// call-specific-matcher
// ---------------------------------------------------------------------------

ruleTester.run('call-specific-matcher', rules['call-specific-matcher']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `it('a', () => { run(); expect(enqueue).toHaveBeenNthCalledWith(1, op); run(); expect(enqueue).toHaveBeenNthCalledWith(2, op); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { run(); expect(enqueue).toHaveBeenCalledWith(op); enqueue.mockClear(); run(); expect(enqueue).toHaveBeenCalledWith(op); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { run(); expect(enqueue).toHaveBeenCalledWith(op); vi.clearAllMocks(); run(); expect(enqueue).toHaveBeenCalledWith(op); });`,
    },
    // Near miss: different arguments, or a negation.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(enqueue).toHaveBeenCalledWith(a); expect(enqueue).toHaveBeenCalledWith(b); expect(enqueue).not.toHaveBeenCalledWith(a); expect(f()).toBe(1); });`,
    },
    { filename: TEST_FILE, code: `helper(); describe('s', () => {});` },
  ],
  invalid: [
    // The second assertion is satisfied by the first call.
    {
      filename: TEST_FILE,
      code: `it('retries', () => { flush(); expect(enqueue).toHaveBeenCalledWith(op); flush(); expect(enqueue).toHaveBeenCalledWith(op); });`,
      errors: [{ messageId: 'anyCall' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// independent-expectation
// ---------------------------------------------------------------------------

ruleTester.run('independent-expectation', rules['independent-expectation']!, {
  valid: [
    { filename: TEST_FILE, code: `expect(samples).toEqual([1, 2]);` },
    // Near miss: a scalar invariance check is not vacuous.
    { filename: TEST_FILE, code: `expect(run.id).toBe(run.id.trim());` },
    { filename: TEST_FILE, code: `expect(a).toEqual(b.map(f));` },
    { filename: TEST_FILE, code: `expect('x').toBe('x'.slice(0));` },
    {
      filename: TEST_FILE,
      code: `expect(xs).toContain(xs.map(f)[0]); expect(xs).toEqual(); expect(xs.length).toBe(1);`,
    },
  ],
  invalid: [
    // An empty sample set equals its own map.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const samples = measure(); expect(samples).toEqual(samples.map(s => ({ ...s }))); });`,
      errors: [{ messageId: 'selfDerived' }],
    },
    {
      filename: TEST_FILE,
      code: `expect(rows).toHaveLength(rows.filter(r => r.ok).length);`,
      errors: [{ messageId: 'selfDerived' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// owned-db-schema
// ---------------------------------------------------------------------------

// Split so this file's own literals are not schema SQL to the rule it tests.
const CREATE = ['CREATE', 'SCHEMA'].join(' ');
const DROP = ['DROP', 'SCHEMA'].join(' ');
const DOLLAR = '$';

ruleTester.run('owned-db-schema', rules['owned-db-schema']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `const schema = \`run_${DOLLAR}{id}\`; beforeAll(() => db.query(\`${CREATE} ${DOLLAR}{schema}\`)); afterAll(() => db.query(\`${DROP} ${DOLLAR}{schema} CASCADE\`));`,
    },
    {
      filename: TEST_FILE,
      code: `beforeAll(() => db.query(\`${CREATE} "attendance_${DOLLAR}{suffix}"\`)); db.query('${CREATE} run_${DOLLAR}{x}');`,
    },
    // Near miss: adopting is harmless when this file never drops a schema.
    {
      filename: TEST_FILE,
      code: `beforeAll(() => db.query('${CREATE} IF NOT EXISTS shared'));`,
    },
    { filename: TEST_FILE, code: `const sql = 'SELECT 1'; const n = 3;` },
  ],
  invalid: [
    // Adopt, then drop what may not be ours.
    {
      filename: TEST_FILE,
      code: `beforeAll(() => db.query(\`${CREATE} IF NOT EXISTS ${DOLLAR}{DRIFT_SCHEMA}\`)); afterAll(() => db.query(\`${DROP} IF EXISTS ${DOLLAR}{DRIFT_SCHEMA} CASCADE\`));`,
      errors: [{ messageId: 'adopted' }],
    },
    // A fixed name collides across runs.
    {
      filename: TEST_FILE,
      code: `beforeAll(() => db.query('${CREATE} attendance_v12_upgrade'));`,
      errors: [{ messageId: 'fixedName' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// teardown-in-finally
// ---------------------------------------------------------------------------

ruleTester.run('teardown-in-finally', rules['teardown-in-finally']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const release = await lock(); try { expect(await read()).toBe(1); } finally { release(); } });`,
    },
    // Near miss: nothing before the cleanup can fail.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const child = spawn('x'); const name = join('a', 'b'); child.kill(); });`,
    },
    // Near miss: a resource the function does not own.
    {
      filename: TEST_FILE,
      code: `let server; it('a', async () => { expect(await get()).toBe(1); server.close(); stop(); });`,
    },
    // Near miss: the try opens right after the resource exists.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const run = startHook(); try { expect(await run.exit).toBe(0); } finally { run.stop(); } });`,
    },
    // Near miss: a plain value is not a resource, and state set before the try is fine.
    {
      filename: TEST_FILE,
      code: `async function f() { const rows = []; await fill(rows); let dir; dir = make(); try { await use(dir); } finally { rows.length = 0; clean(dir); } }`,
    },
    {
      filename: TEST_FILE,
      code: `const release = () => {}; release(); function g() { function release() {} release(); }`,
    },
  ],
  invalid: [
    // release() never runs when the assertion fails.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const release = await lock(); expect(await read()).toBe(1); release(); });`,
      errors: [{ messageId: 'afterFailure' }],
    },
    // The wait rejects and the child is left running.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const wrapper = spawn(node, args); await vi.waitFor(() => expect(ready()).toBe(true)); wrapper.kill('SIGINT'); });`,
      errors: [{ messageId: 'afterFailure' }],
    },
    // The same in a helper the test calls.
    {
      filename: TEST_FILE,
      code: `async function interruptBlock() { const child = spawn('x'); await once(child, 'spawn'); child.kill('SIGINT'); }`,
      errors: [{ messageId: 'afterFailure' }],
    },
    // Work between the start and the try.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const run = startHook(); const code = await run.exit; try { expect(code).toBe(0); } finally { run.stop(); } });`,
      errors: [{ messageId: 'workBeforeTry', data: { name: 'run' } }],
    },
    // The finally depends on the try's progress.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { let record; try { record = await start(); expect(record.ok).toBe(true); } finally { reap(record.pid); } });`,
      errors: [{ messageId: 'stateFromTry', data: { name: 'record' } }],
    },
    {
      filename: TEST_FILE,
      code: `async function f() { const a = open(); const b = open(); if (bad) throw new Error('x'); try { await use(a, b); } finally { a.close(); b.close(); } }`,
      errors: [{ messageId: 'workBeforeTry', data: { name: 'a' } }],
    },
  ],
});

// ---------------------------------------------------------------------------
// cleanup-loop-settles
// ---------------------------------------------------------------------------

ruleTester.run('cleanup-loop-settles', rules['cleanup-loop-settles']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `afterAll(async () => { await Promise.allSettled(stacks.map(async s => { await s.stop(); rmSync(s.dir); })); });`,
    },
    {
      filename: TEST_FILE,
      code: `afterEach(() => { for (const dir of dirs) removeFixtureRoot(dir); });`,
    },
    {
      filename: TEST_FILE,
      code: `afterEach(() => { for (const s of stacks) { try { s.stop(); rmSync(s.dir); } catch (error) { failures.push(error); } } });`,
    },
    // Near miss: not teardown.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { for (const s of stacks) { s.start(); s.check(); } await Promise.all(xs.map(async x => { a(x); b(x); })); xs.forEach(x => { a(x); b(x); }); });`,
    },
    {
      filename: TEST_FILE,
      code: `afterEach(() => { xs.forEach(x => a(x)); xs.map(x => { a(x); b(x); }); xs.filter(x => x); xs.forEach(named); });`,
    },
  ],
  invalid: [
    // The first failing stop skips the rest.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { try { await run(); } finally { for (const root of roots) { try { reap(root); } finally { rmSync(root, { recursive: true }); } } } });`,
      errors: [{ messageId: 'aborts' }],
    },
    // Promise.all rejects on the first failure.
    {
      filename: TEST_FILE,
      code: `async function f() { try { await run(); } finally { await Promise.all(dirs.map(async dir => { await reap(dir); rmSync(dir); })); } }`,
      errors: [{ messageId: 'aborts' }],
    },
    {
      filename: TEST_FILE,
      code: `afterAll(async () => { for (const s of stacks) { await s.stop(); rmSync(s.dir); } });`,
      errors: [{ messageId: 'aborts' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { onTestFinished(() => items.forEach(i => { a(i); b(i); })); });`,
      errors: [{ messageId: 'aborts' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// parse-structured-config
// ---------------------------------------------------------------------------

ruleTester.run('parse-structured-config', rules['parse-structured-config']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `const config = load(readFileSync('.mergify.yml', 'utf8')); const pkg = JSON.parse(readFileSync('package.json', 'utf8'));`,
    },
    // Near miss: parsed and also searched; the parse is what the test trusts.
    {
      filename: TEST_FILE,
      code: `const text = readFileSync('ci.yml', 'utf8'); const doc = parse(text); expect(text.includes('x')).toBe(true);`,
    },
    // Near miss: source code is text.
    {
      filename: TEST_FILE,
      code: `const src = readFileSync('a.ts', 'utf8'); expect(src).toContain('export');`,
    },
    {
      filename: TEST_FILE,
      code: `const t = readFileSync('a.yml', 'utf8'); write(t); copy(readFileSync('b.yml')); expect(readFileSync('c.yml', 'utf8')).toBe(x); const u = readFileSync('d.yml').length;`,
    },
    {
      filename: TEST_FILE,
      code: `const list = files.filter(file => readFileSync(file, 'utf8').includes('x')); const y = readdirSync(d).filter(name => /\\.ts$/.test(name)).map(file => readFileSync(file, 'utf8').split('x'));`,
    },
    {
      filename: TEST_FILE,
      code: `function f(file) { return readFileSync(file, 'utf8').split('x'); }`,
    },
  ],
  invalid: [
    // YAML read and split as text.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const text = readFileSync('.mergify.yml', 'utf8'); const lines = text.split('\\n'); expect(lines).toContain('x'); });`,
      errors: [{ messageId: 'textMatched' }],
    },
    // A regex over each workflow file.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const bad = readdirSync(dir).filter(f => /\\.ya?ml$/.test(f)).filter(file => /cache:/.test(readFileSync(resolve(dir, file), 'utf8'))); expect(bad).toEqual([]); });`,
      errors: [{ messageId: 'textMatched' }],
    },
    {
      filename: TEST_FILE,
      code: `expect(readFileSync('ci.yml', 'utf8')).toContain('cache:'); expect(readFileSync('a.json', 'utf8') as string).toMatch(/x/);`,
      errors: [{ messageId: 'textMatched' }, { messageId: 'textMatched' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// mock-state-reset
// ---------------------------------------------------------------------------

/** The suite shape of the finding: a default only one describe gets. */
const PARTIAL_DEFAULT = `
const mockModel = vi.fn();
describe('key', () => { it('k', () => { expect(KEY).toBe('k'); }); });
describe('identity', () => {
  beforeEach(() => { vi.clearAllMocks(); mockModel.mockReturnValue('SM-A155F'); });
  it('t', () => { SETTER; expect(resolve()).toBe('unresolved'); });
});`;

ruleTester.run('mock-state-reset', rules['mock-state-reset']!, {
  valid: [
    // Corrected: a top-level default covers every test.
    {
      filename: TEST_FILE,
      code: `const mockModel = vi.fn();
        beforeEach(() => { mockModel.mockReturnValue('x'); });
        describe('a', () => { it('k', () => { expect(1).toBe(1); }); });
        describe('b', () => { it('t', () => { mockModel.mockImplementation(() => { throw new Error('x'); }); expect(run()).toBe(1); }); });`,
    },
    // Corrected: a one-shot setter cannot leak.
    {
      filename: TEST_FILE,
      code: PARTIAL_DEFAULT.replace(
        'SETTER',
        `mockModel.mockImplementationOnce(() => { throw new Error('x'); })`,
      ),
    },
    // Corrected: reset after each test.
    {
      filename: TEST_FILE,
      code: `afterEach(() => vi.resetAllMocks());${PARTIAL_DEFAULT.replace('SETTER', 'mockModel.mockReturnValue(1)')}`,
    },
    {
      filename: TEST_FILE,
      code: `afterEach(() => { mockModel.mockReset(); });${PARTIAL_DEFAULT.replace('SETTER', 'mockModel.mockReturnValue(1)')}`,
    },
    // Near miss: restored by the test's own teardown.
    {
      filename: TEST_FILE,
      code: PARTIAL_DEFAULT.replace(
        'SETTER',
        'try { mockModel.mockReturnValue(1); } finally { mockModel.mockReset(); }',
      ),
    },
    // Near miss: a mock the file never gives a default.
    {
      filename: TEST_FILE,
      code: `const fn = vi.fn(); describe('a', () => { it('k', () => { expect(1).toBe(1); }); it('t', () => { fn.mockReturnValue(1); expect(fn()).toBe(1); }); });`,
    },
    // Near miss: mocks rebuilt in beforeEach, or local to the test.
    {
      filename: TEST_FILE,
      code: `let prisma; beforeEach(() => { prisma = { user: { find: vi.fn() } }; });
        it('t', () => { const local = vi.fn(); local.mockReturnValue(2); prisma.user.find.mockResolvedValue(1); expect(1).toBe(1); });`,
    },
    // Spies: restored by afterEach, by the test, or not a vitest spy.
    {
      filename: TEST_FILE,
      code: `describe('a', () => { afterEach(() => { vi.restoreAllMocks(); }); it('w', () => { vi.spyOn(console, 'warn'); expect(1).toBe(1); }); });
        it('x', () => { const warn = vi.spyOn(console, 'warn'); expect(1).toBe(1); warn.mockRestore(); });
        it('y', () => { sinon.spyOn(console, 'warn'); other.spyOn(a); expect(1).toBe(1); });
        vi.spyOn(console, 'log');`,
    },
  ],
  invalid: [
    // The throwing implementation reaches the 'key' test.
    {
      filename: TEST_FILE,
      code: PARTIAL_DEFAULT.replace(
        'SETTER',
        `mockModel.mockImplementation(() => { throw new Error('no bridge'); })`,
      ),
      errors: [{ messageId: 'implementationLeaks' }],
    },
    // The same through vi.mocked and a helper the hook calls.
    {
      filename: TEST_FILE,
      code: `import { read } from './store';
        function seed() { vi.mocked(read).mockReturnValue('a'); }
        describe('a', () => { beforeEach(() => seed()); it('k', () => { expect(1).toBe(1); }); });
        describe('b', () => { it('t', () => { vi.mocked(read).mockReturnValue('b'); expect(1).toBe(1); }); });`,
      errors: [{ messageId: 'implementationLeaks' }],
    },
    // A sibling describe restores, this one does not.
    {
      filename: TEST_FILE,
      code: `describe('view', () => {
          describe('gift', () => { it('w', () => { const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); build(); expect(warn).toHaveBeenCalled(); }); });
          describe('logged', () => { afterEach(() => { vi.restoreAllMocks(); }); it('v', () => { expect(1).toBe(1); }); });
        });`,
      errors: [{ messageId: 'spyLeaks', data: { target: 'console.warn' } }],
    },
    {
      filename: TEST_FILE,
      code: `it('w', () => { jest.spyOn(target, name); expect(1).toBe(1); });`,
      errors: [{ messageId: 'spyLeaks', data: { target: 'target.?' } }],
    },
  ],
});

// ---------------------------------------------------------------------------
// mock-export-parity
// ---------------------------------------------------------------------------

/** The module tree at the finding's commit, served through settings. */
const SOURCES: Record<string, string> = {
  '/repo/src/campaign-sync-service.ts':
    'export async function syncCampaigns() {}\nexport const campaignClock = () => 1;\n',
  '/repo/src/http.ts':
    'export class HttpRequestError extends Error {}\nexport async function getJson() {}\n',
  '/repo/src/star.ts': "export * from './other';\n",
  '/repo/src/mixed/index.ts':
    'const a = 1;\nconst b = 2;\nexport { a, b as c, type T };\nexport default a;\nexport enum Mode { A }\n',
};
const readSource = (path: string): string | null => SOURCES[path] ?? null;
const settings = { shuddhi: { readSource } };
const PARITY_FILE = '/repo/src/probe.test.ts';

ruleTester.run('mock-export-parity', rules['mock-export-parity']!, {
  valid: [
    // Corrected: the original module, with one override.
    {
      filename: PARITY_FILE,
      settings,
      code: `vi.mock('./http', async importOriginal => ({ ...(await importOriginal()), getJson: vi.fn() }));`,
    },
    {
      filename: PARITY_FILE,
      settings,
      code: `vi.mock('./http', () => ({ HttpRequestError: class extends Error {}, getJson: vi.fn() }));`,
    },
    {
      filename: PARITY_FILE,
      settings,
      code: `vi.mock('./mixed', () => { return { a: 1, c: 2, default: 3, Mode: {}, __esModule: true, ['x']: 1 }; });`,
    },
    // Near miss: what the rule cannot see it leaves alone.
    {
      filename: PARITY_FILE,
      settings,
      code: `vi.mock('./star', () => ({ anything: 1 })); vi.mock('./missing', () => ({ x: 1 })); vi.mock('pkg', () => ({ x: 1 })); vi.mock('./http'); vi.mock('./http', factory); vi.mock(name, () => ({})); jest.mock('./http', () => ({})); vi.mock('./http', () => { setup(); });`,
    },
    {
      filename: PARITY_FILE,
      settings,
      code: `vi.mock('./http', () => ({ ...base, x: 1 })); mock('./http', () => ({ x: 1 })); vi.other('./http', () => ({ x: 1 }));`,
    },
  ],
  invalid: [
    // The factory invents exports.
    {
      filename: PARITY_FILE,
      settings,
      code: `vi.mock('./campaign-sync-service.js', () => ({ syncCampaigns: vi.fn(), campaignClock: vi.fn(), markCampaignReread: vi.fn() }));`,
      errors: [
        {
          messageId: 'invented',
          data: {
            name: 'markCampaignReread',
            module: './campaign-sync-service.js',
          },
        },
      ],
    },
    // The runtime error class is dropped.
    {
      filename: PARITY_FILE,
      settings,
      code: `vi.mock('./http', () => ({ getJson: vi.fn() }));`,
      errors: [
        {
          messageId: 'classDropped',
          data: { name: 'HttpRequestError', module: './http' },
        },
      ],
    },
  ],
});

/** Without a settings reader the rule reads the disk: `fixtures/export-parity/svc.mjs`. */
const PARITY_DISK_TEST = join(
  HERE,
  'fixtures',
  'export-parity',
  'probe.test.ts',
);

ruleTester.run('mock-export-parity (disk)', rules['mock-export-parity']!, {
  valid: [
    {
      filename: PARITY_DISK_TEST,
      code: `vi.mock('./svc.mjs', () => ({ real: 1 })); vi.mock('./', () => ({ x: 1 }));`,
    },
  ],
  invalid: [
    {
      filename: PARITY_DISK_TEST,
      code: `vi.mock('./svc.mjs', () => ({ real: 1, fake: 2 }));`,
      errors: [{ messageId: 'invented' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// spawn-result-checked, local-tool-spawn, fixture-root-tracked
// ---------------------------------------------------------------------------

ruleTester.run('spawn-result-checked', rules['spawn-result-checked']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `const result = spawnSync('node', ['x']); expect(result.status).toBe(0); run();`,
    },
  ],
  invalid: [
    // The probe's failure is discarded.
    {
      filename: TEST_FILE,
      code: `it('a', () => { spawnSync('node', [script]); expect(existsSync(out)).toBe(false); });`,
      errors: [{ messageId: 'discarded' }],
    },
  ],
});

ruleTester.run('local-tool-spawn', rules['local-tool-spawn']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: "spawnSync('pnpm', ['exec', 'commitlint']); execSync('pnpm exec tsc'); log('npx'); execSync(cmd); execSync(`pnpm ${x}`); spawnSync(tool);",
    },
  ],
  invalid: [
    // npx can download a different version.
    {
      filename: TEST_FILE,
      code: "spawnSync('npx', ['commitlint', '--edit']); execSync('npx tsc --noEmit'); execSync(`npx eslint ${file}`);",
      errors: [
        { messageId: 'npx' },
        { messageId: 'npx' },
        { messageId: 'npx' },
      ],
    },
  ],
});

ruleTester.run('fixture-root-tracked', rules['fixture-root-tracked']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `let dir; beforeEach(() => { dir = mkdtempSync('x-'); }); afterEach(() => removeFixtureRoot(dir));`,
    },
    {
      filename: TEST_FILE,
      code: `const roots = []; function make() { const dir = mkdtempSync('x-'); roots.push(dir); return dir; } let other; function g() { other = compute(); other += 1; }`,
    },
    { filename: TEST_FILE, code: `let top; top = mkdtempSync('x-');` },
    // A repository helper is a fixture root only once the option names it.
    {
      filename: TEST_FILE,
      code: `let dir; function make() { dir = createFixtureRoot('x'); return dir; }`,
    },
  ],
  invalid: [
    // Each call overwrites the one slot cleanup reads.
    {
      filename: TEST_FILE,
      code: `let directory = null;
        afterEach(() => { if (directory !== null) removeFixtureRoot(directory); directory = null; });
        function historyFile(contents) { directory = mkdtempSync(join(tmpdir(), 'audit-')); writeFileSync(join(directory, 'h'), contents); return directory; }`,
      errors: [{ messageId: 'overwritten', data: { name: 'directory' } }],
    },
    {
      filename: TEST_FILE,
      code: `let dir; it('a', async () => { dir = await mkdtemp('x-'); expect(dir).toBeTruthy(); });`,
      errors: [{ messageId: 'overwritten' }],
    },
    {
      filename: TEST_FILE,
      options: [{ ownedRootCalls: ['createFixtureRoot', 'makeOwnedFixtureDir'] }],
      code: `let dir; function make() { dir = createFixtureRoot('x'); return dir; }`,
      errors: [{ messageId: 'overwritten', data: { name: 'dir' } }],
    },
  ],
});

// ---------------------------------------------------------------------------
// Extensions of rules other modules own: fake-timers `unpaired`,
// no-silent-early-return `loggedSkip`, git-spawn-env absolute path and
// `ambientEnv`.
// ---------------------------------------------------------------------------

ruleTester.run(
  'fake-timers-restored (unpaired)',
  rules['fake-timers-restored']!,
  {
    valid: [
      {
        filename: TEST_FILE,
        code: `beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); }); afterEach(() => { vi.useRealTimers(); });`,
      },
      {
        filename: TEST_FILE,
        code: `beforeEach(() => { vi.useFakeTimers({ toFake: list }); vi.useFakeTimers({ now: 1 }); vi.useFakeTimers(opts); }); afterEach(() => { vi.useRealTimers(); });`,
      },
    ],
    invalid: [
      // A faked timer whose real clear cannot cancel it.
      {
        filename: TEST_FILE,
        code: `beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] }); }); afterEach(() => { vi.useRealTimers(); });`,
        errors: [
          {
            messageId: 'unpaired',
            data: { missing: 'clearTimeout, clearInterval' },
          },
        ],
      },
    ],
  },
);

ruleTester.run(
  'no-silent-early-return (loggedSkip)',
  rules['no-silent-early-return']!,
  {
    valid: [
      {
        filename: TEST_FILE,
        code: `it('a', ctx => { if (!db) { console.warn('no db'); return ctx.skip('no db'); } expect(run()).toBe(1); });`,
      },
    ],
    invalid: [
      // A logged return still reports a pass.
      {
        filename: TEST_FILE,
        code: `it('a', async () => { if (!process.env.PERF) { console.log('skipping perf'); return; } expect(await measure()).toBeLessThan(5); });`,
        errors: [{ messageId: 'loggedSkip' }],
      },
    ],
  },
);

ruleTester.run('git-spawn-env (extensions)', rules['git-spawn-env']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `execFileSync('/usr/bin/git', ['status'], { env: hermeticGitEnv({ ...process.env, A: '1' }) });`,
    },
    {
      filename: TEST_FILE,
      code: `const fixtureOptions = { env: hermeticGitEnv() }; execFileSync('git', ['log'], fixtureOptions); function f(options) { execFileSync('git', [], options); }`,
    },
    {
      filename: TEST_FILE,
      code: `execFileSync('gitx', []); execFileSync('/usr/bin/git', [], { env: base }); execFileSync('git', [], { env: { HOME: home } });`,
    },
  ],
  invalid: [
    // An absolute path is the same git.
    {
      filename: TEST_FILE,
      code: `execFileSync('/usr/bin/git', ['init', dir]);`,
      errors: [{ messageId: 'inheritsEnv' }],
    },
    // Spreading process.env carries GIT_* in.
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['add', '.'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'a' } });`,
      errors: [{ messageId: 'ambientEnv' }],
    },
    // The same through two constants.
    {
      filename: TEST_FILE,
      code: `const fixtureEnv = { ...process.env, HOME: home }; const fixtureOptions = { env: fixtureEnv }; execFileSync('git', ['commit'], fixtureOptions); execFileSync('git', ['log'], { env: process.env });`,
      errors: [{ messageId: 'ambientEnv' }, { messageId: 'ambientEnv' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// Edges: each name a rule lists and each condition it tests, one case per
// branch, so a rule that drops one of them fails here.
// ---------------------------------------------------------------------------

/** One `code` per entry of `names`, each with the rule's same verdict. */
const each = (names: readonly string[], code: (name: string) => string) =>
  names.map(name => ({ filename: TEST_FILE, code: code(name) }));

ruleTester.run('no-fixed-sleep (edges)', rules['no-fixed-sleep']!, {
  valid: [
    // Every loop kind makes a short wait a polling interval.
    ...each(
      [
        'for (;;) { if (done()) break; await sleep(50); }',
        'for (const x of xs) await sleep(50);',
        'for (const k in o) await sleep(50);',
        'do { await sleep(50); } while (!done());',
      ],
      loop => `async function f(xs, o) { ${loop} }`,
    ),
    // A function named by its `const` that calls itself polls too.
    {
      filename: TEST_FILE,
      code: `const poll = async () => { if (done()) return; await pause(200); return poll(); };`,
    },
    // A delay four constants deep, or behind a non-product, is not fixed.
    {
      filename: TEST_FILE,
      code: `const A = 5000; const B = A; const C = B; const D = C; it('a', async () => { await sleep(D); });`,
    },
    {
      filename: TEST_FILE,
      code: `const A = 2; const B = A; const C = B; it('a', async () => { await sleep(C * 1000); await sleep(1000 * C); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', async () => { await sleep('100'); await sleep(1000 + 1000); await new Promise(r => setTimeout(r)); });`,
    },
    // The executor's first timer in source order decides, not field order.
    {
      filename: TEST_FILE,
      code: `async function f(fast) { await new Promise(r => { setImmediate(r); }); await new Promise(r => { if (fast) setTimeout(r, 0); else setTimeout(r, 5000); }); }`,
    },
  ],
  invalid: [
    // At module scope nothing polls.
    {
      filename: TEST_FILE,
      code: `await sleep(50);`,
      errors: [{ messageId: 'fixedSleep', data: { ms: '50' } }],
    },
    {
      filename: TEST_FILE,
      code: `const A = 5000; const B = A; const C = B; it('a', async () => { await sleep(C); await waitMs(500); });`,
      errors: [
        { messageId: 'fixedSleep', data: { ms: '5000' } },
        { messageId: 'fixedSleep', data: { ms: '500' } },
      ],
    },
    // A second between polls is the ceiling: a fixed sleep.
    {
      filename: TEST_FILE,
      code: `async function f() { while (!done()) await sleep(1000); }`,
      errors: [{ messageId: 'fixedSleep', data: { ms: '1000' } }],
    },
  ],
});

ruleTester.run('specific-rejection (edges)', rules['specific-rejection']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(res.status).toBe(201); expect(res.status).not.toBe(300); expect(res.status).not.toBe('250'); expect(res.status).not.toBe(100); });`,
    },
    {
      filename: TEST_FILE,
      code: `expect(errors).not.toBe(0); expect(errors.length).toBe(0); expect(errors.length).toBe(1); expect(errors.length).not.toBeGreaterThan(5); expect(errors.length).not.toHaveLength(0); expect(errors.length).toBeGreaterThan(n * 1);`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `expect(f).toThrowError(); expect(res.status).not.toStrictEqual(204);`,
      errors: [
        { messageId: 'bareThrow', data: { matcher: 'toThrowError' } },
        {
          messageId: 'notSuccess',
          data: { matcher: 'toStrictEqual', status: '204' },
        },
      ],
    },
    {
      filename: TEST_FILE,
      code: `it('a', async () => { expect((await getErrors()).length).toBeGreaterThan(0); });`,
      errors: [{ messageId: 'anyError', data: { name: 'getErrors' } }],
    },
    {
      filename: TEST_FILE,
      code: `expect(errors.length).not.toEqual(0); expect(errors).not.toStrictEqual([]);`,
      errors: [{ messageId: 'anyError' }, { messageId: 'anyError' }],
    },
    // A second count, or a length, does not pin an entry.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(errors.length).toBeGreaterThan(0); expect(errors.length).toBeLessThan(5); });`,
      errors: [{ messageId: 'anyError', data: { name: 'errors' } }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(errors.length).toBeGreaterThan(0); expect(errors).toHaveLength(2); });`,
      errors: [{ messageId: 'anyError', data: { name: 'errors' } }],
    },
  ],
});

ruleTester.run(
  'call-specific-matcher (edges)',
  rules['call-specific-matcher']!,
  {
    valid: [
      ...each(
        [
          'm.mockReset()',
          'm.mockRestore()',
          'vi.resetAllMocks()',
          'vi.restoreAllMocks()',
        ],
        clear =>
          `it('a', () => { expect(m).toHaveBeenCalledWith(op); ${clear}; expect(m).toHaveBeenCalledWith(op); });`,
      ),
      // Arguments are compared one by one: `(a, bc)` is not `(ab, c)`.
      {
        filename: TEST_FILE,
        code: `it('a', () => { expect(m).toHaveBeenCalledWith(a, bc); expect(m).toHaveBeenCalledWith(ab, c); });`,
      },
    ],
    invalid: [],
  },
);

ruleTester.run(
  'independent-expectation (edges)',
  rules['independent-expectation']!,
  {
    valid: [],
    invalid: [
      ...['toStrictEqual', 'toBe', 'toMatchObject'].map(matcher => ({
        filename: TEST_FILE,
        code: `expect(xs).${matcher}(xs.map(f));`,
        errors: [{ messageId: 'selfDerived', data: { subject: 'xs' } }],
      })),
      ...['slice', 'flatMap', 'toSorted', 'toReversed', 'concat', 'reduce'].map(
        method => ({
          filename: TEST_FILE,
          code: `expect(xs).toEqual(xs.${method}(f));`,
          errors: [{ messageId: 'selfDerived', data: { subject: 'xs' } }],
        }),
      ),
    ],
  },
);

ruleTester.run('owned-db-schema (edges)', rules['owned-db-schema']!, {
  // A regex literal is a pattern, not SQL the test runs.
  valid: [{ filename: TEST_FILE, code: `const re = /${CREATE} fixed/i;` }],
  invalid: [],
});

ruleTester.run('teardown-in-finally (edges)', rules['teardown-in-finally']!, {
  valid: [
    // A method that is not a cleanup; a declared function cannot fail.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const child = spawn('x'); await once(child, 'spawn'); child.send('x'); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { const child = spawn('x'); function h() { expect(1).toBe(1); } child.kill(); });`,
    },
    // Module scope and a try block are not a function's own sequence.
    {
      filename: TEST_FILE,
      code: `{ const child = spawn('x'); await once(child, 'spawn'); child.kill(); }`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', async () => { try { const child = spawn('x'); await once(child, 'spawn'); child.kill(); } finally { done(); } });`,
    },
    // The finally does not read what was opened before the try.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const unrelated = open(); await x(); try { await y(); } finally { cleanup(); } });`,
    },
  ],
  invalid: [
    ...[
      'cleanup',
      'teardown',
      'dispose',
      'stop',
      'kill',
      'close',
      'disconnect',
      'destroy',
      'terminate',
      'abort',
    ].map(name => ({
      filename: TEST_FILE,
      code: `it('a', async () => { const ${name} = await open(); expect(await read()).toBe(1); ${name}(); });`,
      errors: [{ messageId: 'afterFailure' }],
    })),
    ...[
      'stop',
      'close',
      'destroy',
      'disconnect',
      'terminate',
      'release',
      'dispose',
      'quit',
      'abort',
    ].map(method => ({
      filename: TEST_FILE,
      code: `it('a', async () => { const r = open(); await check(); r.${method}(); });`,
      errors: [{ messageId: 'afterFailure' }],
    })),
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const release = await lock(); expect(await read()).toBe(1); await release(); });`,
      errors: [{ messageId: 'afterFailure' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const server = new Server(); await server.listen(); try { await use(server); } finally { server.close(); } });`,
      errors: [{ messageId: 'workBeforeTry', data: { name: 'server' } }],
    },
  ],
});

ruleTester.run('cleanup-loop-settles (edges)', rules['cleanup-loop-settles']!, {
  // A loop in a plain function is not teardown.
  valid: [
    {
      filename: TEST_FILE,
      code: `function g() { for (const x of xs) { a(x); b(x); } }`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `afterEach(async () => { for (const s of stacks) { await s.stop(); rmSync(s.dir); } });`,
      errors: [{ messageId: 'aborts' }],
    },
  ],
});

ruleTester.run(
  'parse-structured-config (edges)',
  rules['parse-structured-config']!,
  {
    valid: [
      // Parsed by any of the parsers, so the text match is incidental.
      ...each(
        [
          'load',
          'loadAll',
          'safeLoad',
          'parseYaml',
          'parseDocument',
          'parseAllDocuments',
        ],
        parser =>
          `const t = readFileSync('a.yml', 'utf8'); ${parser}(t); t.includes('x');`,
      ),
      // Not a filter chain this rule can follow, or not a YAML filter.
      {
        filename: TEST_FILE,
        code: `const r = files.filter(f => /\\.ya?ml$/.test(f))[pick](file => readFileSync(file, 'utf8').includes('x')); const s = pick(files, f => /\\.ya?ml$/.test(f)).map(file => readFileSync(file, 'utf8').split('x')); const u = files.filter(f => f.endsWith('.md')).map(file => readFileSync(file, 'utf8').split('x'));`,
      },
      // JSX text is not a path.
      {
        filename: 'probe.test.tsx',
        code: `const t = readFileSync(<p>ci.yml</p>, 'utf8'); expect(t).toContain('a');`,
      },
    ],
    invalid: [
      ...[
        'includes',
        'match',
        'matchAll',
        'indexOf',
        'search',
        'startsWith',
        'endsWith',
        'replace',
        'replaceAll',
      ].map(method => ({
        filename: TEST_FILE,
        code: `const t = readFileSync('a.yml', 'utf8'); t.${method}('x');`,
        errors: [{ messageId: 'textMatched' }],
      })),
      {
        filename: TEST_FILE,
        code: `const t = readFileSync('ci.yml', 'utf8'); /cache:/.exec(t);`,
        errors: [{ messageId: 'textMatched' }],
      },
    ],
  },
);

/** PARTIAL_DEFAULT with `SETTER` replaced, after `prefix`. */
const partial = (setter: string, prefix = '') =>
  `${prefix}${PARTIAL_DEFAULT.replace('SETTER', setter)}`;

ruleTester.run('mock-state-reset (edges)', rules['mock-state-reset']!, {
  valid: [
    // Undone by the test's own teardown, or by every afterEach.
    {
      filename: TEST_FILE,
      code: partial(
        'onTestFinished(() => mockModel.mockReset()); mockModel.mockReturnValue(1)',
      ),
    },
    {
      filename: TEST_FILE,
      code: partial(
        'try { mockModel.mockReturnValue(1); } finally { mockModel.mockRestore(); }',
      ),
    },
    {
      filename: TEST_FILE,
      code: partial(
        'mockModel.mockReturnValue(1)',
        'afterEach(() => { mockModel.mockRestore(); });',
      ),
    },
    {
      filename: TEST_FILE,
      code: partial(
        'mockModel.mockReturnValue(1)',
        'afterEach(() => vi.restoreAllMocks());',
      ),
    },
    // Spies restored by a mockRestore in afterEach, or restoreAllMocks in the test.
    {
      filename: TEST_FILE,
      code: `let warn; afterEach(() => { warn.mockRestore(); }); it('w', () => { warn = vi.spyOn(console, 'warn'); expect(1).toBe(1); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('x', () => { vi.spyOn(console, 'warn'); expect(1).toBe(1); vi.restoreAllMocks(); });`,
    },
    // Rebuilt in a beforeEach, so each test starts fresh.
    {
      filename: TEST_FILE,
      code: `let m = vi.fn();
        describe('a', () => { beforeEach(() => { m = vi.fn(); m.mockReturnValue(1); }); it('t', () => { m.mockReturnValue(2); expect(1).toBe(1); }); });
        describe('b', () => { it('k', () => { expect(1).toBe(1); }); });`,
    },
    // Helpers are followed two levels deep, not three.
    {
      filename: TEST_FILE,
      code: `const m = vi.fn();
        function h3() { m.mockReturnValue(1); }
        function h2() { h3(); }
        function h1() { h2(); }
        describe('a', () => { beforeEach(() => h1()); it('k', () => { expect(1).toBe(1); }); });
        describe('b', () => { it('t', () => { m.mockReturnValue(2); expect(1).toBe(1); }); });`,
    },
    // Every test in the file gets the default.
    {
      filename: TEST_FILE,
      code: `const m = vi.fn();
        describe('a', () => { beforeEach(() => { m.mockReturnValue(1); }); it('k', () => { expect(1).toBe(1); }); it('t', () => { m.mockReturnValue(2); expect(1).toBe(1); }); });`,
    },
    // A local of the same name, a bare setter, and a setter on a call.
    {
      filename: TEST_FILE,
      code: `const m = vi.fn();
        describe('a', () => { beforeEach(() => { m.mockReturnValue(1); }); it('k', () => { expect(1).toBe(1); }); });
        describe('b', () => { it('t', () => { const m = vi.fn(); m.mockReturnValue(2); mockReturnValue(1); make().mockReturnValue(2); expect(m()).toBe(2); }); });`,
    },
  ],
  invalid: [
    ...['mockResolvedValue', 'mockRejectedValue'].map(setter => ({
      filename: TEST_FILE,
      code: partial(`mockModel.${setter}(1)`),
      errors: [
        {
          messageId: 'implementationLeaks',
          data: { setter, mock: 'mockModel' },
        },
      ],
    })),
    // An arrow helper the hook calls sets the default; a global call is no helper.
    {
      filename: TEST_FILE,
      code: `import { read } from './store';
        const seed = () => { vi.mocked(read).mockReturnValue('a'); };
        describe('a', () => { beforeEach(() => { resetStore(); seed(); }); it('k', () => { expect(1).toBe(1); }); });
        describe('b', () => { it('t', () => { vi.mocked(read).mockReturnValue('b'); expect(1).toBe(1); }); });`,
      errors: [
        {
          messageId: 'implementationLeaks',
          data: { setter: 'mockReturnValue', mock: 'read' },
        },
      ],
    },
    // A mock on an object's property.
    {
      filename: TEST_FILE,
      code: `const api = { load: vi.fn() };
        describe('a', () => { beforeEach(() => { api.load.mockReturnValue(1); }); it('k', () => { expect(1).toBe(1); }); });
        describe('b', () => { it('t', () => { api.load.mockReturnValue(2); expect(1).toBe(1); }); });`,
      errors: [
        {
          messageId: 'implementationLeaks',
          data: { setter: 'mockReturnValue', mock: 'api.load' },
        },
      ],
    },
    // A finally that does not reset it, a reset in a plain nested function,
    // and an afterEach that only clears calls.
    {
      filename: TEST_FILE,
      code: partial(
        'try { mockModel.mockReturnValue(1); } finally { cleanup(); }',
      ),
      errors: [{ messageId: 'implementationLeaks' }],
    },
    {
      filename: TEST_FILE,
      code: partial(
        'mockModel.mockReturnValue(1); function undo() { mockModel.mockReset(); }',
      ),
      errors: [{ messageId: 'implementationLeaks' }],
    },
    {
      filename: TEST_FILE,
      code: partial(
        'mockModel.mockReturnValue(1)',
        'afterEach(() => { mockModel.mockClear(); });',
      ),
      errors: [{ messageId: 'implementationLeaks' }],
    },
    // Reassigned only outside a beforeEach: not rebuilt per test.
    {
      filename: TEST_FILE,
      code: `let m = vi.fn();
        function make() { m = vi.fn(); }
        afterEach(() => { m = vi.fn(); });
        describe('a', () => { beforeEach(() => { m.mockReturnValue(1); }); it('k', () => { expect(1).toBe(1); }); it('t', () => { m.mockReturnValue(2); expect(1).toBe(1); }); });
        describe('b', () => { it('j', () => { expect(make()).toBe(undefined); }); });`,
      errors: [{ messageId: 'implementationLeaks' }],
    },
    // An afterEach that restores nothing, and a spy with no arguments.
    {
      filename: TEST_FILE,
      code: `afterEach(() => { cleanup(); }); it('w', () => { vi.spyOn(console, 'warn'); expect(1).toBe(1); });
        it('v', () => { vi.spyOn(); expect(1).toBe(1); });`,
      errors: [
        { messageId: 'spyLeaks', data: { target: 'console.warn' } },
        { messageId: 'spyLeaks', data: { target: '?.?' } },
      ],
    },
  ],
});

/** SOURCES plus a module whose index is a .tsx file. */
const edgeSettings = {
  shuddhi: {
    readSource: (path: string): string | null =>
      path === '/repo/src/view/index.tsx'
        ? 'export const View = 1;\n'
        : readSource(path),
  },
};

ruleTester.run('mock-export-parity (edges)', rules['mock-export-parity']!, {
  valid: [
    // A bare specifier is a package, even when a sibling file shares its name.
    {
      filename: PARITY_FILE,
      settings: edgeSettings,
      code: `vi.mock('http', () => ({ x: 1 })); vi.mock(5, () => ({ x: 1 }));`,
    },
  ],
  invalid: [
    {
      filename: PARITY_FILE,
      settings: edgeSettings,
      code: `vi.mock('./mixed', () => ({ nope: 1, b: 2, 'type T': 3 })); vi.mock('./view', () => ({ nope: 1 }));`,
      errors: [
        { messageId: 'invented', data: { name: 'nope', module: './mixed' } },
        { messageId: 'invented', data: { name: 'b', module: './mixed' } },
        { messageId: 'invented', data: { name: 'type T', module: './mixed' } },
        { messageId: 'invented', data: { name: 'nope', module: './view' } },
      ],
    },
    {
      filename: PARITY_FILE,
      settings: edgeSettings,
      code: `vi.mock('./http', () => { return { getJson: vi.fn() }; });`,
      errors: [
        {
          messageId: 'classDropped',
          data: { name: 'HttpRequestError', module: './http' },
        },
      ],
    },
  ],
});

describe('mock-export-parity re-reads a module whose mtime moved', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'c05-parity-'));
  });
  afterEach(() => {
    removeRoot(root);
  });

  it('judges the mock against the module as it is now', () => {
    const module = join(root, 'svc.mjs');
    const linter = new Linter({ cwd: root });
    const config = [
      {
        files: ['**/*.ts'],
        plugins: {
          probe: {
            rules: { parity: rules['mock-export-parity'] },
          } as unknown as NonNullable<Linter.Config['plugins']>[string],
        },
        rules: { 'probe/parity': 'error' as const },
      },
    ];
    const lint = () =>
      linter
        .verify(
          `vi.mock('./svc.mjs', () => ({ a: 1 }));`,
          config,
          join(root, 'probe.test.ts'),
        )
        .map(message => message.messageId);
    writeFileSync(module, 'export const a = 1;\n');
    utimesSync(module, 1_000, 1_000);
    assert.deepEqual(lint(), []);
    writeFileSync(module, 'export const b = 1;\n');
    utimesSync(module, 2_000, 2_000);
    assert.deepEqual(lint(), ['invented']);
  });
});

ruleTester.run('fixture-root-tracked (edges)', rules['fixture-root-tracked']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `let dir; let state; beforeAll(() => { dir = mkdtempSync('x-'); }); it('a', () => { dir += mkdtempSync('y-'); state.dir = mkdtempSync('z-'); });`,
    },
  ],
  invalid: [],
});

// ---------------------------------------------------------------------------
// Every candidate rule's meta, word for word: what a finding says is what the
// rule is for.
// ---------------------------------------------------------------------------

/** [rule, docs.description, messages]; every rule is a `problem`. */
const META: [string, string, Record<string, string>][] = [
  [
    'no-fixed-sleep',
    'Tests wait for state, not for a fixed time (harness family)',
    {
      fixedSleep:
        'A fixed {{ms}} ms wait stands in for the event the test needs. On a loaded runner it is too short and the test flakes; on an idle one it is time wasted, and a timer left by an earlier test can still land in this one. Poll the state with a deadline (`vi.waitFor`, `waitFor`), or use fake timers and advance them.',
    },
  ],
  [
    'specific-rejection',
    'A rejection test names the rejection it expects (assertion family)',
    {
      bareThrow:
        'A bare `{{matcher}}()` passes for any error: a TypeError from a broken fixture or a different exception class satisfies it as well as the rejection under test. Pass the class, message or a matcher for the error you expect.',
      notSuccess:
        '`not.{{matcher}}({{status}})` passes for every other status, a 500 from a crash included. Assert the exact status (and diagnostic) this rejection should produce.',
      anyError:
        'Any {{name}} satisfies a non-empty count, including one about a different field or an unrelated breakage, so the check you mean can disappear while this passes. Assert the expected entry: its property, constraint, code or message.',
    },
  ],
  [
    'call-specific-matcher',
    'A repeated call assertion pins the call it means (assertion family)',
    {
      anyCall:
        'This repeats an earlier `toHaveBeenCalledWith` on the same mock with the same arguments, and the matcher accepts ANY call, so the first call already satisfies it and the second call is never checked. Use `toHaveBeenNthCalledWith(n, ...)` or `toHaveBeenLastCalledWith(...)`, or clear the mock between the calls.',
    },
  ],
  [
    'independent-expectation',
    'An expected value is not derived from the value under test (oracle family)',
    {
      selfDerived:
        'The expected value is built from `{{subject}}`, the value under test, so it agrees with whatever was observed: an empty sample set equals an empty `.map()` of itself. Write the expected value independently (a literal, a count you fixed in the test).',
    },
  ],
  [
    'owned-db-schema',
    'Database fixtures create schemas they own (fixture family)',
    {
      adopted: `\`${CREATE} IF NOT EXISTS\` adopts a schema this run did not create, and this file drops schemas: the teardown can then delete another run's (or a developer's) objects. Create a uniquely named schema and drop only what this run created.`,
      fixedName:
        'A fixed schema name collides with an interrupted earlier run (the CREATE fails) and with a concurrent one (both share it). Derive a unique name per run and drop it in teardown.',
    },
  ],
  [
    'teardown-in-finally',
    'Cleanup of what a test started runs even when the test fails (fixture family)',
    {
      afterFailure:
        'This cleanup runs only if everything before it passed: a failed assertion or a rejected wait above skips it and leaves the process, lock or connection behind for the rest of the run. Register it right after the resource exists (`try { ... } finally { ... }`, `onTestFinished`).',
      workBeforeTry:
        '`{{name}}` is cleaned up in the `finally` below, but this statement runs first and can throw, skipping the `finally` entirely. Open the `try` immediately after `{{name}}` exists.',
      stateFromTry:
        "The `finally` reads `{{name}}`, which is only assigned inside the `try`: when the try fails before that assignment, the cleanup has nothing to work from. Derive what the cleanup needs before the `try`, or independently of the test's progress.",
    },
  ],
  [
    'cleanup-loop-settles',
    'A teardown loop finishes every resource even when one step fails (fixture family)',
    {
      aborts:
        "The first failing step in this teardown loop throws out of it: the rest of this resource's cleanup and every later resource are skipped and leak. Settle each step (`Promise.allSettled`, or `try/catch` per step) and report the failures together.",
    },
  ],
  [
    'parse-structured-config',
    'Tests read YAML and JSON by parsing them, not by matching text (assertion family)',
    {
      textMatched:
        'This reads a structured file and matches its text: a quoting or indentation variant slips past the pattern, and a match anywhere in the file accepts the key in the wrong object. Parse it (`load` from js-yaml, `JSON.parse`) and assert on the value where it must be.',
    },
  ],
  [
    'mock-state-reset',
    'Mock state a test sets does not outlive it (fixture family)',
    {
      implementationLeaks:
        'This `{{setter}}` on `{{mock}}` outlives the test: `vi.clearAllMocks()` clears calls, not implementations. A `beforeEach` in this file gives `{{mock}}` a default, but not every test gets that hook, and those tests then pass or fail by run order. Use `{{setter}}Once`, re-set the mock in a `beforeEach` that covers every test, or reset with `vi.resetAllMocks()`.',
      spyLeaks:
        'This spy replaces `{{target}}` for every later test in the file: no `afterEach` around this test restores it, and the test does not either. Restore in `afterEach` (`vi.restoreAllMocks()`), `onTestFinished`, or a `finally`.',
    },
  ],
  [
    'mock-export-parity',
    'A whole-module mock matches the module it replaces (fixture family)',
    {
      invented:
        '`{{name}}` is not exported by `{{module}}`: the mock invents API the code under test cannot be calling, while the export it does call is missing. Mock with `importOriginal` and override, or type the factory with `typeof import(...)`.',
      classDropped:
        'This whole-module mock drops the runtime class `{{name}}` that `{{module}}` exports: code under test that throws or checks `instanceof {{name}}` now gets `undefined` and fails with a TypeError, so the failure path is never tested. Spread `await importOriginal()` and override only what the test controls.',
    },
  ],
  [
    'spawn-result-checked',
    'A negative control proves its probe ran (harness family)',
    {
      discarded:
        '`spawnSync` does not throw when the child fails to start or exits non-zero, and this result is discarded: an absence assertion after it passes even if the probe never ran. Keep the result and assert its `error` and `status` first.',
    },
  ],
  [
    'local-tool-spawn',
    'Tests run the pinned local tool, not npx (harness family)',
    {
      npx: '`npx` falls back to downloading whatever version the registry serves, and a failed download exits non-zero just like the rejection under test. Run the pinned binary (`pnpm exec <tool>` or `node_modules/.bin/<tool>`) and assert the diagnostic, not only the exit code.',
    },
  ],
  [
    'fixture-root-tracked',
    'Every fixture root a helper makes is tracked for cleanup (fixture family)',
    {
      overwritten:
        'Each call stores its new directory in the single `{{name}}` slot the cleanup reads, so every earlier one from the same test leaks. Push each root to a list the cleanup drains, or make one root per test in `beforeEach`.',
    },
  ],
];

/** The one candidate rule that takes options, and the options it takes. */
const WITH_OPTIONS: Record<string, unknown> = {
  'fixture-root-tracked': {
    schema: [
      {
        type: 'object',
        properties: {
          ownedRootCalls: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ ownedRootCalls: [] }],
  },
};

describe('candidate rule meta', () => {
  it('states each rule and each finding word for word', () => {
    assert.deepEqual(
      META.map(([name]) => name),
      C05_CANDIDATE_RULES,
    );
    for (const [name, description, messages] of META) {
      assert.deepEqual(
        (rules[name] as unknown as { meta: unknown }).meta,
        {
          type: 'problem',
          docs: { description },
          ...((WITH_OPTIONS[name] as object | undefined) ?? { schema: [] }),
          messages,
        },
        name,
      );
    }
  });
});
