/**
 * `sarathi hook <Event>`: the one command a project's Claude Code settings run
 * per event. It reads the event on stdin, runs the project's handlers for it
 * (`.claude/sarathi.json`), and gives Claude Code their combined answer.
 *
 * `sarathi check`: validates the hook list, and with `--settings` that the
 * settings run sarathi for every event it lists, with a matcher and timeout
 * that let every handler fire.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ConfigError, compileMatcher, entriesFor, loadConfig, longestTimeout, settingsMatcher, type Config } from './config.ts';
import { merge } from './merge.ts';
import { runAll, type Outcome } from './run.ts';

export interface Io {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly readStdin: () => Promise<string>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Runs handlers; replaced in tests. */
  readonly run?: (entries: Parameters<typeof runAll>[0], config: Config, input: string, cwd: string) => Promise<Outcome[]>;
}

export const VERSION = '0.5.6';

const USAGE = `usage: sarathi hook <Event> [--config <file>]
       sarathi check [--config <file>] [--settings <file>]
       sarathi --version
`;

/** Events where a broken hook list must refuse the call rather than let it through unguarded. */
const GUARDED_EVENTS = new Set(['PreToolUse']);

interface Options {
  readonly positional: string[];
  readonly config?: string;
  readonly settings?: string;
}

function parseOptions(args: readonly string[]): Options | string {
  const positional: string[] = [];
  let config: string | undefined;
  let settings: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--config' || arg === '--settings') {
      const value = args[index + 1];
      if (value === undefined || value === '') return `${arg} needs a file`;
      if (arg === '--config') config = value;
      else settings = value;
      index += 1;
    } else if (arg.startsWith('--')) {
      return `unknown option ${arg}`;
    } else {
      positional.push(arg);
    }
  }
  return { positional, ...(config === undefined ? {} : { config }), ...(settings === undefined ? {} : { settings }) };
}

function projectRoot(io: Io): string {
  const dir = io.env.CLAUDE_PROJECT_DIR;
  return dir === undefined || dir === '' ? io.cwd : dir;
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
    parsed = undefined;
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
  const entries = entriesFor(config, event, matchTarget(parsed as Record<string, unknown>));
  if (entries.length === 0) return 0;
  const outcomes = await (io.run ?? runAll)(entries, config, input, io.cwd);
  const answer = merge(event, outcomes);
  if (answer.stdout !== '') io.out(answer.stdout);
  if (answer.stderr !== '') io.err(answer.stderr);
  return answer.code;
}

interface SettingsHook {
  readonly matcher: string | undefined;
  readonly command: string;
  readonly timeout: number | undefined;
}

function settingsHooks(text: string, path: string): Map<string, SettingsHook[]> | string {
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
    for (const group of Array.isArray(groups) ? (groups as unknown[]) : []) {
      const { matcher, hooks: inner } = (group ?? {}) as { matcher?: unknown; hooks?: unknown };
      for (const item of Array.isArray(inner) ? (inner as unknown[]) : []) {
        const { command, timeout } = (item ?? {}) as { command?: unknown; timeout?: unknown };
        if (typeof command !== 'string') continue;
        list.push({
          matcher: typeof matcher === 'string' ? matcher : undefined,
          command,
          timeout: typeof timeout === 'number' ? timeout : undefined,
        });
      }
    }
    found.set(event, list);
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
  for (const event of Object.keys(config.hooks)) {
    if ((config.hooks[event] ?? []).length === 0) continue;
    const runner = (settings.get(event) ?? []).find(item => runsSarathiFor(item.command, event));
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
  } catch (error) {
    io.err(`sarathi: ${error instanceof ConfigError ? error.message : String(error)}\n`);
    return 1;
  }
  const counts = Object.entries(config.hooks).map(([event, list]) => `${event} ${list.length}`);
  if (options.settings !== undefined) {
    const path = resolve(io.cwd, options.settings);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
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
