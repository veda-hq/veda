import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Is this module the script node was asked to run, rather than an import?
 *
 * Every CLI needs this: run when invoked, stay inert when a test imports it.
 * Getting it wrong in the "inert" direction is silent gate death: the hook
 * invokes the file, nothing runs, and the call passes with a successful exit
 * status and no output at all. A guard that compares `process.argv[1]` to
 * `import.meta.url` by path equality does exactly that through a symlink.
 *
 * The trap: node resolves symlinks when it builds `import.meta.url`, but
 * `process.argv[1]` stays whatever path the caller typed. Any repo reached
 * through a symlink (a linked worktree, a symlinked checkout, `/tmp` on
 * macOS, a package manager's `node_modules/.bin` link) makes the two unequal
 * for the same file. Comparing real paths is what closes it.
 *
 * @param entryPath  `process.argv[1]` from the calling module.
 * @param moduleUrl  `import.meta.url` from the calling module.
 */
export function isCliEntry(entryPath: string | undefined, moduleUrl: string): boolean {
  if (entryPath === undefined) return false;

  const self = fileURLToPath(moduleUrl);

  // Fast path: the common, non-symlinked invocation, and the only one that
  // still works if the module were deleted from disk mid-run.
  if (resolve(entryPath) === self) return true;

  try {
    return realpathSync(entryPath) === realpathSync(self);
  } catch {
    // An entry path that does not resolve cannot be this file: node resolves
    // argv[1] to a real path before executing it. So this is an import whose
    // host has an exotic argv[1] (a worker thread, a bundler's virtual
    // module), and returning true would run the CLI body during import.
    // Returning false cannot hide a CLI run either: a real invocation always
    // has a resolvable entry.
    return false;
  }
}
