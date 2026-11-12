// The documents absolute-paths and non-synced-resources read, and the config
// both take. A product's hook hands them its own list (`--files-from`); with
// none, they read every file git tracks.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { entries } from './coverage-by-type.ts';
import { gitAt, must } from './git.ts';

export interface DocConfig {
  /** Which listed paths are documents: a regex over the path as listed. */
  readonly include: RegExp;
  /** The lines printed after a refusal: how to fix it, where the rules are. */
  readonly guidance: readonly string[];
}

/** Markdown and MDX. */
export const DEFAULT_INCLUDE = '\\.(md|mdx)$';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `{ "include"?: "<regex>", "guidance"?: ["<line>", …] }`; absent keys take
 * the defaults. Throws on anything else, so a mistyped key never passes as
 * the default.
 */
export const parseDocConfig = (text: string | undefined, defaultGuidance: readonly string[]): DocConfig => {
  if (text === undefined) return { include: new RegExp(DEFAULT_INCLUDE), guidance: defaultGuidance };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  const unknown = Object.keys(raw).find((k) => k !== 'include' && k !== 'guidance');
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"`);
  // Absent takes the default; a present `null` is refused like any other wrong value.
  const include = 'include' in raw ? raw['include'] : DEFAULT_INCLUDE;
  if (typeof include !== 'string' || include === '') throw new Error('"include" must be a non-empty regex string');
  let pattern: RegExp;
  try {
    pattern = new RegExp(include);
  } catch (e) {
    throw new Error(`"include" is not a regex: ${(e as Error).message}`);
  }
  const guidance = 'guidance' in raw ? raw['guidance'] : defaultGuidance;
  if (!Array.isArray(guidance) || guidance.some((line) => typeof line !== 'string')) throw new Error('"guidance" must be a list of lines');
  return { include: pattern, guidance: guidance as string[] };
};

/** Whether `path` (under `base` when relative) names a regular file, a symlink to one included. */
export const isFileAt = (base: string, path: string): boolean => {
  try {
    return statSync(resolve(base, path)).isFile();
  } catch {
    return false;
  }
};

/**
 * The documents to check, as listed: each entry of `listed` that names a
 * regular file under `base` and matches `include`, in order; a named path
 * that is not a file is dropped. With no list, every file git tracks under
 * `base`, as git names it.
 */
export const selectDocs = (base: string, listed: string | undefined, include: RegExp): string[] => {
  const paths = listed === undefined ? must(gitAt(base), ['ls-files', '-z']).split('\0').filter(Boolean) : entries(listed);
  return paths.filter((path) => isFileAt(base, path) && include.test(path));
};

/** A document's lines as a shell `read` loop sees them: split on newlines, a last line without one included. */
export const linesOf = (text: string): string[] => {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** A listed document's text. */
export const readDoc = (base: string, path: string): string => readFileSync(resolve(base, path), 'utf8');
