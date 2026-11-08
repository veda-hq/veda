/**
 * Hook latency on the Bash path: every PreToolUse hook the checkout's
 * `.claude/settings.json` registers for Bash, fed a fixed set of everyday
 * commands, timed alone and all together.
 *
 * Claude Code runs the hooks that match one call in parallel
 * (https://code.claude.com/docs/en/hooks, "All matching hooks run in
 * parallel"), so the "per call" line, every hook started at once and timed to
 * the last exit, is what a Bash call waits; the per-hook lines say which hook
 * sets it. A budget worth holding each check to is p95 ≤ 150 ms.
 *
 * Hooks only read the command they are handed, so replaying these commands
 * runs none of them. The load average and the interpreters on PATH are printed
 * with the numbers, because both move them.
 *
 * The timed hooks run with `KAVACH_RULE_FIRES_DIR` pointed at
 * {@link LATENCY_FIRES}, so their refusals stay out of the real fire log; a
 * hook registered with its own `--fires-dir` keeps writing there.
 *
 * `cli.js latency [--root <dir>] [--rounds N]` (default: the current folder,
 * 5 rounds over the corpus).
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';

import { FIRES_DIR_ENV } from './fire-log.ts';

/** Commands an agent runs every hour, from cheap reads to pushes. */
export const CORPUS: readonly string[] = [
  'git status --short',
  'ls src',
  'grep -n "export" src/index.ts',
  'node --version',
  'git log --oneline -5',
  'git diff --stat origin/main',
  'git add README.md',
  'git commit -m "docs: note"',
  'git push -u origin HEAD',
  'gh pr view --json number,state',
];

type Settings = {
  hooks?: Record<string, { matcher?: string; hooks: { command: string }[] }[] | undefined>;
};

/** The PreToolUse hook commands whose matcher selects the Bash tool. */
export function bashHooks(settings: Settings): string[] {
  return (settings.hooks?.['PreToolUse'] ?? [])
    .filter((entry) => new RegExp(`^(?:${entry.matcher ?? '.*'})$`).test('Bash'))
    .flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

/** Nearest-rank percentile of ascending `sorted`; 0 for no samples. */
export function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length, Math.ceil((p / 100) * sorted.length)) - 1] ?? 0;
}

export function hookInput(root: string, command: string): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: root,
    tool_input: { command, description: 'latency probe' },
  });
}

/** A hook that has not exited by now is hung, not slow. */
export const HOOK_TIMEOUT_MS = 30_000;

/** How a timed child ended: it exited (any status), could not start, or ran past its time. */
type Outcome = 'exit' | 'spawn-error' | 'timeout';

/**
 * `bash -c command` with `input` on stdin, in its own process group so a
 * hook that hangs is killed with everything it started.
 */
function runBash(command: string, input: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Outcome> {
  return new Promise((done) => {
    const child = spawn('bash', ['-c', command], { env, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    let settled = false;
    const settle = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(outcome);
    };
    const timer = setTimeout(() => {
      try {
        // Never `kill(-0)`: without a pid that would signal this process's own group.
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // fail-open: a group that already ended has nothing left to kill.
      }
      settle('timeout');
    }, timeoutMs);
    child.on('error', () => settle('spawn-error'));
    child.on('exit', () => settle('exit'));
    // A hook may exit without reading its input; the broken pipe is no failure.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/**
 * Milliseconds from starting `command` under bash with `input` on stdin to its
 * exit, whatever its status: a refusal is as much an answer as a pass.
 */
export async function timeHook(
  command: string,
  input: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = HOOK_TIMEOUT_MS,
  clock: () => number = () => performance.now(),
): Promise<number> {
  const start = clock();
  const outcome = await runBash(command, input, env, timeoutMs);
  if (outcome !== 'exit') throw new Error(`${command}: ${outcome}`);
  return clock() - start;
}

export type Series = { readonly name: string; readonly ms: number[] };

/** Where the timed hooks' fires go, under the measured checkout. */
export const LATENCY_FIRES = '.tmp/rule-checks/latency-fires';

/** Run `steps` one after another: timings taken side by side would load each other. */
function inTurn(steps: readonly (() => Promise<void>)[]): Promise<void> {
  return steps.reduce((done, step) => done.then(step), Promise.resolve());
}

/** Every hook alone, then all at once, `rounds` times over `corpus`. */
export async function measure(
  hooks: readonly string[],
  corpus: readonly string[],
  rounds: number,
  root: string,
  clock: () => number = () => performance.now(),
): Promise<Series[]> {
  // The corpus's foreground push may be refused; timing runs must not write
  // those refusals into the fire log the count and reviews read.
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: root,
    [FIRES_DIR_ENV]: join(root, LATENCY_FIRES),
  };
  const alone = hooks.map((name): Series => ({ name, ms: [] }));
  const together: Series = { name: 'per call (all in parallel)', ms: [] };
  const calls = Array.from({ length: rounds }, () => corpus).flat();
  await inTurn(
    calls.flatMap((command) => {
      const input = hookInput(root, command);
      return [
        ...alone.map((series) => async () => {
          series.ms.push(await timeHook(series.name, input, env));
        }),
        async () => {
          const start = clock();
          await Promise.all(hooks.map((hook) => timeHook(hook, input, env)));
          together.ms.push(clock() - start);
        },
      ];
    }),
  );
  return [...alone, together];
}

/** Where an interpreter resolves on PATH; `missing` when it does not. */
export function which(program: string): string {
  const found = spawnSync('bash', ['-c', `command -v ${program}`], {
    encoding: 'utf8',
  });
  return found.stdout.trim() || 'missing';
}

export function render(
  series: readonly Series[],
  load: readonly number[],
  tools: Readonly<Record<string, string>>,
): string {
  const lines = [
    `load average ${load.map((value) => value.toFixed(2)).join(' ')}`,
    ...Object.entries(tools).map(([name, path]) => `${name}: ${path}`),
    '',
    'hook | samples | p50 ms | p95 ms | max ms',
  ];
  for (const { name, ms } of series) {
    const sorted = [...ms].sort((a, b) => a - b);
    lines.push(
      [
        name,
        sorted.length,
        percentile(sorted, 50).toFixed(0),
        percentile(sorted, 95).toFixed(0),
        percentile(sorted, 100).toFixed(0),
      ].join(' | '),
    );
  }
  return lines.join('\n');
}

export function rounds(argv: readonly string[]): number {
  const at = argv.indexOf('--rounds');
  if (at === -1) return 5;
  const value = Number(argv[at + 1]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('--rounds needs a positive whole number');
  }
  return value;
}

/** The checkout whose settings and hooks are timed: `--root`, else `fallback`. */
export function rootOf(argv: readonly string[], fallback: string): string {
  const at = argv.indexOf('--root');
  if (at === -1) return fallback;
  const value = argv[at + 1];
  if (value === undefined) throw new Error('--root needs a folder');
  return resolve(value);
}

export async function main(argv: readonly string[], fallbackRoot: string, out: (text: string) => void): Promise<void> {
  const root = rootOf(argv, fallbackRoot);
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as Settings;
  const series = await measure(bashHooks(settings), CORPUS, rounds(argv), root);
  out(
    render(series, loadavg(), {
      node: which('node'),
      python3: which('python3'),
    }),
  );
}
