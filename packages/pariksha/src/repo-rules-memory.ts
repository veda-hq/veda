// An in-memory repository for repo-rules: the files a rule reads, with no git
// or disk under them. A product testing its own rule settings, and pariksha's
// own tests, hand a rule this instead of a checkout.
import type { GrepHit, Repo } from './repo-rules.ts';
import { globToRegExp } from './repo-rules-turbo.ts';

export interface MemoryRepoOptions {
  /** The files the selection names; every file by default. */
  readonly selected?: readonly string[];
  /** Old paths the selection deletes or renames away. */
  readonly removed?: readonly string[];
  /** The git a rule may call; one that fails every call by default. */
  readonly run?: (args: readonly string[]) => string | undefined;
}

/** A repository holding `files` (path to text or bytes), each tracked. */
export const memoryRepo = (files: Readonly<Record<string, string | Buffer>>, options: MemoryRepoOptions = {}): Repo => {
  const paths = Object.keys(files).sort();
  const bytes = (path: string): Buffer | undefined => {
    const body = Object.hasOwn(files, path) ? files[path] : undefined;
    return body === undefined ? undefined : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  };
  const grep = (fixed: readonly string[], pathspecs: readonly string[]): GrepHit[] => {
    const globs = pathspecs.map((spec) => spec.replace(/^:\(glob\)/, '')).map((g) => (g === '.' ? /^/ : globToRegExp(g)));
    return paths
      .filter((p) => globs.some((g) => g.test(p)))
      .flatMap((file) =>
        (bytes(file) as Buffer)
          .toString('utf8')
          .split('\n')
          .flatMap((text, i) => (fixed.some((f) => text.includes(f)) ? [{ file, line: i + 1, text }] : [])),
      );
  };
  return {
    root: '/memory',
    files: options.selected ?? paths,
    tracked: () => paths,
    read: (path) => bytes(path)?.toString('utf8'),
    bytes,
    size: (path) => bytes(path)?.length,
    removed: () => options.removed ?? [],
    grep,
    git: { run: options.run ?? (() => undefined) },
  };
};
