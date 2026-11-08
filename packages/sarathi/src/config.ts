/**
 * The project's hook list: which commands run on which Claude Code event.
 *
 * A project keeps one JSON file (by default `.claude/sarathi.json`) and one
 * short entry per event in its Claude Code settings that runs
 * `sarathi hook <Event>`. The file has the shape of the settings' own `hooks`
 * block, flattened: each event lists entries, each entry one handler.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** A kavach guard sarathi runs from its own dependency. */
export type Guard = 'worktree' | 'command';

export interface Entry {
  /** Claude Code's matcher: a tool name, `A|B`, a regular expression, or absent for all. */
  readonly matcher?: string;
  /** A shell command, run as Claude Code would run it. */
  readonly command?: string;
  /** A kavach guard, instead of a command. */
  readonly guard?: Guard;
  /** Seconds before the handler is stopped; 60 when absent. */
  readonly timeout?: number;
  /** Any end but exit 0 refuses (guards always do). */
  readonly failClosed?: boolean;
}

export interface Config {
  /** The file read. */
  readonly path: string;
  /** The folder relative paths in the file resolve from: the project root. */
  readonly root: string;
  readonly kavach: {
    /** kavach's settings file (`KAVACH_CONFIG`), absolute, or absent. */
    readonly config?: string;
    /** A program that runs a Python script (`<python> <script>`): absolute, or a name on PATH. */
    readonly python: string;
  };
  readonly hooks: Readonly<Record<string, readonly Entry[]>>;
}

export const DEFAULT_TIMEOUT_SECONDS = 60;

const ENTRY_KEYS = new Set(['matcher', 'command', 'guard', 'timeout', 'failClosed']);
const TOP_KEYS = new Set(['$schema', 'kavach', 'hooks']);
const KAVACH_KEYS = new Set(['config', 'python']);
const PLAIN = /^[\w|-]+$/;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, known: ReadonlySet<string>, where: string): void {
  const extra = Object.keys(value).filter(key => !known.has(key));
  if (extra.length > 0) throw new ConfigError(`${where}: unknown key ${extra.map(key => `"${key}"`).join(', ')}`);
}

/** Claude Code's matcher rules: absent, empty or `*` match all; plain names and `A|B` match exactly; anything else is a regular expression. */
export function compileMatcher(matcher: string | undefined, where = 'matcher'): (target: string) => boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return () => true;
  if (PLAIN.test(matcher)) {
    const names = new Set(matcher.split('|'));
    return target => names.has(target);
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(matcher);
  } catch (error) {
    throw new ConfigError(`${where}: "matcher" is not a regular expression (${(error as Error).message})`);
  }
  return target => pattern.test(target);
}

function parseEntry(raw: unknown, where: string): Entry {
  if (!isRecord(raw)) throw new ConfigError(`${where}: an entry must be an object`);
  rejectUnknownKeys(raw, ENTRY_KEYS, where);
  const { matcher, command, guard, timeout, failClosed } = raw;
  if (matcher !== undefined && typeof matcher !== 'string') throw new ConfigError(`${where}: "matcher" must be a string`);
  if (command !== undefined && (typeof command !== 'string' || command.trim() === '')) {
    throw new ConfigError(`${where}: "command" must be a non-empty string`);
  }
  if (guard !== undefined && guard !== 'worktree' && guard !== 'command') {
    throw new ConfigError(`${where}: "guard" must be "worktree" or "command"`);
  }
  if ((command === undefined) === (guard === undefined)) {
    throw new ConfigError(`${where}: give exactly one of "command" and "guard"`);
  }
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) {
    throw new ConfigError(`${where}: "timeout" must be a positive number of seconds`);
  }
  if (failClosed !== undefined && typeof failClosed !== 'boolean') {
    throw new ConfigError(`${where}: "failClosed" must be true or false`);
  }
  if (typeof matcher === 'string') compileMatcher(matcher, where);
  return {
    ...(typeof matcher === 'string' ? { matcher } : {}),
    ...(typeof command === 'string' ? { command } : {}),
    ...(guard === 'worktree' || guard === 'command' ? { guard } : {}),
    ...(typeof timeout === 'number' ? { timeout } : {}),
    ...(typeof failClosed === 'boolean' ? { failClosed } : {}),
  };
}

/** Parses the file's text; `path` names it in errors, `root` is where its relative paths start. */
export function parseConfig(text: string, path: string, root: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path} is not JSON (${(error as Error).message})`);
  }
  if (!isRecord(raw)) throw new ConfigError(`${path}: the file must hold an object`);
  rejectUnknownKeys(raw, TOP_KEYS, path);
  const kavachRaw = raw.kavach ?? {};
  if (!isRecord(kavachRaw)) throw new ConfigError(`${path}: "kavach" must be an object`);
  rejectUnknownKeys(kavachRaw, KAVACH_KEYS, `${path} kavach`);
  const { config, python } = kavachRaw;
  if (config !== undefined && typeof config !== 'string') throw new ConfigError(`${path}: "kavach.config" must be a path`);
  if (python !== undefined && typeof python !== 'string') throw new ConfigError(`${path}: "kavach.python" must be a program`);
  const hooksRaw = raw.hooks;
  if (!isRecord(hooksRaw)) throw new ConfigError(`${path}: "hooks" must be an object of events`);
  const hooks: Record<string, Entry[]> = {};
  for (const [event, list] of Object.entries(hooksRaw)) {
    if (!Array.isArray(list)) throw new ConfigError(`${path} ${event}: must be a list of entries`);
    hooks[event] = list.map((entry: unknown, index) => parseEntry(entry, `${path} ${event}[${index}]`));
  }
  const fromRoot = (value: string): string => (isAbsolute(value) ? value : resolve(root, value));
  return {
    path,
    root,
    kavach: {
      ...(typeof config === 'string' ? { config: fromRoot(config) } : {}),
      python: typeof python !== 'string' ? 'python3' : python.includes('/') ? fromRoot(python) : python,
    },
    hooks,
  };
}

/** Reads the file at `path`; relative paths in it resolve from `root`. */
export function loadConfig(path: string, root: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  return parseConfig(text, path, root);
}

/** The entries for `event` whose matcher takes `target` (the tool name, or the event's own matcher field). */
export function entriesFor(config: Config, event: string, target: string): Entry[] {
  return (config.hooks[event] ?? []).filter(entry => compileMatcher(entry.matcher)(target));
}

/**
 * The matcher the one settings entry for `event` needs so that every entry here
 * can fire: the union of their names, or `undefined` (all) when one entry
 * matches all or uses a regular expression.
 */
export function settingsMatcher(config: Config, event: string): string | undefined {
  const names = new Set<string>();
  for (const entry of config.hooks[event] ?? []) {
    const matcher = entry.matcher;
    if (matcher === undefined || matcher === '' || matcher === '*' || !PLAIN.test(matcher)) return undefined;
    for (const name of matcher.split('|')) names.add(name);
  }
  return [...names].sort().join('|');
}

/** The longest timeout among an event's entries, in seconds. */
export function longestTimeout(config: Config, event: string): number {
  return Math.max(0, ...(config.hooks[event] ?? []).map(entry => entry.timeout ?? DEFAULT_TIMEOUT_SECONDS));
}
