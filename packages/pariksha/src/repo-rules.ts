// repo-rules: small rules over a repository's files, each one a mistake an
// agent made and a lesson recorded, now refused where it is written.
//
// Every rule has an id and a lesson. A run judges the files a selection names
// (every tracked file by default) and prints one line per finding, then each
// fired rule's lesson once: what goes wrong and the fix. So the refusal carries
// the lesson, and nobody has to have read the lessons file.
//
// Settings, from `.pariksha.json` `checks.repo-rules` or `--config`:
//
//   { "rules": { "<id>": { "off": "<why>" } } }                   the rule does not run
//   { "rules": { "<id>": { "allow": { "<path>": "<why>" } } } }   these files are not judged
//
// and a few rules' own settings beside `allow` (each rule names its own). A key
// or rule id this version does not know is refused, as are an empty reason and
// an allowed path that is not tracked: each would be a setting nobody applies.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Git } from './git.ts';

export interface Finding {
  readonly file: string;
  /** 1-based; undefined when the finding is about the file as a whole. */
  readonly line?: number;
  readonly detail: string;
}

/** What a rule sees of the repository. */
export interface Repo {
  /** The repository's top level, absolute. */
  readonly root: string;
  /** The files the selection names, relative to the root. */
  readonly files: readonly string[];
  /** Every tracked file, relative to the root. */
  readonly tracked: () => readonly string[];
  /** A file's text from the working tree; undefined when it is not there. */
  readonly read: (path: string) => string | undefined;
  /** A file's bytes from the working tree; undefined when it is not there. */
  readonly bytes: (path: string) => Buffer | undefined;
  /** A file's size in bytes; undefined when it is not there. */
  readonly size: (path: string) => number | undefined;
  /** Paths the selection deletes or renames away (old paths), relative to the root. */
  readonly removed: () => readonly string[];
  /** Lines of tracked files matching `pathspecs` (git globs) that hold any of `fixed`, as the selection's side has them. */
  readonly grep: (fixed: readonly string[], pathspecs: readonly string[]) => GrepHit[];
  readonly git: Git;
}

export interface GrepHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Where a selection's tracked files are read for `grep`: the index, a commit, or the working tree. */
export type Side = { readonly kind: 'index' } | { readonly kind: 'commit'; readonly commit: string } | { readonly kind: 'tree' };

/**
 * `git grep -n` output as hits. A grep of a commit starts every line with
 * `prefix` (`<rev>:`), which is dropped; any other grep has none.
 */
export const parseGrep = (out: string, prefix?: string): GrepHit[] =>
  out.split('\n').flatMap((raw) => {
    const match = /(.*?):(\d+):(.*)/.exec(prefix === undefined ? raw : raw.slice(prefix.length));
    return match === null ? [] : [{ file: match[1] as string, line: Number(match[2]), text: match[3] as string }];
  });

/** `grep` for a side: git exits 1 when nothing matches, which is no hit, not a failure. */
export const sideGrep =
  (git: Git, side: Side) =>
  (fixed: readonly string[], pathspecs: readonly string[]): GrepHit[] => {
    if (fixed.length === 0) return [];
    const where = side.kind === 'tree' ? [] : side.kind === 'index' ? ['--cached'] : [side.commit];
    const out = git.run(['grep', '--no-color', '-n', '-I', '-F', ...fixed.flatMap((f) => ['-e', f]), ...where, '--', ...pathspecs]);
    if (out === undefined) return [];
    return parseGrep(out, side.kind === 'commit' ? `${side.commit}:` : undefined);
  };

export interface Rule {
  readonly id: string;
  /** What goes wrong and the fix, printed once under the rule's findings. */
  readonly lesson: string;
  /** The rule's own settings keys beside `allow`, with how each is checked: the problem, returned or thrown, or undefined. */
  readonly settings?: Readonly<Record<string, (value: unknown) => string | undefined>>;
  /** The findings in `repo`; `settings` holds the rule's own keys as given. */
  readonly run: (repo: Repo, settings: Readonly<Record<string, unknown>>) => Finding[];
}

export interface RuleSettings {
  readonly off?: string;
  readonly allow: ReadonlyMap<string, string>;
  readonly own: Readonly<Record<string, unknown>>;
}

export interface Config {
  readonly rules: ReadonlyMap<string, RuleSettings>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const reason = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** The settings `text` holds, checked against `rules`. */
export const parseConfig = (text: string, rules: readonly Rule[]): Config => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`settings are not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('settings must be a JSON object');
  for (const key of Object.keys(raw)) if (key !== 'rules') throw new Error(`unknown key "${key}"; repo-rules reads "rules"`);
  const out = new Map<string, RuleSettings>();
  if (raw['rules'] === undefined) return { rules: out };
  if (!isRecord(raw['rules'])) throw new Error('"rules" must be an object of rule ids');
  for (const [id, value] of Object.entries(raw['rules'])) {
    const rule = rules.find((r) => r.id === id);
    if (rule === undefined) throw new Error(`unknown rule "${id}"; the rules are ${rules.map((r) => r.id).join(', ')}`);
    if (!isRecord(value)) throw new Error(`rules.${id} must be an object: { "off": "<why>" } or { "allow": { "<path>": "<why>" } }`);
    const own: Record<string, unknown> = {};
    let off: string | undefined;
    const allow = new Map<string, string>();
    for (const [key, v] of Object.entries(value)) {
      if (key === 'off') {
        if (!reason(v)) throw new Error(`rules.${id}.off must say why the rule is off`);
        off = v;
      } else if (key === 'allow') {
        if (!isRecord(v)) throw new Error(`rules.${id}.allow must be an object of paths, each with its reason`);
        for (const [path, why] of Object.entries(v)) {
          if (!reason(why)) throw new Error(`rules.${id}.allow["${path}"] must say why the file is allowed`);
          allow.set(path, why);
        }
      } else if (rule.settings !== undefined && Object.hasOwn(rule.settings, key)) {
        let wrong: string | undefined;
        try {
          wrong = (rule.settings[key] as (value: unknown) => string | undefined)(v);
        } catch (e) {
          throw new Error(`rules.${id}.${key} ${(e as Error).message}`);
        }
        if (wrong !== undefined) throw new Error(`rules.${id}.${key} ${wrong}`);
        own[key] = v;
      } else {
        const keys = ['off', 'allow', ...Object.keys(rule.settings ?? {})];
        throw new Error(`rules.${id}: unknown key "${key}"; ${id} reads ${keys.join(', ')}`);
      }
    }
    if (off !== undefined && (allow.size > 0 || Object.keys(own).length > 0)) throw new Error(`rules.${id}: "off" stands alone; a rule that is off reads no other setting`);
    out.set(id, { ...(off === undefined ? {} : { off }), allow, own });
  }
  return { rules: out };
};

/** Allowed paths that git does not track: a stale allowance hides nothing and should go. */
export const staleAllowances = (config: Config, tracked: readonly string[]): string[] => {
  const all = new Set(tracked);
  const stale: string[] = [];
  for (const [id, settings] of config.rules) for (const path of settings.allow.keys()) if (!all.has(path)) stale.push(`rules.${id}.allow["${path}"]`);
  return stale;
};

export interface Outcome {
  readonly ok: boolean;
  readonly out: string[];
  readonly err: string[];
}

/** Runs every rule that is on over `repo`, allowed files left out of its findings. */
export const runRules = (repo: Repo, rules: readonly Rule[], config: Config): Outcome => {
  const P = 'pariksha repo-rules:';
  const err: string[] = [];
  const fired: Rule[] = [];
  let ran = 0;
  for (const rule of rules) {
    const settings = config.rules.get(rule.id);
    if (settings?.off !== undefined) continue;
    ran += 1;
    const allow = settings?.allow ?? new Map<string, string>();
    const findings = rule.run(repo, settings?.own ?? {}).filter((f) => !allow.has(f.file));
    if (findings.length === 0) continue;
    fired.push(rule);
    for (const f of findings) err.push(`${P} ${f.file}${f.line === undefined ? '' : `:${f.line}`}: ${rule.id}: ${f.detail}`);
  }
  if (fired.length === 0) return { ok: true, out: [`${P} ${repo.files.length} file(s), ${ran} rule(s), nothing refused`], err: [] };
  err.push('');
  for (const rule of fired) err.push(`${rule.id}: ${rule.lesson}`);
  err.push('', `Not a mistake? Name the file under rules.<id>.allow in the repo-rules settings, with the reason.`);
  return { ok: false, out: [], err };
};

/** A repository on disk: the working tree read at `root`. */
export const diskRepo = (root: string, files: readonly string[], tracked: () => readonly string[], removed: () => readonly string[], git: Git, side: Side): Repo => {
  const full = (path: string): string => join(root, path);
  const isFile = (path: string): boolean => {
    try {
      return lstatSync(full(path)).isFile();
    } catch {
      // fail-open: a path gone from the working tree has nothing to read.
    }
    return false;
  };
  return {
    root,
    files,
    tracked,
    removed,
    git,
    grep: sideGrep(git, side),
    read: (path) => (isFile(path) ? readFileSync(full(path), 'utf8') : undefined),
    bytes: (path) => (isFile(path) ? readFileSync(full(path)) : undefined),
    size: (path) => (isFile(path) ? lstatSync(full(path)).size : undefined),
  };
};

/** The 1-based line of offset `index` in `text`. */
export const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
};

/** The 1-based line of the first `needle` in `text` at or after line `from`; undefined when absent. */
export const lineOf = (text: string, needle: string | RegExp, from = 1): number | undefined => {
  const lines = text.split('\n');
  for (let i = Math.max(0, from - 1); i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (typeof needle === 'string' ? line.includes(needle) : needle.test(line)) return i + 1;
  }
  return undefined;
};

/** A settings check: a non-empty list of non-empty strings. */
export const stringList = (value: unknown): string | undefined =>
  Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v !== '') ? undefined : 'must be a non-empty list of strings';

/** A settings check: a positive whole number. */
export const positiveInteger = (value: unknown): string | undefined => (Number.isInteger(value) && (value as number) > 0 ? undefined : 'must be a positive whole number');
