// non-synced-resources: every relative Markdown link in a document names a
// file or folder the repository holds, under the same case.
//
// A link to a file that was never committed, or to one outside the checkout,
// works for its writer and for nobody else. Each `[text](dest)` and
// `![alt](dest)` on a line (in code blocks too) is read; `http(s)://`,
// `mailto:` and `#anchor` links are not. Its `#fragment` and `?query` go, then
// its destination is the text inside `<…>`, or the text before a space (a
// title). A destination starting with `/` is read from the repository's top.
// It is refused when its folder does not exist, when it lands outside the
// repository, when nothing is there, or when the name on disk differs in case
// (macOS opens `./README.MD` as `./readme.md`; Linux and CI do not). An image
// over 1 MiB is warned about, never refused.
//
// Ported from a shell check unchanged: paths are joined and split as the shell
// joined them (dirname, basename, `cd && pwd`), so a link's text decides what
// counts as inside the repository exactly as before.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { linesOf, type DocConfig } from './doc-files.ts';

/** A Markdown link or image, as the shell check's `grep -oE` matched it. */
const LINK = /!?\[[^\]]*\]\([^)]+\)/g;
const SKIPPED = /^(https?:\/\/|mailto:|#)/;
const IMAGE = /\.(png|jpg|jpeg|gif|webp)$/;
const LARGE_IMAGE_BYTES = 1_048_576;

export const DEFAULT_GUIDANCE: readonly string[] = ['Please ensure all referenced files exist in the repository.'];

/** The destination of each link on each line of `text`, as written, http(s), mailto and anchor links dropped. */
export const linkTargets = (text: string): string[] =>
  linesOf(text)
    .flatMap((line) => [...line.matchAll(LINK)].map((m) => m[0].slice(m[0].indexOf('](') + 2, -1)))
    .filter((dest) => !SKIPPED.test(dest));

/** A destination without its fragment, query or title, and out of its angle brackets; '' when nothing is left. */
export const linkPath = (dest: string): string => {
  let link = dest;
  const hash = link.indexOf('#');
  if (hash !== -1) link = link.slice(0, hash);
  const query = link.indexOf('?');
  if (query !== -1) link = link.slice(0, query);
  if (link.startsWith('<') && link.indexOf('>', 1) !== -1) return link.slice(1, link.indexOf('>'));
  const space = link.indexOf(' ');
  return space === -1 ? link : link.slice(0, space);
};

const stripTrailingSlashes = (path: string): string => {
  const stripped = path.replace(/\/+$/, '');
  return stripped === '' && path !== '' ? '/' : stripped;
};

/** POSIX `dirname`. */
export const dirnameOf = (path: string): string => {
  const trimmed = stripTrailingSlashes(path);
  const slash = trimmed.lastIndexOf('/');
  if (slash === -1) return '.';
  const head = trimmed.slice(0, slash).replace(/\/+$/, '');
  return head === '' ? '/' : head;
};

/** POSIX `basename`. */
export const basenameOf = (path: string): string => {
  const trimmed = stripTrailingSlashes(path);
  return trimmed === '/' ? '/' : trimmed.slice(trimmed.lastIndexOf('/') + 1);
};

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const exists = (path: string): boolean => {
  try {
    const s = statSync(path);
    return s.isFile() || s.isDirectory();
  } catch {
    return false;
  }
};

/** Whether folder `dir` holds an entry named exactly `name`; `.` and `..` always. */
export const nameOnDisk = (dir: string, name: string): boolean => {
  if (name === '.' || name === '..') return true;
  try {
    return readdirSync(dir).includes(name);
  } catch {
    return false;
  }
};

/** A regular file's size in bytes, the link itself for a symlink (as `stat` without `-L` reads it). */
const sizeOf = (path: string): number | undefined => {
  try {
    const s = lstatSync(path);
    return statSync(path).isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
};

export interface Outcome {
  readonly ok: boolean;
  readonly out: string[];
}

/**
 * The lines for one document's links, and whether any was refused. `file` is
 * as listed; a relative one is read from `top`, the repository's top folder.
 */
export const checkDoc = (top: string, file: string, text: string): { readonly refused: boolean; readonly out: string[] } => {
  const out: string[] = [];
  let refused = false;
  const fileDir = dirnameOf(file);
  const under = (path: string): boolean => path.startsWith(`${top}/`);
  const relativeOf = (path: string): string => (under(path) ? path.slice(top.length + 1) : path);
  for (const dest of linkTargets(text)) {
    const link = linkPath(dest);
    if (link === '') continue;
    let target = link.startsWith('/') ? `${top}${link}` : fileDir.startsWith('/') ? `${fileDir}/${link}` : `${top}/${fileDir}/${link}`;
    const parent = dirnameOf(target);
    if (!isDir(parent) && under(target)) {
      out.push(`❌ Error: Reference to file in non-existent directory in ${file}:`, `   Link: ${link}`, `   Expected path: ${relativeOf(target)}`, '   Parent directory does not exist', '');
      refused = true;
      continue;
    }
    // `cd "$parent" && pwd`: the folder with `.` and `..` resolved by name.
    target = `${isDir(parent) ? posix.resolve(parent) : parent}/${basenameOf(target)}`;
    if (!under(target)) {
      out.push(`❌ Error: Reference to file outside repository in ${file}:`, `   Link: ${link}`, `   Resolved path: ${target}`, '   All references must be within the repository', '');
      refused = true;
      continue;
    }
    const relative = relativeOf(target);
    if (!exists(target)) {
      out.push(`❌ Error: Reference to non-existent file in ${file}:`, `   Link: ${link}`, `   Expected path: ${relative}`, '');
      refused = true;
    } else if (!nameOnDisk(dirnameOf(target), basenameOf(target))) {
      out.push(`❌ Error: Reference whose case differs from the file on disk in ${file}:`, `   Link: ${link}`, `   Expected path: ${relative}`, '');
      refused = true;
    }
    const size = IMAGE.test(target) ? sizeOf(target) : undefined;
    if (size !== undefined && size > LARGE_IMAGE_BYTES) {
      out.push(
        `⚠️  Warning: Large image referenced in ${file}:`,
        `   Image: ${relative}`,
        `   Size: ~${Math.floor(size / 1024 / 1024)} MB (${Math.floor(size / 1024)} KB)`,
        '   Consider compressing images to keep repository size small.',
        '',
      );
    }
  }
  return { refused, out };
};

/**
 * The report for `docs` (path and text, in order), printed as the shell check
 * printed it. `top` is asked for only when there is a document to read.
 */
export const checkNonSyncedResources = (docs: ReadonlyArray<{ readonly file: string; readonly text: () => string }>, top: () => string, config: DocConfig): Outcome => {
  const out = ['→ Checking for non-synced resource references...'];
  if (docs.length === 0) return { ok: true, out: [...out, '✅ No documentation files to check.'] };
  out.push(`   Checking ${docs.length} documentation file(s)...`);
  const root = top();
  let refused = false;
  for (const doc of docs) {
    const result = checkDoc(root, doc.file, doc.text());
    out.push(...result.out);
    refused ||= result.refused;
  }
  if (refused) return { ok: false, out: [...out, '', ...config.guidance] };
  return { ok: true, out: [...out, '✅ All resource references are valid'] };
};
