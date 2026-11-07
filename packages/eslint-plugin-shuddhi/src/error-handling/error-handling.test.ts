import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { errorHandlingRules, rules } from './index.js';

/** The project root ERR-08's `allow` paths are relative to, in these tests. */
const ROOT = '/work/repo';

/**
 * Each `historical` case is the reviewer finding named in the catalogue, as
 * it was reported or as its minimal equivalent. Every rule also gets its
 * corrected case, near-misses that must stay quiet, and a guard-removal flip:
 * the corrected case with only its guard deleted fails again, for the rule's
 * own message.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

/**
 * The options a project passes when its wrappers ship in a package
 * (`@acme/shared`) and inside it in an `error-handling` module.
 */
const HELPERS = {
  helperModule: '@acme/shared',
  helperSourcePattern: '^(?:@acme\\/shared|\\.{1,2}\\/(?:.*\\/)?error-handling)$',
};

/** The runner options a project with `scripts/lib/run-child.ts` passes. */
const RUNNER = {
  allow: ['scripts/lib/run-child.ts'],
  runner: 'scripts/lib/run-child.ts',
  root: ROOT,
};

interface Cases {
  valid: ({ options?: unknown[] } & Record<string, unknown>)[];
  invalid: ({ options?: unknown[] } & Record<string, unknown>)[];
}

/** Gives every case the options a project passes. */
function withOptions(options: unknown[], { valid, invalid }: Cases): never {
  const add = (test: Record<string, unknown>) => ({ ...test, options });
  return { valid: valid.map(add), invalid: invalid.map(add) } as never;
}

/** Every rule on, with the project's options, as one flat-config block. */
const PROJECT_RULES = {
  'shuddhi/no-swallowed-catch': 'error',
  'shuddhi/safe-log': ['error', HELPERS],
  'shuddhi/no-raw-error-string': [
    'error',
    { helperModule: HELPERS.helperModule },
  ],
  'shuddhi/no-direct-child-process': ['error', RUNNER],
} as const;

/** Lints `code` with the given rules on and returns the messages. */
function lint(
  code: string,
  ruleConfig: Record<string, unknown>,
  filename = 'fixture.ts',
): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: { parser: tseslint.parser as never },
        plugins: { shuddhi: { rules: errorHandlingRules } },
        rules: ruleConfig as Linter.RulesRecord,
      },
    ],
    filename,
  );
}

/** Lints `code` with one rule on (project options) and returns its ids. */
function messageIds(rule: string, code: string): string[] {
  const id = `shuddhi/${rule}`;
  return lint(code, {
    [id]: PROJECT_RULES[id as keyof typeof PROJECT_RULES],
  }).map(message => message.messageId ?? message.message);
}

// ---------------------------------------------------------------- ERR-01
// A mobile database migration logged a non-duplicate-column failure and
// carried on, so the migration was marked complete although the ALTER failed.
const ERR01_HISTORICAL = `
try {
  database.execute('ALTER TABLE Inventory ADD COLUMN extraQty INTEGER DEFAULT 0;');
} catch (e: any) {
  if (!e.message?.includes('duplicate column name')) {
    console.error('[Database] Failed to add column extraQty to Inventory', e);
  }
}`;
const ERR01_CORRECTED = ERR01_HISTORICAL.replace(
  "to Inventory', e);",
  "to Inventory', e);\n    throw e;",
);

ruleTester.run('no-swallowed-catch', errorHandlingRules['no-swallowed-catch'], {
  valid: [
    {
      name: 'ERR-01 corrected: the non-duplicate error is rethrown',
      code: ERR01_CORRECTED,
    },
    {
      name: 'annotated fail-open at the top of the handler',
      code: `try { run(); } catch {\n  // fail-open: a missing cache file means a cold start\n  return undefined;\n}`,
    },
    {
      name: 'annotation between the try block and catch',
      code: `try { run(); } // fail-open: best-effort cleanup\ncatch { cleanup(); }`,
    },
    {
      name: 'Promise.reject propagates',
      code: `p.catch(e => Promise.reject(wrap(e)));`,
    },
    {
      name: 'a returned or awaited Promise.reject propagates',
      code: `p.catch(async e => { if (x) return Promise.reject(e); await Promise.reject(e); });`,
    },
    {
      name: 'a throwing .catch callback',
      code: `p.catch(e => { throw wrap(e); });`,
    },
    {
      name: 'reject() in an executor propagates',
      code: `new Promise((resolve, reject) => { try { resolve(run()); } catch (e) { reject(e); } });`,
    },
    {
      name: 'a settle-once fail() wrapper propagates (socket client)',
      code: `new Promise((resolve, reject) => { let done = false; const fail = e => { if (!done) { done = true; reject(e); } }; socket.on('data', chunk => { try { resolve(JSON.parse(chunk)); } catch { fail(new Error('Invalid response JSON')); } }); });`,
    },
    {
      name: 'a non-zero exit propagates',
      code: `try { run(); } catch (e) { report(e); process.exit(1); }`,
    },
    {
      name: 'setting a failing exit code propagates',
      code: `try { run(); } catch { process.exitCode = 2; }`,
    },
    {
      name: 'annotated .catch with an expression body',
      code: `p.catch(/* fail-open: optional telemetry */ () => null);`,
    },
    {
      name: 'annotation above a chained .catch',
      code: `fetchIt()\n  // fail-open: offline is fine here\n  .catch(() => null);`,
    },
    { name: 'a named handler is not inspected', code: `p.catch(handleError);` },
    {
      name: 'a computed catch member is not a promise catch',
      code: `p['catch'](() => null);`,
    },
    { name: 'catch() with no argument', code: `p.catch();` },
  ],
  invalid: [
    {
      name: 'ERR-01 historical (a migration that carried on)',
      code: ERR01_HISTORICAL,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'empty .catch callback',
      code: `p.catch(() => {});`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'fallback .catch callback',
      code: `p.catch(() => null);`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'comment-only block (passes no-empty today)',
      code: `try { run(); } catch { /* ignore */ }`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'a throw in a nested function does not propagate',
      code: `try { run(); } catch (e) { setTimeout(() => { throw e; }); }`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'an annotation after the first statement does not count',
      code: `try { run(); } catch (e) { log(e);\n  // fail-open: too late\n}`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'an annotation with no reason does not count',
      code: `try { run(); } catch { // fail-open:\n}`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'a floating Promise.reject does not propagate',
      code: `p.catch(e => { Promise.reject(e); return null; });`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'process.exit(0) is success',
      code: `try { run(); } catch { process.exit(0); }`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'a throw a nested try/catch takes back does not propagate',
      code: `try { run(); } catch (e) { try { throw e; } catch { /* fail-open: inner */ } }`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'an awaited rejection a nested try/catch takes back does not propagate',
      code: `async function f() { try { await run(); } catch (e) { try { await Promise.reject(e); } catch { /* fail-open: inner */ } } }`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'a fail() that only records is not a rejection',
      code: `function fail(e) { record(e); } p.catch(error => { fail(error); });`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'a reject() that is not an executor parameter is not a rejection',
      code: `function f(reject) { try { a(); } catch (e) { reject(e); } }`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'an argumentless process.exit keeps the current code, normally 0',
      code: `try { run(); } catch { process.exit(); }`,
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'process.exitCode = 0 is success',
      code: `try { run(); } catch { process.exitCode = 0; }`,
      errors: [{ messageId: 'swallowed' }],
    },
  ],
});

// ------------------------------------------------------- ERR-02 + OBS-03
// A watchdog's catch-path deps.log() that throws escapes the per-probe
// containment.
const ERR02_HISTORICAL = `
export async function runProbes(deps: { readHeartbeatAgeMs(): Promise<number>; log(line: string): void }, evidence: string[]) {
  try {
    await deps.readHeartbeatAgeMs();
  } catch (error) {
    evidence.push('dead-man switch: heartbeat read FAILED');
    deps.log('watchdog: heartbeat probe failed');
  }
}`;
const WRAPPERS = "import { safeInvoke, safeLog } from '@acme/shared';\n";
const ERR02_CORRECTED =
  WRAPPERS +
  ERR02_HISTORICAL.replace(
    "deps.log('watchdog: heartbeat probe failed')",
    "safeLog(deps.log, 'watchdog: heartbeat probe failed')",
  );
// A dispatcher's plan(): a throwing optional `idleFillLog` escapes plan().
// OBS-03 is the same rule as ERR-02.
const OBS03_HISTORICAL = `
export function plan(state: { idleFillLog?: (line: string) => void }): void {
  const idleFillLog = state.idleFillLog ?? (() => {});
  idleFillLog('idle-fill offered');
}`;
const OBS03_CORRECTED = `${WRAPPERS}
export function plan(state: { idleFillLog?: (line: string) => void }): void {
  safeLog(state.idleFillLog, 'idle-fill offered');
}`;

ruleTester.run('safe-log', errorHandlingRules['safe-log'], withOptions([HELPERS], {
  valid: [
    { name: 'ERR-02 corrected: safeLog(deps.log, …)', code: ERR02_CORRECTED },
    { name: 'OBS-03 corrected', code: OBS03_CORRECTED },
    {
      name: 'safeInvoke around console in a catch',
      code:
        WRAPPERS +
        `try { a(); } catch (e) { safeInvoke(() => console.error(e)); }`,
    },
    {
      name: 'the real helper imported under another name',
      code: "import { safeInvoke as contain } from '@acme/shared'; function f(deps) { contain(() => deps.log('x')); }",
    },
    {
      name: 'a sink returned from a safeInvoke block',
      code:
        WRAPPERS +
        `function f(deps) { safeInvoke(() => { return deps.log('x'); }); }`,
    },
    {
      name: 'a sink awaited in an async safeInvoke callback',
      code:
        WRAPPERS +
        `function f(deps) { safeInvoke(async () => { await deps.log('x'); }); }`,
    },
    {
      name: 'console as a statement in a safeInvoke block (synchronous)',
      code:
        WRAPPERS +
        `try { a(); } catch (e) { safeInvoke(() => { console.error(e); }); }`,
    },
    {
      name: 'an awaited sink call inside a local try/catch',
      code: `async function f(deps) { try { await deps.log('x'); } catch { /* */ } }`,
    },
    {
      name: 'console inside a local try/catch on a catch path',
      code: `try { a(); } catch (e) { try { console.error(e); } catch { /* */ } }`,
    },
    {
      name: 'a sink whose result the caller reads (backpressure)',
      code: `function f(out) { if (!out.write('x')) wait(); }`,
    },
    {
      name: "a bound arrow returning the sink's decision",
      code: `const decide = deps => deps.onDecide?.(1);`,
    },
    {
      name: 'a sink whose result is returned',
      code: `function f(deps) { return deps.onDecide?.(1); }`,
    },
    {
      name: "the class's own logger (Nest)",
      code: `class S { logger = new Logger(); run() { this.logger.log('x'); } }`,
    },
    {
      name: "the class's own method",
      code: `class S { logError(e) {} run() { try { a(); } catch (e) { this.logError(e); } } }`,
    },
    { name: 'console outside a catch path', code: `console.error('boot');` },
    {
      name: 'console in a function nested inside a catch',
      code: `try { a(); } catch (e) { queue(() => console.error(e)); }`,
    },
    {
      name: 'a shadowed console',
      code: `function f(console) { try { a(); } catch { console.error('x'); } }`,
    },
    {
      name: 'a module-level log function is not injected',
      code: `function log(x) {} function f() { log('x'); }`,
    },
    {
      name: 'a parameter that is not a sink name',
      code: `function f(logger) { logger.info('x'); }`,
    },
    {
      name: 'a non-optional on-callback',
      code: `function f(deps) { deps.onDone(1); }`,
    },
    {
      name: 'an optional prop callback in JSX',
      code: `function C({ onClose }) { onClose?.(); }`,
      filename: 'c.tsx',
    },
    {
      name: 'an unrelated container',
      code: `function f(ctx) { ctx.store.log('x'); }`,
    },
    {
      name: 'a local variable from a non-member init',
      code: `function f() { const runLog = make(); runLog('x'); }`,
    },
    { name: 'an unresolved global sink name', code: `writeLog('x');` },
    {
      name: 'write on a plain parameter is an operation, not telemetry',
      code: `function save(out, data) { out.write(data); }`,
    },
    {
      name: 'a bare write parameter called directly',
      code: `function f({ write }) { write('x'); }`,
    },
    {
      name: 'this.write is not a carried sink',
      code: `class S { run() { this.write('x'); } }`,
    },
    {
      name: 'a computed member',
      code: `function f(deps) { deps['log']('x'); }`,
    },
    {
      name: 'a container on a call result is not injected',
      code: `function f() { make().deps.log('x'); }`,
    },
  ],
  invalid: [
    {
      name: 'ERR-02 historical (a watchdog probe log escaping containment)',
      code: ERR02_HISTORICAL,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'OBS-03 historical (an optional idle-fill log escaping plan())',
      code: OBS03_HISTORICAL,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'a log parameter',
      code: `function f(log) { log('x'); }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'an optional destructured write parameter',
      code: `function f({ write }) { write?.('x'); }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'write carried in a deps container',
      code: `function f(deps) { deps.write('x'); }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'beat carried in a nested container',
      code: `function f(ctx) { ctx.hooks.beat(); }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'an optional beat callback',
      code: `function f(deps) { deps.beat?.(); }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'this.log that the class did not define',
      code: `class S { constructor(private readonly log: (s: string) => void) {} run() { this.log('x'); } }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'a nested deps container',
      code: `function f(ctx) { ctx.deps.logError('x'); }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'an optional on-callback',
      code: `function f(deps) { deps.onProgress?.(1); }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'a container deeper inside a parameter',
      code: `function f(ctx) { ctx.app.deps.log('x'); }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'a sink member of a parameter',
      code: `function f(options) { options.logOnce('x'); }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'a try without await does not absorb an async rejection',
      code: `function f(deps) { try { deps.log('x'); } catch { /* */ } }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'a try does not reach across a function boundary',
      code: `function f(deps) { try { setTimeout(() => deps.log('x')); } catch { /* */ } }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'a namesake imported from an unrelated module',
      code: "import { safeInvoke } from './run-now'; function f(deps) { safeInvoke(() => deps.log('x')); }",
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'a local function that only shares the helper name',
      code: "const safeInvoke = cb => cb(); function f(deps) { safeInvoke(() => deps.log('x')); }",
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'a sink as a statement in a safeInvoke block hands back no rejection',
      code:
        WRAPPERS + `function f(deps) { safeInvoke(() => { deps.log('x'); }); }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'a try/finally without catch absorbs nothing',
      code: `async function f(deps) { try { await deps.log('x'); } finally { done(); } }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'a voided sink call',
      code: `function f(deps) { void deps.onProgress?.(1); }`,
      errors: [{ messageId: 'injected' }],
    },
    {
      name: 'console.error in a catch clause',
      code: `try { a(); } catch (e) { console.error(e); }`,
      errors: [{ messageId: 'catchConsole' }],
    },
    {
      // Workspace configs declare `console` as a global; it must still count.
      name: 'console declared as a configured global',
      code: `try { a(); } catch (e) { console.error(e); throw e; }`,
      languageOptions: { globals: { console: 'readonly' } },
      errors: [{ messageId: 'catchConsole' }],
    },
    {
      name: 'console.warn in a .catch callback',
      code: `p.catch(e => console.warn(e));`,
      errors: [{ messageId: 'catchConsole' }],
    },
    {
      name: 'console in an uncaughtException handler',
      code: `process.on('uncaughtException', e => { console.error(e); });`,
      errors: [{ messageId: 'catchConsole' }],
    },
  ],
}));

// ---------------------------------------------------------------- ERR-03
// A flag reconciler: `String(error)` in the per-flag catch can throw and
// abort the whole reconciler loop. The same idiom
// (`e instanceof Error ? e.message : String(e)`) is common in catch blocks.
const ERR03_HISTORICAL = `
for (const flag of flags) {
  try {
    await reconcile(flag);
  } catch (error) {
    skipped.push(\`\${flag} failed (skipped): \${error instanceof Error ? error.message : String(error)}\`);
  }
}`;
const ERR03_CORRECTED = ERR03_HISTORICAL.replace(
  'error instanceof Error ? error.message : String(error)',
  'errorDetail(error)',
);

ruleTester.run(
  'no-raw-error-string',
  errorHandlingRules['no-raw-error-string'],
  {
    valid: [
      { name: 'ERR-03 corrected: errorDetail(error)', code: ERR03_CORRECTED },
      {
        name: 'String() of something else',
        code: `try { a(); } catch (e) { log(String(count)); }`,
      },
      {
        name: 'passing the error on as a value',
        code: `try { a(); } catch (e) { report(e); throw e; }`,
      },
      {
        name: 'reading .code for control flow',
        code: `try { a(); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }`,
      },
      {
        name: 'e.message not used as text',
        code: `try { a(); } catch (e: any) { const m = e.message; use(m); }`,
      },
      {
        name: 'String(e) outside any error handler',
        code: `function f(e) { return String(e); }`,
      },
      {
        name: 'a catch with no binding',
        code: `try { a(); } catch { log('x'); }`,
      },
      {
        name: 'a destructured catch binding',
        code: `try { a(); } catch ({ message }) { log(message); }`,
      },
      {
        name: 'a tagged template hands the tag the raw value',
        code: 'try { a(); } catch (e) { structuredLog`failed: ${e} ${e.message}`; }',
      },
      {
        name: 'arithmetic with the caught value',
        code: `try { a(); } catch (e: any) { total = 1 + e.count; }`,
      },
      {
        name: 'a non-error process event',
        code: `process.on('exit', code => log(\`\${code}\`));`,
      },
      {
        name: 'toString taken but not called',
        code: `try { a(); } catch (e) { const f = e.toString; use(f); }`,
      },
    ],
    invalid: [
      {
        name: 'ERR-03 historical (String(error) in a reconciler loop)',
        code: ERR03_HISTORICAL,
        errors: [{ messageId: 'raw' }, { messageId: 'raw' }],
      },
      {
        name: 'String() of a caught member',
        code: 'try { a(); } catch (e: any) { log(String(e.message)); }',
        errors: [{ messageId: 'raw' }],
      },
      {
        name: 'toString() of a caught member',
        code: 'try { a(); } catch (e: any) { log((e as Error).stack.toString()); }',
        errors: [{ messageId: 'raw' }],
      },
      {
        name: 'a caught value in a template',
        code: 'try { a(); } catch (e) { log(`failed: ${e}`); }',
        errors: [{ messageId: 'raw' }],
      },
      {
        name: 'e.toString()',
        code: `try { a(); } catch (e) { log(e.toString()); }`,
        errors: [{ messageId: 'raw' }],
      },
      {
        name: 'e.stack concatenated',
        code: `try { a(); } catch (e: any) { log('trace: ' + e.stack); }`,
        errors: [{ messageId: 'raw' }],
      },
      {
        name: 'a cast caught value in a template',
        code: 'try { a(); } catch (e) { log(`${(e as Error).message}`); }',
        errors: [{ messageId: 'raw' }],
      },
      {
        name: 'String(err) in a .catch callback',
        code: `p.catch(err => log(String(err)));`,
        errors: [{ messageId: 'raw' }],
      },
      {
        name: 'an unhandledRejection handler',
        code: "process.on('unhandledRejection', reason => { log(`unhandled: ${reason}`); });",
        errors: [{ messageId: 'raw' }],
      },
      {
        name: 'concatenated on the right',
        code: `try { a(); } catch (e) { log(e + ' happened'); }`,
        errors: [{ messageId: 'raw' }],
      },
    ],
  },
);

// ---------------------------------------------------------------- ERR-08
// A hand-rolled `spawn` wrapper in a review script reported SIGINT/SIGHUP
// cancellation as 143.
const ERR08_HISTORICAL = `
import { spawn } from 'node:child_process';
export function runReviewProcess(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { detached: true });
    child.on('close', code => resolve(code ?? 143));
  });
}`;
const ERR08_CORRECTED = `
import { runChild } from '../lib/run-child.ts';
export async function runReviewProcess(command, args) {
  const outcome = await runChild(command, args);
  return outcome.code;
}`;

ruleTester.run(
  'no-direct-child-process',
  errorHandlingRules['no-direct-child-process'],
  {
    valid: [
      { name: 'ERR-08 corrected: runChild()', code: ERR08_CORRECTED },
      {
        name: 'sync APIs are outside the rule',
        code: `import { execFileSync, spawnSync } from 'node:child_process';`,
      },
      {
        name: 'a spawn from another module',
        code: `import { spawn } from 'cross-spawn'; spawn('x');`,
      },
      {
        name: 'the runner itself',
        code: `import { spawn } from 'node:child_process';`,
        filename: join(ROOT, 'scripts/lib/run-child.ts'),
        options: [RUNNER],
      },
      {
        name: 'a namespace used for sync APIs only',
        code: `import * as cp from 'child_process'; cp.execSync('x');`,
      },
      {
        name: 'require destructuring sync APIs',
        code: `const { execSync } = require('child_process');`,
      },
      { name: 'an unrelated spawn member', code: `worker.spawn('x');` },
      {
        name: 'a parameter shadowing the namespace',
        code: `import * as cp from 'child_process'; cp.execSync('x'); function run(cp) { cp.spawn('x'); }`,
      },
      {
        name: 'a parameter shadowing a required namespace',
        code: `const cp = require('child_process'); function run(cp) { cp.exec('x'); }`,
      },
      {
        name: 'a dynamically computed member on a namespace',
        code: `import * as cp from 'child_process'; const spawn = pick(); cp[spawn]('x'); cp[\`\${spawn}\`]('x');`,
      },
      {
        name: 'a numeric key in a required pattern',
        code: `const { 0: first } = require('child_process');`,
      },
      {
        name: 'an unrelated require',
        code: `const { spawn } = require('other');`,
      },
      {
        name: 'an unrelated dynamic import',
        code: `const { spawn } = await import('other');`,
      },
      {
        name: 'a rest element in the pattern',
        code: `const { ...cp } = require('child_process');`,
      },
      { name: 'a declarator without init', code: `let x;` },
      {
        name: 'an alias of an unrelated object',
        code: `const worker = makeWorker(); const w = worker; w.spawn('x');`,
      },
      {
        name: 'an alias of a shadowing parameter',
        code: `import * as cp from 'child_process'; cp.execSync('x'); function run(cp) { const c = cp; c.spawn('x'); }`,
      },
    ],
    invalid: [
      {
        name: 'ERR-08 historical (a hand-rolled spawn wrapper)',
        code: ERR08_HISTORICAL,
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'exec and execFile imports',
        code: `import { exec, execFile } from 'child_process';`,
        errors: [{ messageId: 'direct' }, { messageId: 'direct' }],
      },
      {
        name: 'a string-named import',
        code: `import { 'spawn' as s } from 'child_process';`,
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'a namespace import',
        code: `import * as cp from 'node:child_process'; cp.spawn('x');`,
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'a default import',
        code: `import cp from 'child_process'; cp.execFile('x');`,
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'require destructuring',
        code: `const { spawn } = require('node:child_process');`,
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'statically computed and quoted keys in a pattern',
        code: `const { ['spawn']: run, 'exec': ex, [\`execFile\`]: ef } = require('node:child_process');`,
        errors: [
          { messageId: 'direct' },
          { messageId: 'direct' },
          { messageId: 'direct' },
        ],
      },
      {
        name: 'statically computed members',
        code: `import * as cp from 'child_process'; cp['spawn']('x'); require('child_process')[\`exec\`]('x');`,
        errors: [{ messageId: 'direct' }, { messageId: 'direct' }],
      },
      {
        name: 'an alias of a namespace import',
        code: `import * as cp from 'child_process'; const cp2 = cp; cp2.spawn('x');`,
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'an alias of an alias of a required namespace',
        code: `function run() { return c.exec('x'); } const c = b; const b = a; const a = require('child_process');`,
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'destructuring an alias',
        code: `import * as cp from 'child_process'; const { execFile } = cp;`,
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'require namespace',
        code: `const cp = require('child_process'); cp.exec('x');`,
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'a direct require member',
        code: `require('child_process').spawn('x');`,
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'a dynamic import',
        code: `const { spawn } = await import('node:child_process');`,
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'another file is not the runner',
        code: `import { spawn } from 'child_process';`,
        filename: join(ROOT, 'scripts/other.ts'),
        options: [RUNNER],
        errors: [{ messageId: 'direct' }],
      },
      {
        name: 'a nested file sharing the runner suffix',
        code: `import { spawn } from 'child_process';`,
        filename: join(ROOT, 'packages/tool/scripts/lib/run-child.ts'),
        options: [RUNNER],
        errors: [{ messageId: 'direct' }],
      },
    ],
  },
);

// ------------------------------------------------- options and defaults

ruleTester.run('safe-log defaults', errorHandlingRules['safe-log'], {
  valid: [
    {
      name: 'a relative error-handling module is the wrapper by default',
      code: "import { safeLog } from '../lib/error-handling'; function f(deps) { safeLog(() => deps.log('x')); }",
    },
  ],
  invalid: [
    {
      name: 'a package import is not the wrapper without helperSourcePattern',
      code: "import { safeInvoke } from '@acme/shared'; function f(deps) { safeInvoke(() => deps.log('x')); }",
      errors: [{ messageId: 'injected' }],
    },
  ],
});

ruleTester.run(
  'no-direct-child-process root',
  errorHandlingRules['no-direct-child-process'],
  {
    valid: [
      {
        // RuleTester lints an absolute filename with the filesystem root as
        // ESLint's working directory, so `allow` is relative to that.
        name: 'allow is relative to the working directory without root',
        code: `import { spawn } from 'node:child_process';`,
        filename: join(ROOT, 'scripts/lib/run-child.ts'),
        options: [{ allow: ['work/repo/scripts/lib/run-child.ts'] }],
      },
    ],
    invalid: [
      {
        name: 'a root-relative allow path needs root',
        code: `import { spawn } from 'node:child_process';`,
        filename: join(ROOT, 'scripts/lib/run-child.ts'),
        options: [{ allow: ['scripts/lib/run-child.ts'] }],
        errors: [{ messageId: 'direct' }],
      },
    ],
  },
);

describe('message wording', () => {
  const textOf = (code: string, ruleConfig: Record<string, unknown>) =>
    lint(code, ruleConfig).map(message => message.message);

  it('names the configured helper module and runner', () => {
    assert.deepEqual(
      textOf(
        "function f(deps) { deps.log('x'); } try { a(); } catch (e) { console.error(`${e}`); }\nimport { spawn } from 'child_process';",
        PROJECT_RULES,
      ),
      [
        'A caller-supplied sink (`deps.log`) can throw or reject, and that escapes the code meant to contain it. Call it through `safeLog(sink, ...args)` or `safeInvoke(() => ...)` from @acme/shared (ERR-02, OBS-03).',
        'This catch swallows the error: nothing rethrows, rejects or exits non-zero. Rethrow it, or, if carrying on is correct, put `// fail-open: <reason>` at the top of the handler (ERR-01).',
        '`console.error` on a catch path can throw and replace the error being handled. Use `safeInvoke(() => console.error(...))` from @acme/shared (ERR-02).',
        '`e` stringifies a caught value, which can itself throw (a hostile toString, a Symbol, a null `.message`) and abort the handler. Use `errorDetail(e)` from @acme/shared (ERR-03).',
        '`spawn` from child_process reports a signal death as whatever exit code the caller guesses (SIGINT and SIGHUP became 143). Use `runChild()` from scripts/lib/run-child.ts, whose outcome union separates ok, exit, signal, spawn-error and timeout (ERR-08).',
      ],
    );
  });

  it('reads as a sentence with no options', () => {
    const messages = textOf(
      "function f(deps) { deps.log('x'); } try { a(); } catch (e) { console.error(`${e}`); throw e; }\nimport { spawn } from 'child_process';",
      {
        'shuddhi/safe-log': 'error',
        'shuddhi/no-raw-error-string': 'error',
        'shuddhi/no-direct-child-process': 'error',
      },
    );
    assert.equal(messages.length, 4);
    for (const message of messages.slice(0, 3))
      assert.match(message, /from your error-handling module \(ERR-0[23]/);
    assert.match(
      messages[3] ?? '',
      /Use `runChild\(\)` from your process-runner module, whose/,
    );
  });

  it('refuses an unknown option', () => {
    assert.throws(
      () =>
        lint('x();', {
          'shuddhi/safe-log': ['error', { helper: '@acme/shared' }],
        }),
      /should NOT have additional properties/,
    );
  });
});

describe('family entry', () => {
  it('exports every rule under its name', () => {
    assert.deepEqual(Object.keys(rules).sort(), [
      'no-direct-child-process',
      'no-raw-error-string',
      'no-swallowed-catch',
      'safe-log',
    ]);
    for (const [name, rule] of Object.entries(rules))
      assert.equal(rule, errorHandlingRules[name as keyof typeof rules]);
  });
});

describe('guard removal flips each corrected case', () => {
  const unguarded: Record<string, string> = {
    'no-swallowed-catch': '',
    'safe-log': 'deps.log(',
    'no-raw-error-string': 'String(error)',
    'no-direct-child-process': "{ spawn } from 'node:child_process'",
  };
  const cases: [string, string, string, string][] = [
    ['no-swallowed-catch', ERR01_CORRECTED, '\n    throw e;', 'swallowed'],
    ['safe-log', ERR02_CORRECTED, 'safeLog(deps.log, ', 'injected'],
    ['no-raw-error-string', ERR03_CORRECTED, 'errorDetail(error)', 'raw'],
    [
      'no-direct-child-process',
      ERR08_CORRECTED,
      "{ runChild } from '../lib/run-child.ts'",
      'direct',
    ],
  ];
  for (const [rule, corrected, guard, messageId] of cases) {
    it(rule, () => {
      assert.ok(corrected.includes(guard));
      assert.deepEqual(messageIds(rule, corrected), []);
      assert.deepEqual(
        messageIds(rule, corrected.replace(guard, unguarded[rule] ?? '')),
        [messageId],
      );
    });
  }

  it('the fail-open annotation is the guard for a deliberate swallow', () => {
    const annotated = `try { run(); } catch {\n  // fail-open: cold start\n  return;\n}`;
    assert.deepEqual(messageIds('no-swallowed-catch', annotated), []);
    assert.deepEqual(
      messageIds(
        'no-swallowed-catch',
        annotated.replace('fail-open: cold start', 'cold start'),
      ),
      ['swallowed'],
    );
  });

  it('OBS-03: routing the optional sink through safeLog is the guard', () => {
    assert.deepEqual(messageIds('safe-log', OBS03_CORRECTED), []);
    assert.deepEqual(messageIds('safe-log', OBS03_HISTORICAL), ['injected']);
  });
});

