// The TypeScript compiler API, for the checks that read code or tsconfig files.
// An optional peer dependency: only those checks load it.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as TS from 'typescript';

/** The TypeScript compiler API, from the product's own install. */
export type Ts = typeof TS;

/** Where typescript is looked for: the product's own install at `root` first, then beside pariksha (npx installs no optional peer). */
export const typescriptLoaders = (root: string): Array<(id: string) => unknown> => [createRequire(join(root, 'package.json')), createRequire(import.meta.url)];

/** TypeScript from the first loader that has it; a message naming why when it cannot be used. */
export const loadTypescript = (loaders: ReadonlyArray<(id: string) => unknown> = typescriptLoaders(process.cwd())): Ts | string => {
  let mod: unknown;
  for (const load of loaders) {
    try {
      mod = load('typescript');
      break;
    } catch {
      // not installed there; try the next
    }
  }
  if (mod === undefined) return 'needs the typescript package (>=5.4 <6) in the repository or beside pariksha';
  const ts = mod as Partial<Ts>;
  if (typeof ts.createSourceFile !== 'function') {
    return `needs the TypeScript compiler API, which typescript ${String(ts.version)} does not export; install typescript >=5.4 <6`;
  }
  return ts as Ts;
};
