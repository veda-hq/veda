/**
 * The one way the corpus runs a child process: a fixture's git, a row's bash,
 * a guard.
 *
 * The child leads its own process group. The whole group is sent SIGKILL the
 * moment the child exits and at the deadline, and the outcome is held back
 * until the group is empty, so a background descendant cannot outlive the
 * call and write into a fixture that is about to be deleted. A descendant that
 * left the group and still holds the pipes gets a short drain, then the pipes
 * are cut.
 *
 * The outcome says what happened — `ok`, `exit`, `signal`, `spawn-error` or
 * `timeout` — and carries a shell-style code: 128 + signal number, 124 for a
 * timeout, 127 for a missing binary, 126 for any other spawn failure.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

/** How much of stderr an outcome keeps by default: the tail holds the reason. */
export const STDERR_TAIL_CHARS = 4096;
/** How long the pipes may stay open after the child itself has exited. */
export const EXIT_DRAIN_MS = 1000;
/** How long an emptied group is waited for after its SIGKILL. */
const GONE_WAIT_MS = 2000;
const GONE_POLL_MS = 5;

interface Output {
  readonly stdout: string;
  readonly stderrTail: string;
}

export type ChildOutcome =
  | ({ readonly kind: 'ok'; readonly code: 0 } & Output)
  | ({ readonly kind: 'exit'; readonly code: number } & Output)
  | ({
      readonly kind: 'signal';
      readonly signal: NodeJS.Signals;
      readonly code: number;
    } & Output)
  | ({
      readonly kind: 'spawn-error';
      readonly errno: string;
      readonly code: 126 | 127;
    } & Output)
  | ({ readonly kind: 'timeout'; readonly code: 124 } & Output);

export interface RunChildOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. */
  readonly input?: string;
  /** SIGKILL the child's group past this many milliseconds; 0: no deadline. */
  readonly timeoutMs?: number;
  /** How much of stderr the outcome keeps. */
  readonly stderrTailChars?: number;
}

function spawnFailure(error: unknown, output: Output): ChildOutcome {
  const errno = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
  return {
    kind: 'spawn-error',
    errno,
    code: errno === 'ENOENT' ? 127 : 126,
    ...output,
  };
}

function classify(
  code: number | null,
  signal: NodeJS.Signals | null,
  timedOut: boolean,
  output: Output,
): ChildOutcome {
  if (timedOut) return { kind: 'timeout', code: 124, ...output };
  if (signal !== null) {
    const number = constants.signals[signal] as number | undefined;
    return { kind: 'signal', signal, code: 128 + (number ?? 0), ...output };
  }
  if (code === 0) return { kind: 'ok', code: 0, ...output };
  return { kind: 'exit', code: code ?? 1, ...output };
}

/** Runs `command args` and resolves with its outcome; never rejects. */
export function runChild(
  command: string,
  args: readonly string[],
  options: RunChildOptions = {},
): Promise<ChildOutcome> {
  const tailChars = options.stderrTailChars ?? STDERR_TAIL_CHARS;
  return new Promise(resolve => {
    let stdout = '';
    let stderrTail = '';
    const output = (): Output => ({ stdout, stderrTail });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      // A synchronous spawn failure (a NUL in an argument) is this API's
      // spawn-error outcome, not a rejection.
      resolve(spawnFailure(error, output()));
      return;
    }

    let timedOut = false;
    let exited = false;
    /** The group has read as empty once: its id may now be reused. */
    let groupGone = false;
    let deadline: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;

    const isGone = (error: unknown): boolean =>
      (error as NodeJS.ErrnoException).code === 'ESRCH';
    const killGroup = (): void => {
      const { pid } = child;
      if (pid === undefined || groupGone) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        // The group is gone (ESRCH, remembered) or refused the signal; the
        // child itself is still ours to stop either way.
        groupGone = isGone(error);
        child.kill('SIGKILL');
      }
    };
    const groupAlive = (): boolean => {
      const { pid } = child;
      if (pid === undefined || groupGone) return false;
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        // ESRCH is the answer (the group is empty). Any other error proves
        // nothing gone, so the group counts as alive until the wait ends.
        groupGone = isGone(error);
        return !groupGone;
      }
    };
    /** Resolves once the group is empty, or after GONE_WAIT_MS at most. */
    const settle = (outcome: ChildOutcome): void => {
      const until = Date.now() + GONE_WAIT_MS;
      const poll = (): void => {
        if (!groupAlive() || Date.now() >= until) {
          resolve(outcome);
          return;
        }
        setTimeout(poll, GONE_POLL_MS);
      };
      poll();
    };

    const stdoutText = new StringDecoder();
    const stderrText = new StringDecoder();
    const appendStderr = (text: string): void => {
      stderrTail = (stderrTail + text).slice(-tailChars);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += stdoutText.write(chunk);
    });
    child.stdout.on('end', () => {
      stdout += stdoutText.end();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      appendStderr(stderrText.write(chunk));
    });
    child.stderr.on('end', () => {
      appendStderr(stderrText.end());
    });
    child.on('error', error => {
      // 'error' before the spawn means it never started; 'close' may not follow.
      if (child.pid === undefined) {
        clearTimeout(deadline);
        resolve(spawnFailure(error, output()));
      }
    });
    child.on('exit', () => {
      exited = true;
      clearTimeout(deadline);
      killGroup();
      // A descendant outside the group may hold the pipes open indefinitely.
      drain = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }, EXIT_DRAIN_MS);
    });
    child.on('close', (code, signal) => {
      clearTimeout(drain);
      settle(classify(code, signal, timedOut, output()));
    });
    // A child that exits before reading its input closes the pipe under us.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');

    const timeoutMs = options.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      deadline = setTimeout(() => {
        // A starved loop can reach an overdue deadline with the exit already
        // waiting: the kill waits one poll phase, and a child that ended on
        // its own is never a timeout.
        setImmediate(() => {
          if (exited) return;
          timedOut = true;
          killGroup();
        });
      }, timeoutMs);
    }
  });
}
