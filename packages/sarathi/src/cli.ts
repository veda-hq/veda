/**
 * `sarathi hook <Event>`: the one command a project's Claude Code settings run
 * per event. It reads the event on stdin, runs the project's handlers for it
 * (`.claude/sarathi.json`), and gives Claude Code their combined answer.
 *
 * `sarathi check`: validates the hook list, and with `--settings` that the
 * settings run sarathi for every event it lists, with a matcher and timeout
 * that let every handler fire.
 *
 * `sarathi page`: publishes, reads and answers claude.ai pages through a
 * one-off `claude -p` session (`page/page.ts`).
 *
 * `sarathi worktree`: the worktree lifecycle (`worktree/lifecycle.ts`), and
 * `sarathi worktree hook`, its archive guard (`worktree/hook.ts`), and
 * `sarathi worktree pick`, the interactive picker (`worktree/pick.ts`), and
 * `sarathi worktree cleanup`, which frees the disk worktrees and their
 * tooling leave behind (`worktree/cleanup.ts`).
 *
 * `sarathi services`: the worktree's local services (`services/main.ts`), and
 * `sarathi services reap`, the sweep of deleted worktrees' services, and
 * `sarathi services prune`, the hourly Docker sweep (`services/prune.ts`).
 *
 * `sarathi where`: what a module sits next to and what depends on it, from
 * the project's own dependency-cruiser (`where/where.ts`).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ConfigError, compileMatcher, entriesFor, forbiddenSet, loadConfig, longestTimeout, settingsMatcher, type Config } from './config.ts';
import { merge } from './merge.ts';
import { autofixCommand } from './hooks/autofix.ts';
import { main as page } from './page/page.ts';
import { runAll, type Outcome } from './run.ts';
import { servicesMain } from './services/main.ts';
import { cleanupMain } from './worktree/cleanup.ts';
import { hookMain } from './worktree/hook.ts';
import { lifecycleMain } from './worktree/lifecycle.ts';
import { pickMain } from './worktree/pick.ts';
import { parseSettings } from './worktree/settings.ts';
import { VERSION } from './version.ts';
import { parseWhereSettings, whereMain } from './where/where.ts';

// Kept for code that imports dist/cli.js for it, as before version.ts.
export { VERSION };

export interface Io {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly readStdin: () => Promise<string>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /**
   * Shows a prompt on stderr and resolves the line typed, for `worktree pick`.
   * Without one, the first line of stdin answers.
   */
  readonly ask?: (prompt: string) => Promise<string>;
  /** Runs handlers; replaced in tests. */
  readonly run?: (entries: Parameters<typeof runAll>[0], config: Config, input: string, cwd: string) => Promise<Outcome[]>;
}

const USAGE = `usage: sarathi hook <Event> [--config <file>]
       sarathi check [--config <file>] [--settings <file>]
       sarathi page <page.html> [--url <artifact>] [--title T] [--description D] [--icon I]
       sarathi page --read <artifact> [--out <page.html>]
       sarathi page --comments <artifact>
       sarathi page --reply <artifact> --thread <id> --text-file <file> [--resolve]
       sarathi autofix add <pr-url> [--session <id>] [--source <name>]
       sarathi autofix list [--session <id>]
       sarathi worktree status|archive-check|begin --branch <name>|retire --pr <n> [--branch <successor>]
       sarathi worktree hook
       sarathi worktree pick [--shell]
       sarathi worktree cleanup [--dry-run]
       sarathi services up|down|status|web|server|<action> [args]
       sarathi services run -- <command>
       sarathi services reap
       sarathi services prune install|run|run-now|status|uninstall [--dry-run] [--docker <path>] [--settings <file>]
       sarathi where <regex> [--reaches | --depth N] | --affected [rev] [--scope DIR]... [--max N] [--config <file>]
       sarathi --version
`;

/** Events where a broken hook list must refuse the call rather than let it through unguarded. */
const GUARDED_EVENTS = new Set(['PreToolUse']);

interface Options {
  readonly positional: string[];
  readonly config: string | undefined;
  readonly settings: string | undefined;
}

function parseOptions(args: readonly string[]): Options | string {
  const positional: string[] = [];
  let config: string | undefined;
  let settings: string | undefined;
  // One iterator: an option's value is the next word, taken from it.
  const words = args[Symbol.iterator]();
  for (const arg of words) {
    if (arg === '--config' || arg === '--settings') {
      const { value } = words.next();
      if (value === undefined || value === '') return `${arg} needs a file`;
      if (arg === '--config') config = value;
      else settings = value;
    } else if (arg.startsWith('--')) {
      return `unknown option ${arg}`;
    } else {
      positional.push(arg);
    }
  }
  return { positional, config, settings };
}

/** The project checkout: $CLAUDE_PROJECT_DIR, or the working folder when it is unset or empty. */
function projectRoot(io: Io): string {
  return io.env.CLAUDE_PROJECT_DIR || io.cwd;
}

function configPath(io: Io, options: Options): string {
  const root = projectRoot(io);
  return options.config === undefined ? join(root, '.claude', 'sarathi.json') : resolve(io.cwd, options.config);
}

/** What an event's matchers are tested against: the tool, or the event's own matcher field. */
export function matchTarget(event: Record<string, unknown>): string {
  for (const key of ['tool_name', 'source', 'trigger', 'notification_type', 'agent_type']) {
    const value = event[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

/** Events where a forbidden variable is told to the session and the user. */
const WARNED_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

/**
 * What sarathi answers, beside the handlers, when the session sets a variable
 * the project forbids: PreToolUse refuses, SessionStart and UserPromptSubmit
 * warn both Claude and the user, other events say nothing.
 */
export function forbidOutcome(event: string, set: ReadonlyArray<readonly [string, string]>): Outcome | undefined {
  if (set.length === 0) return undefined;
  const lines = set.map(([name, why]) => `${name} is set, and this project forbids it: ${why}`);
  const fix = `Unset ${set.map(([name]) => name).join(' and ')} and start a new session; until then sarathi refuses every tool call.`;
  const base = { label: 'sarathi forbidEnv', timedOut: false, failClosed: true } as const;
  if (GUARDED_EVENTS.has(event)) return { ...base, code: 2, stdout: '', stderr: `BLOCKED: sarathi: ${lines.join('; ')}. ${fix}\n` };
  if (!WARNED_EVENTS.has(event)) return undefined;
  const message = `sarathi: ${lines.join('; ')}. ${fix}`;
  return {
    ...base,
    code: 0,
    stdout: JSON.stringify({ systemMessage: message, hookSpecificOutput: { hookEventName: event, additionalContext: message } }),
    stderr: '',
  };
}

async function hook(io: Io, options: Options): Promise<number> {
  const event = options.positional[1];
  if (event === undefined || options.positional.length > 2) {
    io.err(USAGE);
    return 1;
  }
  const refuse = GUARDED_EVENTS.has(event);
  const input = await io.readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    // fail-open: input that is not JSON leaves parsed undefined, which the check below refuses.
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    io.err(`${refuse ? 'BLOCKED: ' : ''}sarathi: the ${event} event on stdin is not a JSON object, so no handler ran.\n`);
    return refuse ? 2 : 1;
  }
  let config: Config;
  try {
    config = loadConfig(configPath(io, options), projectRoot(io));
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    io.err(`${refuse ? 'BLOCKED: ' : ''}sarathi cannot use its hook list: ${message}. No ${event} handler ran.\n`);
    return refuse ? 2 : 1;
  }
  const forbidden = forbidOutcome(event, forbiddenSet(config, io.env));
  if (forbidden?.code === 2) {
    io.err(forbidden.stderr);
    return 2;
  }
  const entries = entriesFor(config, event, matchTarget(parsed as Record<string, unknown>));
  // No handler and no warning merges to exit 0 with nothing to say.
  const outcomes = entries.length === 0 ? [] : await (io.run ?? runAll)(entries, config, input, io.cwd);
  const merged = merge(event, forbidden === undefined ? outcomes : [forbidden, ...outcomes]);
  // A handler that blocks drops every JSON answer, the warning among them; keep it in the reason.
  const warning = forbidden === undefined ? undefined : (JSON.parse(forbidden.stdout) as { systemMessage: string }).systemMessage;
  const answer = merged.code === 2 && warning !== undefined ? { ...merged, stderr: `${warning}\n${merged.stderr}` } : merged;
  io.out(answer.stdout);
  io.err(answer.stderr);
  return answer.code;
}

export interface SettingsHook {
  readonly matcher: string | undefined;
  readonly command: string;
  readonly timeout: number | undefined;
}

/** The command hooks a Claude Code settings file lists, per event, or why it cannot be read. */
export function settingsHooks(text: string, path: string): Map<string, SettingsHook[]> | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return `${path} is not JSON`;
  }
  const found = new Map<string, SettingsHook[]>();
  const hooks = (raw as { hooks?: unknown } | null)?.hooks;
  if (typeof hooks !== 'object' || hooks === null) return found;
  for (const [event, groups] of Object.entries(hooks)) {
    const list: SettingsHook[] = [];
    found.set(event, list);
    // A value that is not a list runs nothing.
    if (!Array.isArray(groups)) continue;
    for (const group of groups as unknown[]) {
      const { matcher, hooks: inner } = (group ?? {}) as { matcher?: unknown; hooks?: unknown };
      if (!Array.isArray(inner)) continue;
      for (const item of inner as unknown[]) {
        const { command, timeout } = (item ?? {}) as { command?: unknown; timeout?: unknown };
        if (typeof command !== 'string') continue;
        list.push({
          matcher: typeof matcher === 'string' ? matcher : undefined,
          command,
          timeout: typeof timeout === 'number' ? timeout : undefined,
        });
      }
    }
  }
  return found;
}

/**
 * Does a settings command run sarathi for `event`? It names sarathi (the
 * program, or a launcher script named after it) and passes the event as a
 * word of its own: `sarathi hook Stop`, `"$DIR"/hooks/sarathi.sh Stop`.
 */
export function runsSarathiFor(command: string, event: string): boolean {
  return /\bsarathi\b/.test(command) && new RegExp(`(?:^|[\\s"'])${event}(?:$|[\\s"'])`).test(command);
}

/** The settings' problems in running `config`: a missing event, a matcher that hides a handler, a timeout shorter than one. */
export function settingsProblems(config: Config, settings: Map<string, SettingsHook[]>): string[] {
  const problems: string[] = [];
  for (const [event, list] of Object.entries(config.hooks)) {
    if (list.length === 0) continue;
    const runner = settings.get(event)?.find(item => runsSarathiFor(item.command, event));
    if (runner === undefined) {
      problems.push(`${event}: no settings hook runs \`sarathi hook ${event}\``);
      continue;
    }
    const needed = settingsMatcher(config, event);
    const covers = compileMatcher(runner.matcher);
    if (needed === undefined) {
      if (runner.matcher !== undefined && runner.matcher !== '' && runner.matcher !== '*') {
        problems.push(`${event}: a handler matches every tool, so the settings entry needs no matcher (has "${runner.matcher}")`);
      }
    } else {
      const hidden = needed.split('|').filter(name => name !== '' && !covers(name));
      if (hidden.length > 0) problems.push(`${event}: the settings matcher leaves out ${hidden.join(', ')}`);
    }
    const longest = longestTimeout(config, event);
    if (runner.timeout === undefined || runner.timeout < longest) {
      problems.push(`${event}: the settings timeout must be at least ${longest} s, the longest handler's (has ${runner.timeout ?? 'none'})`);
    }
  }
  return problems;
}

function check(io: Io, options: Options): number {
  if (options.positional.length > 1) {
    io.err(USAGE);
    return 1;
  }
  let config: Config;
  try {
    config = loadConfig(configPath(io, options), projectRoot(io));
    // The worktree and where settings share the file; a malformed one would only show at the next call that reads it.
    const raw = JSON.parse(readFileSync(config.path, 'utf8')) as { worktree?: unknown; where?: unknown };
    parseSettings(raw.worktree, config.path, config.root);
    parseWhereSettings(raw.where, config.path, config.root);
  } catch (error) {
    // loadConfig throws a ConfigError, parseSettings a SettingsError and parseWhereSettings a WhereError, each with a message that names the file.
    io.err(`sarathi: ${(error as Error).message}\n`);
    return 1;
  }
  const counts = Object.entries(config.hooks).map(([event, list]) => `${event} ${list.length}`);
  if (options.settings !== undefined) {
    const path = resolve(io.cwd, options.settings);
    let text: string;
    try {
      text = String(readFileSync(path));
    } catch {
      io.err(`sarathi: cannot read ${path}\n`);
      return 1;
    }
    const settings = settingsHooks(text, path);
    if (typeof settings === 'string') {
      io.err(`sarathi: ${settings}\n`);
      return 1;
    }
    const problems = settingsProblems(config, settings);
    if (problems.length > 0) {
      io.err(problems.map(problem => `sarathi: ${problem}\n`).join(''));
      return 1;
    }
  }
  io.out(`sarathi: ${config.path} is valid (${counts.join(', ')})\n`);
  return 0;
}

export async function main(io: Io): Promise<number> {
  if (io.argv.length === 1 && io.argv[0] === '--version') {
    io.out(`${VERSION}\n`);
    return 0;
  }
  // Before parseOptions: these commands have flags of their own.
  const [first, second, ...rest] = io.argv;
  const after = io.argv.slice(1);
  if (first === 'page') return page(after, io);
  if (first === 'autofix') return autofixCommand(after, { ...io, now: () => new Date() });
  if (first === 'worktree') {
    if (second === 'hook' && rest.length === 0) return hookMain(await io.readStdin(), io.out);
    if (second === 'pick') {
      const ask =
        io.ask ??
        (async (prompt: string): Promise<string> => {
          io.err(prompt);
          return String((await io.readStdin()).split('\n')[0]);
        });
      return pickMain(rest, { ...io, ask });
    }
    if (second === 'cleanup') return cleanupMain(rest, io);
    return lifecycleMain(after, io);
  }
  if (first === 'services') return servicesMain(after, io);
  if (first === 'where') return whereMain(after, io);
  const options = parseOptions(io.argv);
  if (typeof options === 'string') {
    io.err(`sarathi: ${options}\n${USAGE}`);
    return 1;
  }
  const command = options.positional[0];
  if (command === 'hook') return hook(io, options);
  if (command === 'check') return check(io, options);
  io.err(USAGE);
  return 1;
}
