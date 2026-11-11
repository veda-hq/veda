// Which files shell-gates' own rules judge, and the exact bytes they judge.
//
// A shell target is a tracked file that git or a person runs through a
// shell: `*.sh`/`*.bash`, every git hook directly under the hooks directory,
// and any other extensionless file whose shebang names sh, bash, dash or ksh
// (a Gradle wrapper, for one).
//
// Staged mode reads the index, never the working tree: after `git add -p`
// the two differ, and a gate reading the disk would let an unstaged fix pass
// a staged violation. Blobs are read in one `git cat-file --batch` process
// rather than one per file.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** One finding of a shell rule, at a line of a shell target. */
export interface ShellFinding {
  readonly check: string;
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface ShellSource {
  /** Repository-relative path, forward slashes. */
  readonly path: string;
  /** The content being judged: the staged blob, or the working-tree file. */
  readonly text: string;
}

export interface SourcesConfig {
  /** The git hook directory, with its trailing `/`: its direct children without an extension are hooks. */
  readonly hooksDir: string;
  /** Path prefixes never judged: vendored or generated trees. */
  readonly exclude: readonly string[];
  /** Path prefixes of this gate's own inputs: a change under one re-judges every target. */
  readonly gateInputs: readonly string[];
}

export const DEFAULT_SOURCES: SourcesConfig = { hooksDir: '.husky/', exclude: ['node_modules/', '.husky/_/'], gateInputs: [] };

/** Path segments never judged, wherever they sit. */
const EXCLUDED_SEGMENTS = ['/node_modules/'];

/** Shebangs that ShellCheck understands. zsh and fish are out of its scope. */
const SHELL_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-\S+\s+)*)?(?:\/\S*\/)?(?:sh|bash|dash|ksh)(?:\s|$)/;

const excluded = (path: string, config: SourcesConfig): boolean => config.exclude.some((prefix) => path.startsWith(prefix)) || EXCLUDED_SEGMENTS.some((segment) => path.includes(segment));

/** A git hook: a direct child of the hooks directory whose name has no extension. */
export const isHook = (path: string, hooksDir: string): boolean => {
  if (!path.startsWith(hooksDir)) return false;
  const rest = path.slice(hooksDir.length);
  return !rest.includes('/') && !rest.includes('.');
};

/** Whether this path could be a shell target without reading it: `true` by name alone; `'shebang'` when only the first line can tell. */
export const shellByName = (path: string, config: SourcesConfig): boolean | 'shebang' => {
  if (excluded(path, config)) return false;
  if (/\.(?:sh|bash)$/.test(path)) return true;
  if (isHook(path, config.hooksDir)) return true;
  // Git paths always use `/`, so the posix basename is the file's own name.
  return posix.basename(path).includes('.') ? false : 'shebang';
};

export const hasShellShebang = (text: string): boolean => {
  const newline = text.indexOf('\n');
  return SHELL_SHEBANG.test(newline === -1 ? text : text.slice(0, newline));
};

export const isShellTarget = (path: string, text: string, config: SourcesConfig): boolean => {
  const byName = shellByName(path, config);
  return byName === 'shebang' ? hasShellShebang(text) : byName;
};

const git = (root: string, args: readonly string[], input?: string): Buffer => execFileSync('git', args, { cwd: root, ...(input === undefined ? {} : { input }), maxBuffer: 256 * 1024 * 1024 });

const splitZ = (raw: Buffer): string[] => raw.toString('utf8').split('\0').filter(Boolean);

/** Regular-file index entries (mode 100644/100755) among `paths`. */
const regularIndexEntries = (root: string, paths: readonly string[]): string[] => {
  if (paths.length === 0) return [];
  // Literal pathspecs: a selected `task*.sh` names that file, not a glob.
  const listed = splitZ(git(root, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths]));
  const regular: string[] = [];
  for (const entry of listed) {
    // Symlinks (120000) and submodules (160000) have no shell text to judge.
    const match = /^(100644|100755) [0-9a-f]+ 0\t([\s\S]*)$/.exec(entry);
    if (match !== null) regular.push(match[2] as string);
  }
  return regular;
};

/**
 * Reads `:path` blobs from the index in one process. Paths containing a
 * newline cannot be named on `--batch` input and are read one by one.
 */
export const readIndexBlobs = (root: string, paths: readonly string[]): Map<string, string> => {
  const blobs = new Map<string, string>();
  const batchable = paths.filter((path) => !path.includes('\n'));
  for (const path of paths.filter((p) => p.includes('\n'))) blobs.set(path, git(root, ['show', `:${path}`]).toString('utf8'));
  if (batchable.length === 0) return blobs;
  const raw = git(
    root,
    ['cat-file', '--batch'],
    batchable.map((path) => `:${path}\n`).join(''),
  );
  let offset = 0;
  for (const path of batchable) {
    const headerEnd = raw.indexOf(0x0a, offset);
    const header = raw.subarray(offset, headerEnd).toString('utf8');
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1];
    if (size === undefined) throw new Error(`git cat-file could not read staged ${path}: ${header}`);
    const start = headerEnd + 1;
    blobs.set(path, raw.subarray(start, start + Number(size)).toString('utf8'));
    offset = start + Number(size) + 1;
  }
  return blobs;
};

export interface StagedSelection {
  readonly sources: ShellSource[];
  /** A gate input is among the staged changes. */
  readonly gateChanged: boolean;
}

/**
 * Staged additions, modifications and both sides of renames (`--no-renames`
 * turns a rename into a deletion plus an addition, so the new path is
 * judged) and type changes. Deletions leave nothing to judge but still count
 * as a gate-input change.
 */
export const stagedChanges = (root: string): { present: string[]; all: string[] } => {
  const all = splitZ(git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--diff-filter=ACMRTD']));
  const present = splitZ(git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--diff-filter=ACMRT']));
  return { present, all };
};

/** Shell targets among `paths`, read from the index. */
export const indexSources = (root: string, paths: readonly string[], config: SourcesConfig): ShellSource[] => {
  const regular = regularIndexEntries(
    root,
    paths.filter((path) => shellByName(path, config) !== false),
  );
  // readIndexBlobs holds a blob for every path or throws naming the one it
  // could not read, so its entries are the regular paths.
  const sources: ShellSource[] = [];
  for (const [path, text] of readIndexBlobs(root, regular)) if (isShellTarget(path, text, config)) sources.push({ path, text });
  return sources.sort((a, b) => a.path.localeCompare(b.path));
};

const touchesGate = (paths: readonly string[], config: SourcesConfig): boolean => paths.some((path) => config.gateInputs.some((prefix) => path.startsWith(prefix)));

export const selectStaged = (root: string, config: SourcesConfig): StagedSelection => {
  const { present, all } = stagedChanges(root);
  const gateChanged = touchesGate(all, config);
  // The judge changed, so every verdict may have: re-judge the whole index.
  if (gateChanged) return { sources: indexSources(root, splitZ(git(root, ['ls-files', '-z'])), config), gateChanged };
  return { sources: indexSources(root, present, config), gateChanged };
};

/** Tracked regular-file shell candidates among `paths` (no symlinks, no gitlinks). */
const trackedCandidates = (root: string, paths: readonly string[], config: SourcesConfig): string[] =>
  regularIndexEntries(
    root,
    paths.filter((path) => shellByName(path, config) !== false),
  );

/**
 * Every tracked shell target, read from the working tree. A tracked file
 * deleted in the working tree but not yet staged is skipped: there is nothing
 * on disk to judge, and the commit that stages the deletion judges nothing.
 */
export const selectAll = (root: string, config: SourcesConfig): ShellSource[] => workingTreeSources(root, trackedCandidates(root, splitZ(git(root, ['ls-files', '-z'])), config), config, { skipMissing: true });

const isMissing = (error: unknown): boolean => error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Named files from the working tree. Any read failure is an error naming the
 * path, so an unreadable file can never pass as checked; only `skipMissing`
 * callers may skip a file that is not there at all.
 */
export const workingTreeSources = (root: string, paths: readonly string[], config: SourcesConfig, { skipMissing = false }: { skipMissing?: boolean } = {}): ShellSource[] => {
  const sources: ShellSource[] = [];
  for (const path of paths) {
    if (shellByName(path, config) === false) continue;
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch (error) {
      if (skipMissing && isMissing(error)) continue;
      throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isShellTarget(path, text, config)) sources.push({ path, text });
  }
  return sources.sort((a, b) => a.path.localeCompare(b.path));
};

/**
 * Files changed since `base` (CI: the pull request's merge base, or the
 * push's previous tip). A change to the gate itself re-judges everything.
 * Every changed path exists at HEAD, so a read failure is an error.
 */
export const selectChangedSince = (root: string, base: string, config: SourcesConfig): ShellSource[] => {
  const range = `${base}...HEAD`;
  const all = splitZ(git(root, ['diff', '--name-only', '--no-renames', '-z', '--diff-filter=ACMRTD', range]));
  if (touchesGate(all, config)) return selectAll(root, config);
  const present = splitZ(git(root, ['diff', '--name-only', '--no-renames', '-z', '--diff-filter=ACMRT', range]));
  return workingTreeSources(root, trackedCandidates(root, present, config), config);
};
