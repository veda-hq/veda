import { appendFileSync, closeSync, openSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { confirmedVersion, toolCalls } from './protocol.ts';

/**
 * PreToolUse hook for the one-off `sarathi page` sessions: the refusal happens
 * before the Artifact call runs, not after the session ends. A comments session
 * may make no Artifact call; a read session may only read. An update session may publish only to its own page, only once,
 * and only while its latest read of that page confirmed the version the draft
 * was made from. Anything it cannot confirm is refused (exit 2), so a fault blocks a
 * publish, never allows one. Runs under plain `node`: it and the protocol it
 * shares with `page.ts` import only node builtins.
 */

export interface GuardInput {
  tool_name?: unknown;
  tool_input?: { action?: unknown; url?: unknown } | null;
  transcript_path?: unknown;
}

export type GuardEnv =
  | { mode: 'comments' }
  | { mode: 'read' }
  | { mode: 'update'; url: string; version: string; once: string };

/**
 * Claims the session's one publish by creating `path` exclusively: of any
 * number of publish calls, even concurrent ones, only the first succeeds. A
 * claim that cannot be made for any reason is refused.
 */
export function claimOnce(path: string): boolean {
  try {
    closeSync(openSync(path, 'wx'));
    return true;
  } catch {
    // fail-open: false refuses the publish, so a claim that fails blocks it.
    return false;
  }
}

/**
 * A caught value as text, kept to node builtins like the rest of the guard:
 * a hostile value that throws when stringified never escapes the handler.
 */
export function detail(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    // fail-open: an unprintable value is reported as such; the verdict stands.
    return 'an error that cannot be printed';
  }
}

/** A session transcript's events; lines that are not JSON are skipped. */
export function transcriptEvents(transcript: string): unknown[] {
  const events: unknown[] = [];
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // fail-open: a line that is not JSON holds no tool call, so skipping it
      // can only leave a version unconfirmed, which refuses the publish.
      continue;
    }
  }
  return events;
}

/** Why the call is refused, or undefined to let it run. */
export function decide(
  input: GuardInput,
  env: GuardEnv,
  readTranscript: (path: string) => string,
  claim: (path: string) => boolean = claimOnce,
): string | undefined {
  // The hook runs only for Artifact calls; a payload without a tool name is
  // malformed, and a throw here refuses it (exit 2) rather than let it pass.
  if (typeof input.tool_name !== 'string') {
    throw new Error('hook input names no tool');
  }
  if (input.tool_name !== 'Artifact') return undefined;
  const action = input.tool_input?.action;
  if (env.mode === 'comments') {
    return `this session may only use comments; Artifact ${String(action)} refused`;
  }
  if (action === 'read') return undefined;
  if (env.mode === 'read') {
    return `this session may only read; Artifact ${String(action)} refused`;
  }
  // The tool's publish may omit the action; anything else is not an update.
  if (action !== 'publish' && action !== undefined) {
    return `this session may only read and publish; Artifact ${String(action)} refused`;
  }
  const target = input.tool_input?.url;
  if (target !== env.url) {
    return `this session may only change ${env.url}, not ${String(target)}; publish refused`;
  }
  if (typeof input.transcript_path !== 'string') {
    return 'no transcript to confirm the live version; publish refused';
  }
  const calls = toolCalls(
    transcriptEvents(readTranscript(input.transcript_path)),
  );
  const seen = confirmedVersion(calls, env.url);
  if (seen !== env.version) {
    return `${env.url} is at ${seen ?? 'an unconfirmed version'}, not ${env.version}; publish refused`;
  }
  // Last, so only a publish that passed every check uses up the one allowed.
  if (!claim(env.once)) {
    return 'this session has already published once; publish refused';
  }
  return undefined;
}

export function envFrom(vars: NodeJS.ProcessEnv): GuardEnv {
  const mode = vars.PUBLISH_GUARD_MODE;
  if (mode === 'read' || mode === 'comments') return { mode };
  const url = vars.PUBLISH_GUARD_URL;
  const version = vars.PUBLISH_GUARD_VERSION;
  const once = vars.PUBLISH_GUARD_ONCE;
  if (mode === 'update' && url && version && once) {
    return { mode, url, version, once };
  }
  throw new Error(`guard misconfigured (mode ${String(mode)})`);
}

/** Hook entry: exit 2 with the reason blocks the call. */
export function main(
  stdin: string,
  vars: NodeJS.ProcessEnv,
  readTranscript: (path: string) => string,
  err: (text: string) => void,
): number {
  let verdict: string;
  let code: number;
  try {
    const input = JSON.parse(stdin) as GuardInput;
    const reason = decide(input, envFrom(vars), readTranscript);
    verdict = `${String(input.tool_input?.action)}: ${reason ?? 'allowed'}`;
    code = reason === undefined ? 0 : 2;
    if (reason !== undefined) err(`${reason}\n`);
  } catch (error) {
    // fail-open: the fault becomes code 2, which refuses the call.
    verdict = `publish guard: ${detail(error)}`;
    code = 2;
    err(`${verdict}\n`);
  }
  // Proof the hook ran, for a real session: PUBLISH_GUARD_LOG=<file>.
  // A log that cannot be written never changes the verdict: an uncaught
  // throw would exit 1, which the hook runner treats as "allow".
  const log = vars.PUBLISH_GUARD_LOG;
  try {
    if (log) appendFileSync(log, `${verdict}\n`);
  } catch (error) {
    // fail-open: the log is proof only; the verdict already stands.
    err(`publish guard: log not written (${detail(error)})\n`);
  }
  return code;
}

export const readText = (path: string): string => readFileSync(path, 'utf8');

export function writeErr(text: string): void {
  process.stderr.write(text);
}

/**
 * Collects the hook input from a stream and hands it on once, at its end; a
 * stream error hands on empty input, which main refuses with exit 2. Read as
 * a stream, not a `/dev/stdin` path: reading that path can fail with EAGAIN
 * on a non-blocking pipe (a CI run refused a plain read this way). Nothing
 * here may throw, since an uncaught exit 1 lets the call run.
 */
export function readInput(
  stream: NodeJS.ReadableStream,
  done: (text: string) => void,
): void {
  const chunks: string[] = [];
  let settled = false;
  const finish = (text: string) => {
    if (settled) return;
    settled = true;
    done(text);
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => chunks.push(chunk));
  stream.on('end', () => finish(chunks.join('')));
  stream.on('error', () => finish(''));
}

/** The hook run on real input: the verdict becomes the process exit code. */
export function hook(stdin: string): void {
  process.exitCode = main(stdin, process.env, readText, writeErr);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  readInput(process.stdin, hook);
}
