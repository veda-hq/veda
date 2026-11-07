#!/usr/bin/env node
// pariksha: repository checks. v0.1 has one, `boundary`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDenied, hash, isText, parseDenyList, type TrackedFile } from './boundary.ts';

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const DENY_FILE = '.veda/deny.sha256';

const USAGE = [
  'usage: pariksha boundary [--root <dir>] [--deny <file>]',
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

const flags = (rest: readonly string[]): Map<string, string> | undefined => {
  const out = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if ((name !== '--root' && name !== '--deny') || !value || out.has(name)) return undefined;
    out.set(name, value);
  }
  return out;
};

const boundary = (rest: readonly string[], io: Io): number => {
  const f = flags(rest);
  if (!f) {
    io.err(USAGE);
    return 2;
  }
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
  if (command === 'boundary') return boundary(rest, io);
  io.err(USAGE);
  return 2;
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
