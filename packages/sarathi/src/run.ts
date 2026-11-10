/**
 * Runs one event's handlers side by side, as Claude Code runs a settings
 * block's hooks: each gets the event on stdin and the session's environment,
 * and each is stopped at its own timeout.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TIMEOUT_SECONDS, type Config, type Entry, type Guard } from './config.ts';

export interface Outcome {
  /** What the entry ran, for messages: its command, or `kavach <guard> guard`. */
  readonly label: string;
  /** The exit code; `null` when the handler was stopped or could not start. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Any end but exit 0 refuses. */
  readonly failClosed: boolean;
}

const GUARD_SCRIPTS: Readonly<Record<Guard, string>> = {
  worktree: 'worktree_guard.py',
  command: 'command_guard.py',
};

/** The folder holding kavach's Python guards, from this package's own dependency. */
export function kavachDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@veda-hq/kavach/package.json')), 'python', 'kavach');
}

export interface Plan {
  readonly label: string;
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly failClosed: boolean;
}

/** The folder holding sarathi's own handlers (hooks/), given to every command as SARATHI_HOOKS. */
export function hooksDir(): string {
  return fileURLToPath(new URL('../hooks', import.meta.url));
}

/** How one entry runs: a command through `sh -c` with SARATHI_HOOKS set, a guard through the configured Python. */
export function plan(entry: Entry, config: Config, guardDir: () => string = kavachDir, handlers: () => string = hooksDir): Plan {
  const timeoutMs = (entry.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  if (entry.guard !== undefined) {
    const env: Record<string, string> = config.kavach.config === undefined ? {} : { KAVACH_CONFIG: config.kavach.config };
    return {
      label: `kavach ${entry.guard} guard`,
      file: config.kavach.python,
      args: [join(guardDir(), GUARD_SCRIPTS[entry.guard])],
      env,
      timeoutMs,
      failClosed: true,
    };
  }
  const command = entry.command ?? '';
  return { label: command, file: '/bin/sh', args: ['-c', command], env: { SARATHI_HOOKS: handlers() }, timeoutMs, failClosed: entry.failClosed === true };
}

/** Runs one plan with `input` on stdin. Never rejects: a handler that cannot start ends with code `null`. */
export function runPlan(step: Plan, input: string, cwd: string): Promise<Outcome> {
  return new Promise(done => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({
        label: step.label,
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + extra,
        timedOut,
        failClosed: step.failClosed,
      });
    };
    const child = spawn(step.file, [...step.args], {
      cwd,
      env: { ...process.env, ...step.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone: the close event still comes
      }
    }, step.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', error => finish(null, `${step.label} could not start (${error.message})\n`));
    child.on('close', code => finish(timedOut ? null : code));
    child.stdin.on('error', () => {
      // a handler that exits without reading its input is not a failure
    });
    child.stdin.end(input);
  });
}

/** Runs every entry at once and returns their outcomes in the entries' order. */
export function runAll(entries: readonly Entry[], config: Config, input: string, cwd: string): Promise<Outcome[]> {
  return Promise.all(entries.map(entry => runPlan(plan(entry, config), input, cwd)));
}
