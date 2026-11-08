#!/usr/bin/env node
// pariksha: repository checks. One subcommand per check.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDenied, hash, isText, parseDenyList, type TrackedFile } from './boundary.ts';
import { checkBudgets } from './doc-budgets.ts';
import { checkExportDeletions, formatReport } from './export-deletions.ts';
import { gitAt, resolveBase } from './git.ts';

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const DENY_FILE = '.veda/deny.sha256';

const USAGE = [
  'usage: pariksha boundary [--root <dir>] [--deny <file>]',
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
  const outcome = checkBudgets(readFileSync(tablePath, 'utf8'), f.get('--section') ?? 'Budgets', table, (p) => fileSize(resolve(root, p)));
  outcome.out.forEach(io.out);
  outcome.err.forEach(io.err);
  return outcome.ok ? 0 : 1;
};

const exportDeletions = (f: Map<string, string>, io: Io): number => {
  const git = gitAt(resolve(f.get('--root') ?? '.'));
  const asked = f.get('--base');
  const base = asked === undefined ? resolveBase(git) : resolveBase(git, [asked]);
  if (base === undefined) {
    if (asked !== undefined) {
      io.err(`pariksha export-deletions: --base ${asked} names no commit`);
      return 2;
    }
    io.out('pariksha export-deletions: no base branch to compare with; nothing checked');
    return 0;
  }
  const result = formatReport(checkExportDeletions(git, base));
  result.out.forEach(io.out);
  result.err.forEach(io.err);
  return result.ok ? 0 : 1;
};

const COMMANDS: Record<string, { allowed: readonly string[]; run: (f: Map<string, string>, io: Io) => number }> = {
  boundary: { allowed: ['--root', '--deny'], run: boundary },
  'doc-budgets': { allowed: ['--table', '--section', '--root'], run: docBudgets },
  'export-deletions': { allowed: ['--base', '--root'], run: exportDeletions },
};

export const run = (args: readonly string[], io: Io, version: string = ownVersion()): number => {
  const [command, ...rest] = args;
  if (command === '--version' && rest.length === 0) {
    io.out(version);
    return 0;
  }
  if (command === 'hash' && rest.length === 1 && rest[0]) {
    io.out(hash(rest[0]));
    return 0;
  }
  const spec = command === undefined ? undefined : COMMANDS[command];
  const f = spec && flags(rest, spec.allowed);
  if (!spec || !f) {
    io.err(USAGE);
    return 2;
  }
  return spec.run(f, io);
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
