#!/usr/bin/env node
/**
 * The rule-check CLI, `dist/rule-checks/cli.js`.
 *
 *   cli.js [--checks <module>] [--registry <json>] [--fires-dir <dir>]
 *     The hook. Reads one Claude Code hook event on stdin, runs the
 *     consumer's checks on it (runtime.ts) and answers on stdout; exits 0.
 *     --checks     the consumer's checks module, a file Node can import
 *                  (`.js`, `.mjs`, or `.ts` that Node strips types from). It
 *                  exports `CHECKS`, or a default export, a list of `Check`
 *                  (runtime.ts). Env: KAVACH_RULE_CHECKS.
 *     --registry   the consumer's rule registry JSON (registry.ts). Optional:
 *                  without one every rule reads as unregistered and a refusal
 *                  says to ask "the repository owner". Env: KAVACH_RULE_REGISTRY.
 *     --fires-dir  the fire-log folder. Default: `.tmp/rule-checks` in the
 *                  primary checkout of the session's `cwd`. Env:
 *                  KAVACH_RULE_FIRES_DIR.
 *     A flag wins over its variable. Relative paths resolve against
 *     CLAUDE_PROJECT_DIR, else the current folder.
 *     Fails open: a missing or broken checks module, a bad flag, or any crash
 *     is answered with a warning and a crash row in the fire log, and the call
 *     goes ahead. A crash it could not catch exits non-zero, which Claude Code
 *     reports as a non-blocking error.
 *
 *   cli.js count [--registry <json>] [--root <dir>] [--json]
 *     How many registry rules no enforcer file in the checkout enforces.
 *   cli.js latency [--root <dir>] [--rounds N]
 *     Time the checkout's Bash PreToolUse hooks (latency.ts).
 *   cli.js push-marker write|clear <git-dir> <pid>
 *     Write or clear a push's marker, from a pre-push hook (live-runs.ts).
 *
 * A hook registration, in `.claude/settings.json`:
 *   "command": "node node_modules/@veda-hq/kavach/dist/rule-checks/cli.js
 *               --checks rules/checks.ts --registry rules/registry.json"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { onlyKnown, option } from './args.ts';
import { isCliEntry } from './cli-entry.ts';
import { FIRES_DIR_ENV } from './fire-log.ts';
import { main as latency } from './latency.ts';
import { liveEffects, main as pushMarker } from './live-runs.ts';
import { main as count, REGISTRY_ENV, STDIO } from './registry.ts';
import { type Check, liveDeps, runHook } from './runtime.ts';

/** The environment variable the hook reads the checks module from. */
export const CHECKS_ENV = 'KAVACH_RULE_CHECKS';

type Env = Readonly<Record<string, string | undefined>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTexts = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Does `value` have the shape of a `Check`? */
export function isCheck(value: unknown): value is Check {
  return (
    isRecord(value) &&
    typeof value['rule'] === 'string' &&
    isTexts(value['events']) &&
    (value['tools'] === undefined || isTexts(value['tools'])) &&
    typeof value['cost'] === 'string' &&
    typeof value['instead'] === 'string' &&
    typeof value['run'] === 'function'
  );
}

/** The checks a loaded module exports as `CHECKS`, else as its default export; throws naming what is wrong. */
export function checksOf(loaded: unknown, where: string): readonly Check[] {
  const exported = isRecord(loaded) ? (loaded['CHECKS'] ?? loaded['default']) : undefined;
  if (!Array.isArray(exported)) {
    throw new Error(`${where} exports no list of checks (as CHECKS or its default export)`);
  }
  const checks: Check[] = [];
  for (const [i, item] of (exported as readonly unknown[]).entries()) {
    if (!isCheck(item)) {
      throw new Error(`${where}: check ${i} is not a check (rule, events, cost, instead and run)`);
    }
    checks.push(item);
  }
  return checks;
}

/** Import the consumer's checks module at `path`. */
export async function loadChecks(path: string): Promise<readonly Check[]> {
  const loaded: unknown = await import(pathToFileURL(path).href);
  return checksOf(loaded, path);
}

/** A flag's value, else its variable's; undefined when neither names one. */
function chosen(argv: readonly string[], flag: string, env: Env, name: string): string | undefined {
  const value = option(argv, flag) ?? env[name];
  return value === '' ? undefined : value;
}

/** The hook: the answer to one hook event on `stdin`. Never throws. */
export async function hook(argv: readonly string[], stdin: string, env: Env): Promise<string> {
  const base = env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  const at = (path: string | undefined): string | undefined => (path === undefined ? undefined : resolve(base, path));
  let registry: string | undefined;
  let firesDir: string | undefined;
  let checks: readonly Check[] | (() => readonly Check[]);
  try {
    // The fire-log folder first, so that any failure after it is logged there.
    firesDir = at(chosen(argv, '--fires-dir', env, FIRES_DIR_ENV));
    registry = at(chosen(argv, '--registry', env, REGISTRY_ENV));
    onlyKnown(argv, ['--checks', '--registry', '--fires-dir']);
    const path = at(chosen(argv, '--checks', env, CHECKS_ENV));
    if (path === undefined) throw new Error(`no checks module: pass --checks or set ${CHECKS_ENV}`);
    checks = await loadChecks(path);
  } catch (error) {
    // fail-open: the runtime logs the failure as its own crash, under the event.
    const failure = error instanceof Error ? error : new Error(String(error));
    checks = () => {
      throw failure;
    };
  }
  return runHook(stdin, { ...liveDeps(env, { registry, firesDir }), checks });
}

export type Io = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** The hook's answer, written as it is. */
  readonly write: (text: string) => void;
};

/** The CLI; returns the exit status. */
export async function run(argv: readonly string[], io: Io, stdin: () => string, env: Env): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'count') return count(rest, io, process.cwd(), env);
  if (command === 'push-marker') return pushMarker(rest, liveEffects, io.err);
  if (command === 'latency') {
    try {
      await latency(rest, process.cwd(), io.out);
      return 0;
    } catch (error) {
      io.err(`latency: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  io.write(await hook(argv, stdin(), env));
  return 0;
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await run(
    process.argv.slice(2),
    {
      ...STDIO,
      write: (text) => {
        process.stdout.write(text);
      },
    },
    () => readFileSync(0).toString(),
    process.env,
  );
}
