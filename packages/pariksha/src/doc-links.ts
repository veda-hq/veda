// DOC-DRIFT-01, links and anchors: a relative Markdown link, reference
// definition or image names a file that exists, and its `#anchor` a heading
// in that file. The checking is lychee's, offline; this module only chooses
// the tree it reads, parses its report, and applies the exemptions.
//
// lychee reads files from disk. A worktree or index snapshot is read where it
// stands; a ref snapshot (a push's head or merge base) is extracted to a
// temporary directory first. Backticked paths are not links: doc-paths.ts
// reads those.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './doc-references-config.ts';
import { normalizeRepoPath, type ReferenceProblem, type RepoSnapshot } from './doc-references.ts';
import { gitEnv, PINNED } from './git.ts';
import { isRecord } from './registry-ratchet.ts';

export interface LinkFinding {
  readonly file: string;
  readonly line: number;
  /** The target from the doc's directory: `path`, `#anchor` or `path#anchor`. */
  readonly ref: string;
  readonly reason: string;
}

interface LycheeEntry {
  readonly url: string | undefined;
  readonly status: string;
  readonly line: number | undefined;
}

const optionalString = (v: unknown, where: string): string | undefined => {
  if (v === undefined || typeof v === 'string') return v;
  throw new Error(`lychee's report: ${where} is not a string`);
};

/** The part of lychee's `--format json` report read here (`error_map`); the rest is ignored. */
const errorMap = (report: string): Array<[string, LycheeEntry[]]> => {
  const parsed: unknown = JSON.parse(report);
  if (!isRecord(parsed)) throw new Error("lychee's report is not a JSON object");
  const map = parsed['error_map'];
  if (map === undefined) return [];
  if (!isRecord(map)) throw new Error("lychee's report: error_map is not an object");
  return Object.entries(map).map(([source, entries]) => {
    if (!Array.isArray(entries)) throw new Error(`lychee's report: error_map["${source}"] is not a list`);
    return [
      source,
      entries.map((entry: unknown, i) => {
        const where = `error_map["${source}"][${i}]`;
        if (!isRecord(entry)) throw new Error(`lychee's report: ${where} is not an object`);
        const status = entry['status'];
        const span = entry['span'];
        if (status !== undefined && !isRecord(status)) throw new Error(`lychee's report: ${where}.status is not an object`);
        if (span !== undefined && !isRecord(span)) throw new Error(`lychee's report: ${where}.span is not an object`);
        const line = span?.['line'];
        if (line !== undefined && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1)) throw new Error(`lychee's report: ${where}.span.line is not a positive integer`);
        return { url: optionalString(entry['url'], `${where}.url`), status: optionalString(status?.['text'], `${where}.status.text`) ?? '', line };
      }),
    ];
  });
};

const reasonFor = (text: string, path: string, hash: string): string => {
  if (/fragment/i.test(text)) return path === '' ? `Cannot find heading for \`${hash}\`` : `Cannot find heading for \`${hash}\` in \`${path}\``;
  if (/not found/i.test(text)) return `Cannot find file \`${path}\``;
  return `${text || 'lychee could not check it'}: \`${path}${hash}\``;
};

/**
 * Reads lychee's `--format json` report of a run in `dir`. Only `file://`
 * links are this check's; a URL is not (offline, lychee blocks them). Each
 * target is named from its doc's directory, as the link was written.
 */
export const parseLycheeReport = (report: string, dir: string): LinkFinding[] => {
  const entries = errorMap(report);
  const root = realpathSync(dir);
  const findings: LinkFinding[] = [];
  for (const [source, list] of entries) {
    const file = relative(root, resolve(root, source));
    for (const entry of list) {
      if (entry.url === undefined || !entry.url.startsWith('file:')) continue;
      const url = new URL(entry.url);
      // fileURLToPath reads the path alone: the #anchor stays on `url`.
      const target = fileURLToPath(url);
      const path = target === join(root, file) ? '' : relative(join(root, file, '..'), target);
      findings.push({ file, line: entry.line ?? 1, ref: `${path}${url.hash}`, reason: reasonFor(entry.status, path, url.hash) });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
};

/** Runs the link checker over `files` in `dir`; returns its JSON report. */
export type LinkRunner = (dir: string, files: readonly string[]) => string;

/**
 * How lychee's `--files-from` must name `file` to read that file and no
 * other. It takes a line as a URL (`https:x.md`) unless it starts `./`, and
 * as a glob when it holds `*`, `?` or `[`, so those are bracketed. A line
 * cannot hold a newline: that path is refused, never left unchecked.
 */
export const lycheeInputLine = (file: string): string => {
  if (/[\n\r]/.test(file)) throw new Error(`lychee reads its file list a line at a time, so it cannot check ${JSON.stringify(file)}: rename it`);
  return `./${file.replace(/[*?[]/g, (char) => `[${char}]`)}`;
};

/**
 * The real runner: lychee, offline, anchors included. `--config /dev/null`
 * keeps a lychee.toml in the tree out of it; `--root-dir` resolves a
 * `/docs/x.md` link from the repository root. A missing lychee fails, never
 * passes. `command` is the executable, `lychee` on PATH by default.
 */
export const lycheeRunner =
  (command = 'lychee'): LinkRunner =>
  (dir, files) => {
    const result = spawnSync(command, ['--offline', '--include-fragments', '--format', 'json', '--no-progress', '--config', '/dev/null', '--root-dir', realpathSync(dir), '--files-from', '-'], {
      cwd: dir,
      encoding: 'utf8',
      input: `${files.map(lycheeInputLine).join('\n')}\n`,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error !== undefined) {
      if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${command} is not installed; the link check needs lychee (https://lychee.cli.rs)`);
      throw result.error;
    }
    // 0: every link resolves; 2: some do not, listed in the report.
    if (result.status !== 0 && result.status !== 2) throw new Error(`lychee exited ${String(result.status)}: ${result.stderr}`);
    return result.stdout;
  };

/** A directory holding the snapshot's tree, and how to let it go. */
export const treeFor = (snapshot: RepoSnapshot): { dir: string; release: () => void } => {
  if (snapshot.source.kind !== 'ref') return { dir: snapshot.root, release: () => undefined };
  const dir = mkdtempSync(join(tmpdir(), 'doc-links-'));
  try {
    const tar = join(dir, '.tree.tar');
    execFileSync('git', [...PINNED, 'archive', '-o', tar, snapshot.source.ref], { cwd: snapshot.root, env: gitEnv(process.env), stdio: 'pipe' });
    execFileSync('tar', ['-xf', tar, '-C', dir], { stdio: 'pipe' });
    rmSync(tar);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { dir, release: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * The broken links in `files`' Markdown (those the config's `links.include`
 * takes), as DOC-DRIFT-01 problems. A finding stays out when its line carries
 * the exemption marker, its target is a placeholder, or the repository's
 * ignore rules cover the target.
 */
export const findLinkProblems = (config: Config, snapshot: RepoSnapshot, files: readonly string[], run: LinkRunner): ReferenceProblem[] => {
  const include = config.links?.include;
  if (include === undefined) return [];
  const docs = files.filter((file) => include.test(file));
  if (docs.length === 0) return [];
  const tree = treeFor(snapshot);
  let findings: LinkFinding[];
  try {
    // Parsed while the tree stands: its targets are named from tree.dir.
    findings = parseLycheeReport(run(tree.dir, docs), tree.dir);
  } finally {
    tree.release();
  }
  const asked = new Set(docs);
  const kept = findings.filter((finding) => {
    if (!asked.has(finding.file)) return false;
    const text = snapshot.read(finding.file)?.split('\n')[finding.line - 1];
    if (text !== undefined && config.exemptMarker.test(text)) return false;
    return !config.placeholder.test(finding.ref);
  });
  const targetOf = (finding: LinkFinding): string | null => {
    const path = finding.ref.replace(/#.*$/, '');
    return path === '' ? null : normalizeRepoPath(posix.join(posix.dirname(finding.file), path));
  };
  const targets = kept.flatMap((finding) => {
    const target = targetOf(finding);
    return target === null ? [] : [target, `${target}/`];
  });
  const ignored = snapshot.ignored([...new Set(targets)]);
  return kept
    .filter((finding) => {
      const target = targetOf(finding);
      return target === null || (!ignored.has(target) && !ignored.has(`${target}/`));
    })
    .map((finding) => ({ check: 'DOC-DRIFT-01' as const, file: finding.file, line: finding.line, ref: finding.ref, reason: finding.reason }));
};
