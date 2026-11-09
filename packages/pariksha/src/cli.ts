#!/usr/bin/env node
// pariksha: repository checks. One subcommand per check.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adrDirOf, DEFAULTS, findUncited, formatClaims, listAdrs, readOrUndefined, stagedSource, treeSource, type Options } from './authority-citations.ts';
import { findDenied, hash, isText, parseDenyList, type TrackedFile } from './boundary.ts';
import { DEFAULT_CONFIG, findGaps, formatGaps, loadTypescript, parseConfig, type Config, type Ts } from './coverage-by-type.ts';
import { checkBudgets } from './doc-budgets.ts';
import { checkExportDeletions, formatReport } from './export-deletions.ts';
import { BASE_CANDIDATES, gitAt, gitAtTop, resolveBase, topOf } from './git.ts';

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Standard input, read whole; only `--files-from -` reads it. */
  readonly stdin?: () => string;
  /** How a check that needs TypeScript gets it; the product's own install by default. */
  readonly typescript?: () => Ts | string;
}

export const DENY_FILE = '.veda/deny.sha256';

const USAGE = [
  'usage: pariksha authority-citations [--mode staged|tree] [--authority <a,b>] [--issue-prefix <A,B>] [--adr-dir <dir>] [--root <dir>]',
  '       pariksha boundary [--root <dir>] [--deny <file>]',
  '       pariksha coverage-by-type [--config <file>] [--files-from <file>|-] [--root <dir>]',
  '       pariksha doc-budgets --table <file> [--section <name>] [--root <dir>]',
  '       pariksha export-deletions [--base <ref>] [--root <dir>]',
  '       pariksha hash <word>',
  '       pariksha --version',
].join('\n');

export const ownVersion = (): string => {
  const pkg = join(import.meta.dirname, '..', 'package.json');
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
};

/** The files git tracks under root, text ones only. */
export const trackedFiles = (root: string): TrackedFile[] => {
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const files: TrackedFile[] = [];
  for (const path of names) {
    const full = join(root, path);
    if (!existsSync(full)) continue; // deleted in the working tree, not yet committed
    const bytes = readFileSync(full);
    if (isText(bytes)) files.push({ path, text: bytes.toString('utf8') });
  }
  return files;
};

/** `--name value` pairs, each name allowed once and from `allowed`; undefined on anything else. */
export const flags = (rest: readonly string[], allowed: readonly string[]): Map<string, string> | undefined => {
  const out = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if (name === undefined || !allowed.includes(name) || !value || out.has(name)) return undefined;
    out.set(name, value);
  }
  return out;
};

const boundary = (f: Map<string, string>, io: Io): number => {
  const root = resolve(f.get('--root') ?? '.');
  const denyPath = resolve(root, f.get('--deny') ?? DENY_FILE);
  if (!existsSync(denyPath)) {
    io.err(`pariksha boundary: no deny list at ${denyPath}`);
    return 2;
  }
  let deny: Set<string>;
  try {
    deny = parseDenyList(readFileSync(denyPath, 'utf8'));
  } catch (e) {
    io.err(`pariksha boundary: ${denyPath}: ${(e as Error).message}`);
    return 2;
  }
  const files = trackedFiles(root);
  const hits = findDenied(files, deny);
  if (hits.length > 0) {
    for (const h of hits) {
      const at = h.line === 0 ? `${h.file} (its path)` : `${h.file}:${h.line}`;
      io.err(`pariksha boundary: ${at}: "${h.word}" is on the deny list`);
    }
    return 1;
  }
  io.out(`pariksha boundary: ${files.length} files, none names a denied word (${deny.size} on the list)`);
  return 0;
};

const fileSize = (path: string): number | undefined => {
  try {
    const s = statSync(path);
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
};

const docBudgets = (f: Map<string, string>, io: Io): number => {
  const table = f.get('--table');
  if (table === undefined) {
    io.err(USAGE);
    return 2;
  }
  const root = resolve(f.get('--root') ?? '.');
  const tablePath = resolve(root, table);
  if (fileSize(tablePath) === undefined) {
    io.err(`pariksha doc-budgets: no budget table at ${tablePath}`);
    return 2;
  }
  const outcome = checkBudgets(readFileSync(tablePath, 'utf8'), f.get('--section') ?? 'Budgets', relative(root, tablePath), (p) => fileSize(resolve(root, p)));
  outcome.out.forEach(io.out);
  outcome.err.forEach(io.err);
  return outcome.ok ? 0 : 1;
};

const exportDeletions = (f: Map<string, string>, io: Io): number => {
  const dir = resolve(f.get('--root') ?? '.');
  const git = gitAtTop(dir);
  if (git === undefined) {
    io.err(`pariksha export-deletions: ${dir} is not in a git repository`);
    return 2;
  }
  const asked = f.get('--base');
  const base = asked === undefined ? resolveBase(git) : resolveBase(git, [asked]);
  if (base === undefined) {
    // A shallow single-branch checkout lands here; passing it would pass unread work.
    io.err(
      asked === undefined
        ? `pariksha export-deletions: none of ${BASE_CANDIDATES.join(', ')} names a commit; fetch one or pass --base`
        : `pariksha export-deletions: --base ${asked} names no commit`,
    );
    return 2;
  }
  let report: ReturnType<typeof checkExportDeletions>;
  try {
    report = checkExportDeletions(git, base);
  } catch (e) {
    io.err(`pariksha export-deletions: ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
  const result = formatReport(report);
  result.out.forEach(io.out);
  result.err.forEach(io.err);
  return result.ok ? 0 : 1;
};

/** A comma-separated flag value as a list; empty entries dropped. */
const list = (value: string | undefined): string[] => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const authorityCitations = (f: Map<string, string>, io: Io, env: NodeJS.ProcessEnv): number => {
  const mode = f.get('--mode') ?? 'staged';
  if (mode !== 'staged' && mode !== 'tree') {
    io.err(USAGE);
    return 2;
  }
  const dir = resolve(f.get('--root') ?? '.');
  const root = topOf(dir);
  if (root === undefined) {
    io.err(`pariksha authority-citations: ${dir} is not in a git repository`);
    return 2;
  }
  const git = gitAt(root);
  const opts: Options = {
    authorities: list(f.get('--authority')),
    issuePrefixes: list(f.get('--issue-prefix')),
    adrDir: adrDirOf(f.get('--adr-dir') ?? DEFAULTS.adrDir),
  };
  let result: ReturnType<typeof formatClaims>;
  try {
    const source = mode === 'tree' ? treeSource(git, root, readOrUndefined) : stagedSource(git, env, readOrUndefined);
    result = formatClaims(findUncited(source, opts, git, listAdrs(root, opts.adrDir)), opts);
  } catch (e) {
    io.err(`pariksha authority-citations: ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
  result.out.forEach(io.out);
  result.err.forEach(io.err);
  return result.ok ? 0 : 1;
};

/** Non-empty lines, or NUL-separated entries when the text holds a NUL. */
const entries = (text: string): string[] => text.split(text.includes('\0') ? '\0' : /\r?\n/).filter(Boolean);

const coverageByType = (f: Map<string, string>, io: Io): number => {
  const dir = resolve(f.get('--root') ?? '.');
  const root = topOf(dir);
  if (root === undefined) {
    io.err(`pariksha coverage-by-type: ${dir} is not in a git repository`);
    return 2;
  }
  const ts = (io.typescript ?? loadTypescript)();
  if (typeof ts === 'string') {
    io.err(`pariksha coverage-by-type: ${ts}`);
    return 2;
  }
  try {
    const configPath = f.get('--config');
    const config: Config = configPath === undefined ? DEFAULT_CONFIG : parseConfig(readFileSync(resolve(root, configPath), 'utf8'));
    const from = f.get('--files-from');
    const paths =
      from === undefined
        ? entries(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }))
        : entries(from === '-' ? (io.stdin ?? (() => readFileSync(0, 'utf8')))() : readFileSync(resolve(from), 'utf8'));
    const result = formatGaps(config, findGaps(ts, config, root, paths), paths.length);
    result.out.forEach(io.out);
    result.err.forEach(io.err);
    return result.ok ? 0 : 1;
  } catch (e) {
    io.err(`pariksha coverage-by-type: ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
};

const COMMANDS: Record<string, { allowed: readonly string[]; run: (f: Map<string, string>, io: Io, env: NodeJS.ProcessEnv) => number }> = {
  'authority-citations': { allowed: ['--mode', '--authority', '--issue-prefix', '--adr-dir', '--root'], run: authorityCitations },
  boundary: { allowed: ['--root', '--deny'], run: boundary },
  'coverage-by-type': { allowed: ['--config', '--files-from', '--root'], run: coverageByType },
  'doc-budgets': { allowed: ['--table', '--section', '--root'], run: docBudgets },
  'export-deletions': { allowed: ['--base', '--root'], run: exportDeletions },
};

export const run = (args: readonly string[], io: Io, version: string = ownVersion(), env: NodeJS.ProcessEnv = process.env): number => {
  const [command, ...rest] = args;
  if (command === '--version' && rest.length === 0) {
    io.out(version);
    return 0;
  }
  if (command === 'hash' && rest.length === 1 && rest[0]) {
    io.out(hash(rest[0]));
    return 0;
  }
  const spec = command !== undefined && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  const f = spec && flags(rest, spec.allowed);
  if (!spec || !f) {
    io.err(USAGE);
    return 2;
  }
  return spec.run(f, io, env);
};

const isMain = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
};

if (isMain()) {
  process.exitCode = run(process.argv.slice(2), {
    out: (line) => console.info(line),
    err: (line) => console.error(line),
  });
}
