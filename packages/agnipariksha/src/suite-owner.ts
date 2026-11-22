/** Which colocated suite owns a source file. */

export type Exists = (repoRelativePath: string) => boolean;

export const COLOCATED_SUITE_SUFFIXES: readonly string[] = ['.test.ts', '.test.tsx', '.test.mjs'];

/**
 * The sibling suites that could own a source, most specific first: a `.tsx`
 * source prefers `.test.tsx`, any other source `.test.ts`, and `.test.mjs`
 * comes last, so a source with a TypeScript suite keeps it.
 */
export function suiteCandidatesFor(sourcePath: string): string[] {
  const extension = /\.[^./]+$/.exec(sourcePath)?.[0] ?? '';
  const stem = sourcePath.slice(0, sourcePath.length - extension.length);
  const preferred = extension === '.tsx' ? `${stem}.test.tsx` : `${stem}.test.ts`;
  const others = COLOCATED_SUITE_SUFFIXES.map((suffix) => `${stem}${suffix}`);
  return [preferred, ...others.filter((candidate) => candidate !== preferred)];
}

/** The owning colocated suite, or null. A qualified suite (`foo.integration.test.ts`) never owns. */
export function ownerOf(sourcePath: string, exists: Exists): string | null {
  return suiteCandidatesFor(sourcePath).find((candidate) => exists(candidate)) ?? null;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A suite file's ending, as a regular expression fragment. */
const SUITE_ENDING = String.raw`\.test\.(?:tsx?|mjs)$`;
const SUITE = new RegExp(SUITE_ENDING);

/**
 * The suites beside a source that kill none of its mutants: `<stem>-*.test.ts`
 * or a qualified `<stem>.<qualifier>.test.ts` (`.test.tsx` and `.test.mjs`
 * too), from `files` (repo-relative). A suite with a source of its own
 * (`foo-bar.test.ts` or `foo-bar.test.mjs` beside `foo-bar.ts` or
 * `foo-bar.mjs`) is that file's, so it is left out; so is any suite that
 * could own the source.
 */
export function siblingSuites(sourcePath: string, files: readonly string[]): string[] {
  const extension = /\.[^./]+$/.exec(sourcePath)?.[0] ?? '';
  const stem = sourcePath.slice(0, sourcePath.length - extension.length);
  const sibling = new RegExp(`^${escape(stem)}(?:-[^/]+|\\.[^./]+)${SUITE_ENDING}`);
  const candidates = new Set(suiteCandidatesFor(sourcePath));
  const hasOwnSource = (suite: string): boolean => {
    const source = new RegExp(`^${escape(suite.replace(SUITE, ''))}\\.[^./]+$`);
    return files.some((file) => source.test(file) && !SUITE.test(file));
  };
  return files.filter((file) => sibling.test(file) && !candidates.has(file) && !hasOwnSource(file));
}

/**
 * The gate's line for a file with blocking mutants and sibling suites, judged
 * in a run narrowed to the owning suites: a test added to a sibling looks as
 * if it should kill them, and never ran.
 */
export function notTheOwner(sourcePath: string, owner: string, siblings: readonly string[]): string {
  const name = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
  const names = siblings.map(name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const one = names.length === 1;
  return `${list} ${one ? 'is' : 'are'} not the owner, so ${one ? 'it' : 'they'} did not run; only ${name(owner)} kills mutants of ${name(sourcePath)} here: put the tests that should kill them there`;
}
