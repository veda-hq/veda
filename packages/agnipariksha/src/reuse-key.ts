/** The reuse file's key: which files can change a lane's results. */
import { createHash } from 'node:crypto';

/** The repo facts the key reads beyond the workspace itself. */
export interface KeyPolicy {
  /** Always in the key (lockfile, Stryker's package.json). */
  always: readonly string[];
  /** Directory of the gate's Stryker plugins; its `.mjs` files are in the key. */
  pluginDir: string;
  /** Packages whose non-test files are always in the key (test helpers). */
  helperPackages: readonly string[];
  /** The package other workspaces' tests run unmutated. */
  sharedWorkspace: string;
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const HELPER_PATH = /(^|\/)(test|tests|__mocks__|__tests__|test-utils|testing|fixtures?)\/|setup/;
const WORKSPACE_CONFIG = /^(vite|vitest)[\w.-]*\.[cm]?[jt]s$|^tsconfig[\w.-]*\.json$/;

/** The repo-relative files the key reads, chosen from the files git sees. */
export function keyInputPaths(
  workspace: string,
  configFile: string,
  tracked: readonly string[],
  policy: KeyPolicy,
): string[] {
  const chosen = new Set<string>([...policy.always, `${workspace}/${configFile}`]);
  for (const path of tracked) {
    if (path.startsWith(policy.pluginDir) && path.endsWith('.mjs')) {
      chosen.add(path);
      continue;
    }
    if (TEST_FILE.test(path)) continue;
    if (policy.helperPackages.some((dir) => path.startsWith(dir))) {
      chosen.add(path);
      continue;
    }
    if (workspace !== policy.sharedWorkspace && path.startsWith(`${policy.sharedWorkspace}/`)) {
      chosen.add(path);
      continue;
    }
    if (!path.startsWith(`${workspace}/`)) continue;
    const inner = path.slice(workspace.length + 1);
    if (WORKSPACE_CONFIG.test(inner) || HELPER_PATH.test(inner)) chosen.add(path);
  }
  return [...chosen].sort();
}

/** The key, or null when an input cannot be read. */
export function incrementalKey(
  paths: readonly string[],
  readFile: (repoRelative: string) => string | undefined,
): string | null {
  const hash = createHash('sha256');
  for (const path of paths) {
    const text = readFile(path);
    if (text === undefined) return null;
    hash.update(`${path}\0${createHash('sha256').update(text).digest('hex')}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}
