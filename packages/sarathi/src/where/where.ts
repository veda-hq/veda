/**
 * `sarathi where`: what a module sits next to, and what depends on it, read
 * off the project's module graph so a session need not open files to find
 * out. It runs the project's own dependency-cruiser and prints its compact
 * `text` answer, one `a → b` edge per line, deduplicated and sorted.
 *
 * - A session reads the answer, so the reporter is always `text`: on
 *   2026-09-20 `--output-type flat` spent about 1,500 tokens describing six
 *   files, and `text` said the same in seven lines.
 * - dependency-cruiser comes from the project, `node_modules/.bin/depcruise`
 *   at the repository root, so sarathi adds no dependency and the answer is
 *   the project's own version's. A project without it gets a refusal that
 *   names the binary.
 * - The config is the project's, named by `--config` or by `where.config` in
 *   `.claude/sarathi.json`. There is no fallback to the project's default
 *   config: that one is often an architecture gate that resolves packages to
 *   their built output, and an answer through it would look right while
 *   missing every edge into a package's source.
 * - A cruise that exits non-zero but printed edges has answered: depcruise
 *   exits non-zero for rule violations. One killed by a signal, or one that
 *   printed nothing, has not, and `where` fails rather than say "no modules
 *   matched". Callers read a non-zero exit as "the graph failed".
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Module paths kept out of the answer entirely: dependencies, built and
 * generated output, and the throwaway fixture an ESLint wiring check writes
 * for under a second (a cruise that lists it and then opens it dies with
 * ENOENT). With them excluded an answer arrives as source paths, not through
 * a package's `dist`.
 */
export const EXCLUDED = '(^|/)(node_modules|dist|build|coverage|\\.turbo|\\.stryker-tmp|\\.tmp|eslint-rule-wiring-fixture\\.test\\.ts)(/|$)';

/** Cruised when no `--scope` is given. */
export const DEFAULT_SCOPE: readonly string[] = ['apps', 'packages'];
/** Edges printed before the answer truncates and says how many it withheld. */
export const DEFAULT_MAX = 60;
/** `--focus` neighbours: 1 is direct, 2 is neighbours of neighbours. */
export const DEFAULT_DEPTH = 1;
/** What `--affected` compares against when no revision is given. */
export const DEFAULT_REVISION = 'main';

/** The project's dependency-cruiser, from the repository root. */
export const DEPCRUISE = join('node_modules', '.bin', 'depcruise');

export type Mode = 'focus' | 'reaches' | 'affected';

export interface WhereOptions {
  readonly mode: Mode;
  /** A module regex for `focus` and `reaches`; a git revision for `affected`. */
  readonly pattern: string;
  readonly depth: number;
  readonly scope: readonly string[];
  readonly max: number;
  /** `--config` as typed, resolved from the working folder; absent, sarathi.json decides. */
  readonly config?: string;
}

export type Parsed = { readonly kind: 'run'; readonly options: WhereOptions } | { readonly kind: 'help' } | { readonly kind: 'error'; readonly message: string };

export const HELP = `sarathi where — what a module sits next to, and what depends on it

  sarathi where <regex> [--depth N] [--scope DIR]... [--max N] [--config FILE]
  sarathi where <regex> --reaches [--scope DIR]... [--max N] [--config FILE]
  sarathi where --affected [revision] [--scope DIR]... [--max N] [--config FILE]

  <regex>            the module, e.g. discount-engine/index
  --reaches, -r      everything that transitively depends on it (blast radius)
  --affected [rev]   modules changed since rev (default main) plus everything
                     that reaches them: this branch's blast radius
  --depth N          neighbours to walk in the default mode (default 1);
                     refused with --reaches and --affected, which walk everything
  --scope DIR        limit the cruise, from the repository root; repeatable
                     (default apps packages)
  --max N            edges to print before truncating (default 60)
  --config FILE      the dependency-cruiser config (default: where.config in
                     .claude/sarathi.json)

Prints one "a → b" edge per line, deduplicated and sorted. Built output is
excluded, so answers arrive as source paths. Runs the project's own
node_modules/.bin/depcruise from the repository root.
`;

function positiveInteger(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

const VALUED = new Set(['--depth', '--max', '--scope', '--config']);

export function parseArgs(argv: readonly string[]): Parsed {
  let mode: Mode = 'focus';
  let pattern: string | undefined;
  let revision: string | undefined;
  // Undefined until given, so a --depth outside --focus is refused below rather than dropped.
  let depth: number | undefined;
  let max = DEFAULT_MAX;
  let config: string | undefined;
  const scope: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--reaches' || arg === '-r') {
      mode = 'reaches';
      continue;
    }
    if (arg === '--affected') {
      mode = 'affected';
      const next = argv[index + 1];
      // A revision is optional, so only a non-flag word directly after it counts.
      if (next !== undefined && !next.startsWith('-')) {
        revision = next;
        index += 1;
      }
      continue;
    }
    if (VALUED.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value === '') return { kind: 'error', message: `${arg} needs a value` };
      index += 1;
      if (arg === '--scope') {
        scope.push(value);
        continue;
      }
      if (arg === '--config') {
        config = value;
        continue;
      }
      const count = positiveInteger(value);
      if (count === undefined) return { kind: 'error', message: `${arg} needs a positive whole number, not ${JSON.stringify(value)}` };
      if (arg === '--depth') depth = count;
      else max = count;
      continue;
    }
    if (arg.startsWith('-')) return { kind: 'error', message: `unknown option ${arg}` };
    if (pattern !== undefined) {
      return { kind: 'error', message: `only one pattern is accepted, got ${JSON.stringify(pattern)} and ${JSON.stringify(arg)}` };
    }
    pattern = arg;
  }

  // depcruise's --focus-depth has no counterpart for --reaches or --affected,
  // which walk every module that reaches the match. An answer that looks
  // bounded but is not is worse than a refusal.
  if (depth !== undefined && mode !== 'focus') {
    return { kind: 'error', message: `--depth applies to the default --focus mode only; --${mode} always follows every module that reaches the match` };
  }
  const base = { scope: scope.length > 0 ? scope : DEFAULT_SCOPE, max, ...(config === undefined ? {} : { config }) };
  if (mode === 'affected') {
    if (pattern !== undefined) return { kind: 'error', message: `--affected takes its revision directly, as --affected ${pattern}` };
    return { kind: 'run', options: { ...base, mode, pattern: revision ?? DEFAULT_REVISION, depth: DEFAULT_DEPTH } };
  }
  if (pattern === undefined) return { kind: 'error', message: 'a module regex is required' };
  return { kind: 'run', options: { ...base, mode, pattern, depth: depth ?? DEFAULT_DEPTH } };
}

/** depcruise's arguments, `config` being the config file's absolute path. */
export function buildDepcruiseArgs(options: WhereOptions, config: string): string[] {
  const args = ['--config', config, '--cache', '--output-type', 'text', '--exclude', EXCLUDED];
  if (options.mode === 'focus') {
    args.push('--focus', options.pattern);
    // Only when it differs, so the common call stays the one `depcruise --help` documents.
    if (options.depth !== DEFAULT_DEPTH) args.push('--focus-depth', String(options.depth));
  } else {
    args.push(`--${options.mode}`, options.pattern);
  }
  return [...args, ...options.scope];
}

export interface Edges {
  readonly lines: readonly string[];
  readonly total: number;
}

export function formatEdges(stdout: string, max: number): Edges {
  const seen = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line !== '') seen.add(line);
  }
  const all = [...seen].sort();
  return { lines: all.slice(0, max), total: all.length };
}

export function render(edges: Edges): string {
  if (edges.total === 0) return 'no modules matched\n';
  const withheld = edges.total - edges.lines.length;
  const note = withheld > 0 ? `\n… ${withheld} more of ${edges.total} (raise with --max)` : '';
  return `${edges.lines.join('\n')}${note}\n`;
}

/** A field a failed `execFileSync` carries, when it is a string. */
function field(error: unknown, key: 'stdout' | 'signal'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Runs `bin` with `args` from `cwd` and returns its stdout; throws as `execFileSync` does. */
export type Spawn = (bin: string, args: readonly string[], cwd: string) => string;

/** The real child process. */
export const spawnDepcruise: Spawn = (bin, args, cwd) =>
  execFileSync(bin, [...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export class WhereError extends Error {
  override readonly name = 'WhereError';
}

/** The cruise's answer: stdout, even from a non-zero exit, unless the child was killed or printed nothing. */
export function runDepcruise(bin: string, args: readonly string[], cwd: string, spawn: Spawn): string {
  try {
    return spawn(bin, args, cwd);
  } catch (error) {
    const signal = field(error, 'signal');
    if (signal !== undefined) throw new WhereError(`dependency-cruiser was killed by ${signal}`, { cause: error });
    const stdout = field(error, 'stdout');
    if (stdout !== undefined && stdout !== '') return stdout;
    throw new WhereError(`dependency-cruiser failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `where` value of the hook list at `path`: `{ "config": "<file>" }`, the
 * file from `root` unless absolute. Returns the config's absolute path, or
 * undefined when the project names none.
 */
export function parseWhereSettings(value: unknown, path: string, root: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new WhereError(`${path}: "where" must be an object`);
  const extra = Object.keys(value).filter(key => key !== 'config');
  if (extra.length > 0) throw new WhereError(`${path} where: unknown key ${extra.map(key => `"${key}"`).join(', ')}`);
  const { config } = value;
  if (config === undefined) return undefined;
  if (typeof config !== 'string' || config === '') throw new WhereError(`${path} where: "config" must be a path from the project root`);
  return isAbsolute(config) ? config : resolve(root, config);
}

/** `where.config` in `<root>/.claude/sarathi.json`; undefined when the file or the key is absent. */
export function readWhereConfig(root: string): string | undefined {
  const path = join(root, '.claude', 'sarathi.json');
  let text: string;
  try {
    text = String(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new WhereError(`cannot read ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WhereError(`${path} is not JSON`);
  }
  return parseWhereSettings(isRecord(raw) ? raw.where : undefined, path, root);
}

export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

function toplevel(io: Io): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd, encoding: 'utf8', stdio: 'pipe', env: { ...io.env } }).trim();
  } catch {
    throw new WhereError(`${io.cwd} is not in a git checkout`);
  }
}

/** The answer to `options` in the checkout at `io.cwd`. */
function answer(options: WhereOptions, io: Io, spawn: Spawn): string {
  const root = toplevel(io);
  const bin = join(root, DEPCRUISE);
  if (!existsSync(bin)) throw new WhereError(`${bin} is not installed: add dependency-cruiser to the project`);
  const config = options.config === undefined ? readWhereConfig(root) : resolve(io.cwd, options.config);
  if (config === undefined) throw new WhereError(`no dependency-cruiser config: pass --config, or set "where": { "config": "<file>" } in ${join(root, '.claude', 'sarathi.json')}`);
  if (!existsSync(config)) throw new WhereError(`the config ${config} does not exist`);
  return runDepcruise(bin, buildDepcruiseArgs(options, config), root, spawn);
}

/** `sarathi where`: 0 with an answer, 2 for a usage error, 1 when there is no answer. */
export function whereMain(argv: readonly string[], io: Io, spawn: Spawn = spawnDepcruise): number {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    io.out(HELP);
    return 0;
  }
  if (parsed.kind === 'error') {
    io.err(`sarathi where: ${parsed.message}\n\n${HELP}`);
    return 2;
  }
  let stdout: string;
  try {
    stdout = answer(parsed.options, io, spawn);
  } catch (error) {
    // fail-open: no answer; its reason is printed and the exit code is 1, which callers read as "the graph failed".
    io.err(`sarathi where: ${(error as Error).message}\n`);
    return 1;
  }
  io.out(render(formatEdges(stdout, parsed.options.max)));
  return 0;
}
