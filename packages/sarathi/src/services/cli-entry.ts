import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Is this module the script node was asked to run, rather than an import?
 *
 * A module that is both a library and a command (the Docker sweep's launchd
 * copy) runs its command only when invoked, and stays inert when a test or
 * another module imports it. Getting it wrong in the "inert" direction is
 * silent: the scheduler invokes the file, nothing runs, and it exits 0.
 *
 * The trap: node resolves symlinks when it builds `import.meta.url`, but
 * `process.argv[1]` stays whatever path the caller typed. A file reached
 * through a symlink (a linked checkout, `/tmp` on macOS) makes the two
 * unequal, so a path comparison fails; comparing real paths closes it.
 *
 * @param entryPath  `process.argv[1]` from the calling module.
 * @param moduleUrl  `import.meta.url` from the calling module.
 */
export function isCliEntry(entryPath: string | undefined, moduleUrl: string): boolean {
  if (entryPath === undefined) return false;
  const self = fileURLToPath(moduleUrl);
  // Fast path: the common, non-symlinked invocation.
  if (resolve(entryPath) === self) return true;
  try {
    return realpathSync(entryPath) === realpathSync(self);
  } catch {
    // fail-open: an entry path that does not resolve cannot be this file, since
    // node resolves argv[1] before executing it; so this is an import from a
    // host with an exotic argv[1], and false keeps the command from running.
    return false;
  }
}
