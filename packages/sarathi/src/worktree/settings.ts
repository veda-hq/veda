/**
 * The project's worktree settings: the `worktree` object of
 * `.claude/sarathi.json`, beside the hook list. Every field has a default, so
 * a project without one gets sarathi's own names.
 *
 * - `name`: names the receipt (`<name>-lifecycle.json` in the git dir) and the
 *   recovery refs (`refs/<name>/lifecycle/…`), so a project's other tools can
 *   read them. Default `sarathi`.
 * - `owner`: who may discard scratch files, as the cloud archive step names
 *   them. Default `the owner`.
 * - `cloudCheck`: a script, from the project root, run as
 *   `bash <script> <root>`; exit 0 confirms a cloud session. Without one a
 *   cloud session is `CLAUDE_CODE_REMOTE=true` alone.
 * - `services`: the project's services file (`services/file.ts`), a path
 *   from the project root or a package path (`@scope/package/file.json`).
 *   Kept as written: a package path resolves only with the environment.
 *   Without one, `sarathi services` has nothing to run.
 * - `cleanup`: what `sarathi worktree cleanup` may touch beyond its own
 *   steps (`cleanup.ts`). Every field is off or empty by default:
 *   - `primaryBuilt`: rebuildable build output in the primary checkout,
 *     paths from its root, that the caches step deletes;
 *   - `nestedCopies`: a regular expression for a worktree's nested copies,
 *     paths from that worktree, which go with it; without one none match;
 *   - `machine`: the machine-wide steps, each off unless set:
 *     `dockerDesktopUpdate`, `androidNdk` (the build.gradle that pins the
 *     NDK, from each checkout's root), `gradleCaches`, `simulators`, `brew`.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** The machine-wide steps of `sarathi worktree cleanup`; each is off unless set. */
export interface MachineSettings {
  /** Delete Docker Desktop's staged update when Docker Desktop is not running. */
  readonly dockerDesktopUpdate: boolean;
  /** The build.gradle that pins the Android NDK, from a checkout's root; set, the NDK step runs. */
  readonly androidNdk?: string;
  /** Delete Gradle's downloaded caches when no Gradle daemon or build runs. */
  readonly gradleCaches: boolean;
  /** `xcrun simctl delete unavailable`. */
  readonly simulators: boolean;
  /** `brew cleanup`. */
  readonly brew: boolean;
}

export interface CleanupSettings {
  /** Rebuildable build output of the primary checkout, paths from its root. */
  readonly primaryBuilt: readonly string[];
  /** A regular expression's source: a worktree's nested copies, paths from it. */
  readonly nestedCopies?: string;
  readonly machine: MachineSettings;
}

export interface WorktreeSettings {
  readonly name: string;
  readonly owner: string;
  readonly cloudCheck?: string;
  readonly services?: string;
  /** Absent when the project sets none: `cleanupOf` gives the defaults. */
  readonly cleanup?: CleanupSettings;
}

export const DEFAULT_CLEANUP: CleanupSettings = {
  primaryBuilt: [],
  machine: { dockerDesktopUpdate: false, gradleCaches: false, simulators: false, brew: false },
};

/** The cleanup settings, defaults when the project sets none. */
export function cleanupOf(settings: WorktreeSettings): CleanupSettings {
  return settings.cleanup ?? DEFAULT_CLEANUP;
}

export class SettingsError extends Error {
  override readonly name = 'SettingsError';
  readonly code = 'SETTINGS';
}

export const DEFAULT_SETTINGS: WorktreeSettings = { name: 'sarathi', owner: 'the owner' };

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const KEYS = new Set(['name', 'owner', 'cloudCheck', 'services', 'cleanup']);
const CLEANUP_KEYS = new Set(['primaryBuilt', 'nestedCopies', 'machine']);
const MACHINE_SWITCHES = ['dockerDesktopUpdate', 'gradleCaches', 'simulators', 'brew'] as const;
const MACHINE_KEYS = new Set<string>([...MACHINE_SWITCHES, 'androidNdk']);
/** A scoped package and a file inside it. */
const PACKAGE_PATH = /^@[^/\s]+\/[^/\s]+\/\S+$/;
/** A package path with no `..` segment, so it cannot leave the package. */
const packagePath = (value: string): boolean => PACKAGE_PATH.test(value) && !value.split('/').includes('..');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A path that stays inside the folder it is read from, since cleanup deletes
 * what it names: relative, every segment a name (no empty, `.` or `..`), and
 * not in or at `.git`.
 */
const insidePath = (value: unknown): value is string =>
  typeof value === 'string' && !isAbsolute(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..') && value.split('/')[0] !== '.git';

/** Refuses keys outside `keys`, naming them. */
function refuseExtra(value: Record<string, unknown>, keys: Set<string>, where: string): void {
  const extra = Object.keys(value).filter(key => !keys.has(key));
  if (extra.length > 0) throw new SettingsError(`${where}: unknown key ${extra.map(key => `"${key}"`).join(', ')}`);
}

function parseMachine(value: unknown, where: string): MachineSettings {
  if (value === undefined) return DEFAULT_CLEANUP.machine;
  if (!isRecord(value)) throw new SettingsError(`${where}: "machine" must be an object`);
  refuseExtra(value, MACHINE_KEYS, `${where} machine`);
  for (const key of MACHINE_SWITCHES) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new SettingsError(`${where} machine: "${key}" must be true or false`);
  }
  const { androidNdk } = value;
  if (androidNdk !== undefined && !insidePath(androidNdk)) throw new SettingsError(`${where} machine: "androidNdk" must be a path inside the checkout`);
  return {
    dockerDesktopUpdate: value.dockerDesktopUpdate === true,
    ...(typeof androidNdk === 'string' ? { androidNdk } : {}),
    gradleCaches: value.gradleCaches === true,
    simulators: value.simulators === true,
    brew: value.brew === true,
  };
}

/** Whether `source` compiles as a regular expression. */
function compiles(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    // fail-open: an invalid pattern is reported by the caller as a settings error.
    return false;
  }
}

function parseCleanup(value: unknown, path: string): CleanupSettings | undefined {
  if (value === undefined) return undefined;
  const where = `${path} worktree cleanup`;
  if (!isRecord(value)) throw new SettingsError(`${path} worktree: "cleanup" must be an object`);
  refuseExtra(value, CLEANUP_KEYS, where);
  const { primaryBuilt, nestedCopies } = value;
  if (primaryBuilt !== undefined && (!Array.isArray(primaryBuilt) || !primaryBuilt.every(insidePath))) {
    throw new SettingsError(`${where}: "primaryBuilt" must be a list of paths inside the primary checkout`);
  }
  if (nestedCopies !== undefined && (typeof nestedCopies !== 'string' || nestedCopies === '' || !compiles(nestedCopies))) {
    throw new SettingsError(`${where}: "nestedCopies" must be a regular expression`);
  }
  return {
    primaryBuilt: Array.isArray(primaryBuilt) ? primaryBuilt.filter(insidePath) : [],
    ...(typeof nestedCopies === 'string' ? { nestedCopies } : {}),
    machine: parseMachine(value.machine, where),
  };
}

/** Parses the `worktree` value of the hook list at `path`; relative paths start at `root`. */
export function parseSettings(value: unknown, path: string, root: string): WorktreeSettings {
  if (value === undefined) return DEFAULT_SETTINGS;
  if (!isRecord(value)) throw new SettingsError(`${path}: "worktree" must be an object`);
  refuseExtra(value, KEYS, `${path} worktree`);
  const { name, owner, cloudCheck, services } = value;
  if (name !== undefined && (typeof name !== 'string' || !NAME.test(name))) {
    throw new SettingsError(`${path} worktree: "name" must be lowercase letters, digits and dashes, starting with a letter`);
  }
  if (owner !== undefined && (typeof owner !== 'string' || owner.trim() === '')) throw new SettingsError(`${path} worktree: "owner" must be a name`);
  if (cloudCheck !== undefined && (typeof cloudCheck !== 'string' || cloudCheck === '')) throw new SettingsError(`${path} worktree: "cloudCheck" must be a path`);
  if (services !== undefined && (typeof services !== 'string' || services === '' || (services.startsWith('@') && !packagePath(services)))) {
    throw new SettingsError(`${path} worktree: "services" must be a path from the project root, or @scope/package/file`);
  }
  const cleanup = parseCleanup(value.cleanup, path);
  return {
    name: typeof name === 'string' ? name : DEFAULT_SETTINGS.name,
    owner: typeof owner === 'string' ? owner : DEFAULT_SETTINGS.owner,
    ...(typeof cloudCheck === 'string' ? { cloudCheck: isAbsolute(cloudCheck) ? cloudCheck : resolve(root, cloudCheck) } : {}),
    ...(typeof services === 'string' ? { services } : {}),
    ...(cleanup === undefined ? {} : { cleanup }),
  };
}

/** The settings in `<root>/.claude/sarathi.json`; defaults when the file is absent. */
export function readSettings(root: string): WorktreeSettings {
  const path = join(root, '.claude', 'sarathi.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_SETTINGS;
    throw new SettingsError(`cannot read ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SettingsError(`${path} is not JSON`);
  }
  return parseSettings(isRecord(raw) ? raw.worktree : undefined, path, root);
}
