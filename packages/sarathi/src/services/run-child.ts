/**
 * Runs an asynchronous child process and says how it ended, for the Docker
 * sweep (`prune.ts`) and the tools that run it.
 *
 * WHY AN OUTCOME UNION
 * --------------------
 * Every hand-rolled `spawn` wrapper has to decide what a child that died of a
 * signal "exited with", and each decides differently: a wrapper that reports
 * SIGINT and SIGHUP cancellation as 143, the SIGTERM code, leaves its caller
 * unable to tell which signal stopped the run. Here the outcome says what
 * happened — `ok`, `exit`, `signal`, `spawn-error` or `timeout` — and a caller
 * switches over `kind` exhaustively. The shell-style `code` is derived once,
 * by rule: 128 + signal number, 124 for a timeout, 127 for a missing binary,
 * 126 for any other spawn failure.
 *
 * This module runs in the sweep's launchd copy, so it uses Node built-ins only.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

/** How much of stderr an outcome keeps: the tail is where the reason is. */
export const STDERR_TAIL_BYTES = 4096;
/** Grace between our stop signal and SIGKILL after a timeout. */
export const KILL_GRACE_MS = 2000;
/** How long the pipes may stay open after the child itself has exited. */
export const EXIT_DRAIN_MS = 1000;
/** The deadline's stop signal. */
const STOP_SIGNAL: NodeJS.Signals = 'SIGTERM';

/**
 * How a child ended. `stdout` is kept whole, since callers parse it (the
 * sweep reads `docker image inspect`'s JSON), so it is unbounded: run only
 * commands whose output fits in memory. `stderrTail` keeps the last
 * STDERR_TAIL_BYTES.
 */
export type ChildOutcome =
  | { kind: 'ok'; code: 0; stdout: string; stderrTail: string }
  | { kind: 'exit'; code: number; stdout: string; stderrTail: string }
  | { kind: 'signal'; signal: NodeJS.Signals; code: number; stdout: string; stderrTail: string }
  | { kind: 'spawn-error'; errno: string; message: string; code: 126 | 127; stdout: string; stderrTail: string }
  | { kind: 'timeout'; timeoutMs: number; code: 124; stdout: string; stderrTail: string };

/** What the process reported, before interpretation. */
export interface ChildExitFacts {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError: NodeJS.ErrnoException | null;
  /** Our own deadline fired and we sent the kill. */
  timedOut: boolean;
  timeoutMs: number;
  stdout: string;
  stderrTail: string;
}

/** 128 + the signal's number, the shell convention for a signal death. */
export function signalExitCode(signal: NodeJS.Signals): number {
  const number = constants.signals[signal] as number | undefined;
  return 128 + (number ?? 0);
}

/**
 * Interprets the facts. Precedence, each for a reason:
 * 1. spawn-error — the child never ran, so no code or signal means anything.
 * 2. timeout — our kill, whatever the child did with it: a child that traps
 *    SIGTERM and exits 0 or 143 was still stopped by the deadline.
 * 3. signal — beats a code when both are reported; the code is then only the
 *    shell's rendering of the same death.
 * 4. exit / ok by code.
 */
export function classifyChildExit(facts: ChildExitFacts): ChildOutcome {
  const { stdout, stderrTail } = facts;
  if (facts.spawnError) {
    const errno = facts.spawnError.code ?? 'UNKNOWN';
    return { kind: 'spawn-error', errno, message: facts.spawnError.message, code: errno === 'ENOENT' ? 127 : 126, stdout, stderrTail };
  }
  if (facts.timedOut) return { kind: 'timeout', timeoutMs: facts.timeoutMs, code: 124, stdout, stderrTail };
  if (facts.signal) return { kind: 'signal', signal: facts.signal, code: signalExitCode(facts.signal), stdout, stderrTail };
  if (facts.code === 0) return { kind: 'ok', code: 0, stdout, stderrTail };
  return { kind: 'exit', code: facts.code ?? 1, stdout, stderrTail };
}

/** One line saying how a child that did not succeed ended, with stderr's last line. */
export function failure(outcome: Exclude<ChildOutcome, { kind: 'ok' }>): string {
  const reason =
    outcome.kind === 'exit'
      ? `exit ${outcome.code}`
      : outcome.kind === 'signal'
        ? `signal ${outcome.signal}`
        : outcome.kind === 'timeout'
          ? `timed out after ${outcome.timeoutMs} ms`
          : outcome.message;
  const stderr = outcome.stderrTail.trim().split('\n').pop();
  return stderr ? `${reason}: ${stderr}` : reason;
}

/**
 * Keeps the last `limit` UTF-8 bytes of a growing text, starting on a whole
 * character: a cut inside a multi-byte sequence drops its continuation bytes.
 */
export function appendTail(current: string, chunk: string, limit: number): string {
  // Buffer.from encodes UTF-8 by default. Under the limit, start is 0, which
  // is never a continuation byte of well-formed text, so the text comes back
  // whole.
  const next = Buffer.from(current + chunk);
  let start = Math.max(0, next.length - limit);
  // 0b10xxxxxx is a continuation byte, never the start of a character.
  while (start < next.length && (next.readUInt8(start) & 0xc0) === 0x80) start += 1;
  return next.subarray(start).toString('utf8');
}

export interface RunChildOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Stop the child's process group with SIGTERM past this, then SIGKILL after
   * {@link RunChildOptions.killGraceMs}. The group runs detached, so a parent
   * killed outright does not take it along.
   */
  timeoutMs?: number;
  /** Stop-to-SIGKILL grace after a timeout; default {@link KILL_GRACE_MS}. */
  killGraceMs?: number;
}

/** Runs `command args`, stdin closed empty, and resolves with its outcome; never rejects. */
export function runChild(command: string, args: readonly string[], options: RunChildOptions = {}): Promise<ChildOutcome> {
  const timeoutMs = options.timeoutMs ?? 0;
  const graceMs = options.killGraceMs ?? KILL_GRACE_MS;
  return new Promise(resolve => {
    let stdout = '';
    let stderrTail = '';
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let deadline: NodeJS.Timeout | undefined;
    /** The deadline's stop, one poll phase after the deadline itself. */
    let deadlineStop: NodeJS.Immediate | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;

    const outcome = (code: number | null, signal: NodeJS.Signals | null): ChildOutcome =>
      classifyChildExit({ code, signal, spawnError, timedOut, timeoutMs, stdout, stderrTail });

    let child: ChildProcessWithoutNullStreams;
    try {
      // Its own process group, so a timeout stops every descendant that
      // inherited the pipes, not only the immediate child.
      child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      // fail-open: a synchronous spawn failure (empty command, NUL in an
      // argument) is this API's spawn-error outcome, not a rejection.
      spawnError = error as NodeJS.ErrnoException;
      resolve(outcome(null, null));
      return;
    }

    /**
     * The group has read as empty (ESRCH) once. An empty group's id is free
     * for the system to reuse, so from then on nothing is sent to `-pid`: it
     * could name a stranger's group.
     */
    let groupGone = false;
    /** Was `error`, from kill(-pid, …), ESRCH? Then the group is gone for good. */
    const gone = (error: unknown): boolean => {
      groupGone = (error as NodeJS.ErrnoException).code === 'ESRCH';
      return groupGone;
    };
    /**
     * Signals the child's group, or only the child once the group is gone or
     * refuses the signal. The child itself stays safe to signal: Node holds
     * its handle until the exit is reaped, and makes `kill` a no-op after.
     */
    const signalGroup = (signal: NodeJS.Signals): void => {
      const { pid } = child;
      if (pid === undefined) return;
      if (groupGone) {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-pid, signal);
      } catch (error) {
        // fail-open: the group is gone (ESRCH, remembered) or refused the
        // signal (EPERM); either way the child itself is still ours to stop.
        gone(error);
        child.kill(signal);
      }
    };
    /** Is any process left in the child's group? False for good once gone. */
    const groupAlive = (): boolean => {
      const { pid } = child;
      if (pid === undefined || groupGone) return false;
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        // fail-open: ESRCH is the answer (the group is empty), not a failure.
        // Any other error (EPERM) proves nothing gone, so the group counts as
        // alive; the escalation bounds the wait.
        return !gone(error);
      }
    };
    /**
     * The outcome, held back after our own stop until the group is empty or
     * SIGKILL has been sent: a caller that exits on the outcome must not leave
     * a SIGTERM-resistant descendant running.
     */
    let result: ChildOutcome | undefined;
    let escalated = false;
    /** Our own stop: signal the group, then SIGKILL it after the grace. */
    const stop = (signal: NodeJS.Signals): void => {
      signalGroup(signal);
      escalation ??= setTimeout(() => {
        escalated = true;
        signalGroup('SIGKILL');
        if (result) resolve(result);
      }, graceMs);
    };

    /**
     * Runs once or twice, with no guard: 'close' follows the drain's call
     * with the same exit, and follows a spawn 'error' (Node emits no 'exit'
     * then) where the spawn error outranks any code. Both calls classify the
     * same outcome, and a second resolve is a no-op.
     */
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(deadline);
      clearTimeout(drain);
      result = outcome(code, signal);
      if (escalation === undefined || escalated || !groupAlive()) {
        clearTimeout(escalation);
        resolve(result);
      }
    };

    // A decoder keeps a character split across chunks whole (UTF-8 is its
    // default), and 'end' flushes an incomplete last one as U+FFFD.
    const stdoutText = new StringDecoder();
    const stderrText = new StringDecoder();
    const appendStderr = (text: string): void => {
      stderrTail = appendTail(stderrTail, text, STDERR_TAIL_BYTES);
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
      // 'error' before 'spawn' means it never started; 'close' may not follow.
      if (child.pid === undefined) {
        spawnError = error;
        finish(null, null);
      }
    });
    // 'close' waits for the pipes too. A descendant that outlives the child
    // can hold them open indefinitely, so after 'exit' the pipes get a short
    // drain and are then cut, and whatever still holds them is killed.
    child.on('exit', (code, signal) => {
      // The child is done: a deadline inside the drain must not relabel it.
      clearTimeout(deadline);
      clearImmediate(deadlineStop);
      drain = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (groupAlive()) signalGroup('SIGKILL');
        finish(code, signal);
      }, EXIT_DRAIN_MS);
    });
    child.on('close', finish);
    // A child that exits before reading its input closes the pipe under us.
    child.stdin.on('error', () => undefined);
    child.stdin.end('');

    if (timeoutMs > 0) {
      deadline = setTimeout(() => {
        // Timers run before the poll phase that reports a child's exit, so a
        // starved loop can reach an overdue deadline with the exit already
        // waiting. The stop waits one poll phase: an exit that is already in
        // clears it, and a child that ended on its own is never a timeout.
        deadlineStop = setImmediate(() => {
          timedOut = true;
          stop(STOP_SIGNAL);
        });
      }, timeoutMs);
    }
  });
}
