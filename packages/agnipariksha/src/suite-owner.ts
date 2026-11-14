/** Which colocated suite owns a source file. */

export type Exists = (repoRelativePath: string) => boolean;

export const COLOCATED_SUITE_SUFFIXES: readonly string[] = ['.test.ts', '.test.tsx'];

/** The sibling suites that could own a source, most specific first. */
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
