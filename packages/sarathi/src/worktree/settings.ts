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
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface WorktreeSettings {
  readonly name: string;
  readonly owner: string;
  readonly cloudCheck?: string;
}

export class SettingsError extends Error {
  override readonly name = 'SettingsError';
  readonly code = 'SETTINGS';
}

export const DEFAULT_SETTINGS: WorktreeSettings = { name: 'sarathi', owner: 'the owner' };

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const KEYS = new Set(['name', 'owner', 'cloudCheck']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses the `worktree` value of the hook list at `path`; relative paths start at `root`. */
export function parseSettings(value: unknown, path: string, root: string): WorktreeSettings {
  if (value === undefined) return DEFAULT_SETTINGS;
  if (!isRecord(value)) throw new SettingsError(`${path}: "worktree" must be an object`);
  const extra = Object.keys(value).filter(key => !KEYS.has(key));
  if (extra.length > 0) throw new SettingsError(`${path} worktree: unknown key ${extra.map(key => `"${key}"`).join(', ')}`);
  const { name, owner, cloudCheck } = value;
  if (name !== undefined && (typeof name !== 'string' || !NAME.test(name))) {
    throw new SettingsError(`${path} worktree: "name" must be lowercase letters, digits and dashes, starting with a letter`);
  }
  if (owner !== undefined && (typeof owner !== 'string' || owner.trim() === '')) throw new SettingsError(`${path} worktree: "owner" must be a name`);
  if (cloudCheck !== undefined && (typeof cloudCheck !== 'string' || cloudCheck === '')) throw new SettingsError(`${path} worktree: "cloudCheck" must be a path`);
  return {
    name: typeof name === 'string' ? name : DEFAULT_SETTINGS.name,
    owner: typeof owner === 'string' ? owner : DEFAULT_SETTINGS.owner,
    ...(typeof cloudCheck === 'string' ? { cloudCheck: isAbsolute(cloudCheck) ? cloudCheck : resolve(root, cloudCheck) } : {}),
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
