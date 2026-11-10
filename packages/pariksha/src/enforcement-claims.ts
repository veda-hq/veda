// enforcement-claims: a standard's frontmatter says how it is enforced, and
// nothing else checks that the description is true. A standard can claim
// `enforcement: eslint-rule` naming a rule that was never configured, or one
// configured in one workspace and not the one it `applies_to`, or claim
// `enforcement: validator` naming a script nothing runs; the corpus then reads
// as enforced while nothing runs. The document asserting the guarantee is the
// one nobody can verify by reading.
//
// This resolves each configured workspace's REAL flat config through the
// ESLint API, and holds every rule a standard names to being on (error or
// warn) in every workspace it applies to; a rule at `off` is a false claim.
// Validator claims must name a dispatcher target that exists, and something
// a stage runs (stage-reach.ts).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, posix, relative, resolve } from 'node:path';
import { load } from 'js-yaml';
import { isRecord, isRepoPath, list, object, onlyKeys, optionalText, parseJson, path, paths, records, regex, text, type Raw } from './registry-ratchet.ts';
import { dispatcherTargets, findUncalledValidators, runnablePatterns, type PackageRunner, type Problem, type Standard, type StageConfig } from './stage-reach.ts';

export interface Workspace {
  /** The folder whose flat config is resolved, `.` for the root. */
  readonly dir: string;
  /** Files (relative to `dir`) whose config is resolved; a source and a test, since test rules are scoped to test globs. */
  readonly probes: readonly string[];
}

export interface Config extends StageConfig {
  /** A display id for the check, printed in its output. */
  readonly id: string | undefined;
  /** The folder holding the standards, `.md` files with YAML frontmatter, read recursively. */
  readonly standards: string;
  readonly workspaces: readonly Workspace[];
}

const KEYS = ['id', 'standards', 'workspaces', 'dispatcher', 'packageRunner', 'stageRoots', 'runnable', 'workspaceList', 'tests'];

/** A list of folder paths, empty when absent or empty. */
const folders = (raw: Raw, key: string, where: string): string[] => {
  const v = list(raw, key, where);
  return v.length === 0 ? [] : paths(raw, key, where);
};

/** An optional object key: absent or null is none. */
const optional = (raw: Raw, key: string): Raw | undefined => (raw[key] === undefined || raw[key] === null ? undefined : object(raw, key, ''));

const PREFIX = /^(?:(?:[\w.-]+|\*)\/)+$/;

/** The config text: every repository-specific literal of the check. Throws naming the first bad key. */
export const parseConfig = (source: string): Config => {
  const raw = parseJson(source);
  onlyKeys(raw, KEYS, '');
  const workspaces = records(list(raw, 'workspaces', ''), 'workspaces').map(({ raw: w, where }): Workspace => {
    onlyKeys(w, ['dir', 'probes'], where);
    const dir = text(w, 'dir', where);
    if (dir !== '.' && !isRepoPath(dir)) throw new Error(`${where}"dir": "${dir}" is not "." or a normalized root-relative path`);
    return { dir, probes: paths(w, 'probes', where) };
  });
  if (workspaces.length === 0) throw new Error('"workspaces" is empty, so no rule could be found enabled');
  const dirs = workspaces.map((w) => w.dir);
  const twice = dirs.find((d, i) => dirs.indexOf(d) !== i);
  if (twice !== undefined) throw new Error(`workspace "${twice}" is listed more than once`);

  const dispatcherRaw = object(raw, 'dispatcher', '');
  onlyKeys(dispatcherRaw, ['path'], 'dispatcher: ');
  const dispatcher = path(dispatcherRaw, 'path', 'dispatcher: ');

  const runnerRaw = optional(raw, 'packageRunner');
  let packageRunner: PackageRunner | undefined;
  if (runnerRaw !== undefined) {
    onlyKeys(runnerRaw, ['path', 'call', 'validatorsDir'], 'packageRunner: ');
    const call = text(runnerRaw, 'call', 'packageRunner: ');
    if (!/^[A-Za-z_][\w-]*$/.test(call)) throw new Error('packageRunner: "call" must be a shell function name');
    packageRunner = { path: path(runnerRaw, 'path', 'packageRunner: '), call, validatorsDir: path(runnerRaw, 'validatorsDir', 'packageRunner: ') };
  }

  const stages = object(raw, 'stageRoots', '');
  onlyKeys(stages, ['hooks', 'workflows', 'actions'], 'stageRoots: ');
  const hooks = folders(stages, 'hooks', 'stageRoots: ');
  const workflows = folders(stages, 'workflows', 'stageRoots: ');
  if (hooks.length + workflows.length === 0) throw new Error('stageRoots: "hooks" and "workflows" are both empty, so no stage would be walked');

  const runnableRaw = object(raw, 'runnable', '');
  onlyKeys(runnableRaw, ['prefixes', 'extensions', 'bin'], 'runnable: ');
  const prefixes = list(runnableRaw, 'prefixes', 'runnable: ').map((p, i) => {
    if (typeof p !== 'string' || !PREFIX.test(p) || p.split('/').some((s) => s === '.' || s === '..')) {
      throw new Error(`runnable.prefixes[${i}]: ${JSON.stringify(p)} is not a folder path ending in "/" (a "*" segment is one folder)`);
    }
    return p;
  });
  if (prefixes.length === 0) throw new Error('runnable: "prefixes" is empty, so no command would name a script');
  const extensions = list(runnableRaw, 'extensions', 'runnable: ').map((e, i) => {
    if (typeof e !== 'string' || !/^[A-Za-z0-9]+$/.test(e)) throw new Error(`runnable.extensions[${i}]: ${JSON.stringify(e)} is not a file extension without its dot`);
    return e;
  });
  if (extensions.length === 0) throw new Error('runnable: "extensions" is empty, so no command would name a script');
  const bin = runnableRaw['bin'] === undefined || runnableRaw['bin'] === null ? undefined : path(runnableRaw, 'bin', 'runnable: ');

  const listRaw = object(raw, 'workspaceList', '');
  onlyKeys(listRaw, ['pnpm', 'turbo'], 'workspaceList: ');
  const turbo = listRaw['turbo'] === undefined || listRaw['turbo'] === null ? undefined : path(listRaw, 'turbo', 'workspaceList: ');

  const tests = object(raw, 'tests', '');
  onlyKeys(tests, ['file', 'runner'], 'tests: ');

  return {
    id: optionalText(raw, 'id', ''),
    standards: path(raw, 'standards', ''),
    workspaces,
    dispatcher,
    dispatchCall: new RegExp(`${basename(dispatcher).replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}\\s+([a-z][a-z0-9-]*)`),
    packageRunner,
    hooks,
    workflows,
    actions: folders(stages, 'actions', 'stageRoots: '),
    runnable: runnablePatterns(prefixes, extensions, bin),
    workspaceFile: path(listRaw, 'pnpm', 'workspaceList: '),
    turbo,
    testFile: regex(tests['file'], 'tests.file'),
    testRunner: regex(tests['runner'], 'tests.runner'),
  };
};

const markdown = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) markdown(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
};

/**
 * The standards under `dir` that declare an enforcement, sorted by file.
 *
 * Frontmatter is PARSED AS YAML, not matched with regexes: a regex read the
 * block form's first entry as `- apps/api` and dropped the rest, and its
 * repair still read a multiline flow list as [], which is indistinguishable
 * from "declares no workspace": a silent skip of the very check. Frontmatter
 * that does not parse is skipped, never counted as a standard that passed.
 */
export const readStandards = (root: string, dir: string): Standard[] => {
  const standards: Standard[] = [];
  for (const file of markdown(join(root, dir))) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8'));
    if (match === null) continue;
    let frontmatter: Raw;
    try {
      const loaded = load(match[1] as string);
      if (!isRecord(loaded)) continue;
      frontmatter = loaded;
    } catch {
      continue;
    }
    const field = (name: string): string => {
      const value = frontmatter[name];
      if (value === undefined || value === null) return '';
      return typeof value === 'string' ? value.trim() : String(value);
    };
    // A bare scalar is a one-entry list: `applies_to: apps/api` claims one
    // workspace, and reading it as no claim would be the silent skip again.
    const listField = (name: string): string[] => {
      const value = frontmatter[name];
      return (Array.isArray(value) ? value : [value])
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean);
    };
    const enforcement = field('enforcement');
    if (enforcement === '') continue;
    standards.push({
      file: relative(root, file).split('\\').join('/'),
      id: field('id'),
      enforcement,
      enforcementConfig: field('enforcement_config'),
      partialGates: field('partial_gates'),
      appliesTo: listField('applies_to'),
      enforcementScript: field('enforcement_script'),
      deprecated: field('status') === 'deprecated',
    });
  }
  return standards.sort((a, b) => a.file.localeCompare(b.file));
};

/**
 * The rule names a claim names. Entries are prose as often as not, and a
 * parenthetical narrows a rule rather than naming one (`no-restricted-globals
 * (Buffer)`). A rule name is one unbroken token, hyphen or not (`eqeqeq`,
 * `curly`); prose is a sentence. An empty claim names nothing.
 */
export const claimedRules = (claim: string): string[] =>
  // Parentheticals go first: `no-restricted-globals (Buffer, process)` is one rule.
  (claim.replace(/\([^)]*\)/g, '').match(/[^,]+/g) ?? []).map((part) => part.trim()).filter((part) => /^[@a-z][\w@/.-]*$/i.test(part));

/** Is one resolved rule setting on (error or warn), as a number or a word, bare or an options array's head? */
export const ruleIsOn = (setting: unknown): boolean => {
  const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
  return severity !== 0 && severity !== 'off';
};

/** The claim token for `linterOptions.noInlineConfig`, which refuses every inline directive as a rule would. */
export const NO_INLINE_CONFIG = 'linterOptions.noInlineConfig';

/** The ESLint class, as far as this check uses it. */
export interface Linter {
  calculateConfigForFile(file: string): Promise<unknown>;
}
export type LinterClass = new (options: { cwd: string }) => Linter;

/** ESLint's class from pariksha's resolution of the `eslint` peer; a message naming why not when it cannot be loaded. */
export const loadEslint = async (load: () => Promise<{ ESLint?: unknown }> = () => import('eslint')): Promise<LinterClass | string> => {
  try {
    const mod = await load();
    if (typeof mod.ESLint === 'function') return mod.ESLint as LinterClass;
  } catch {
    // not installed beside pariksha
  }
  return 'needs the eslint package (>=9.24 <10) installed beside pariksha';
};

/**
 * Every rule that is on in each workspace's resolved config, by workspace. A
 * probe ESLint ignores contributes nothing; one whose config does not load is
 * skipped while another probe of the workspace resolves, and a workspace no
 * probe resolves exits 2, since its rules would read as all off.
 */
export const activeRules = async (ESLint: LinterClass, root: string, workspaces: readonly Workspace[]): Promise<Map<string, Set<string>>> => {
  const resolved = await Promise.all(
    workspaces.map(async (workspace) => {
      const cwd = resolve(root, workspace.dir);
      if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`workspace "${workspace.dir}" is not a folder under the root`);
      const eslint = new ESLint({ cwd });
      const settled = await Promise.allSettled(workspace.probes.map((probe) => eslint.calculateConfigForFile(resolve(cwd, probe))));
      const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (failed !== undefined && settled.every((s) => s.status === 'rejected')) {
        throw new Error(`no probe of workspace "${workspace.dir}" resolves a config: ${(failed.reason as Error).message}`);
      }
      const active = new Set<string>();
      for (const s of settled) {
        if (s.status === 'rejected' || !isRecord(s.value)) continue;
        const rules = s.value['rules'];
        if (isRecord(rules)) for (const [name, setting] of Object.entries(rules)) if (ruleIsOn(setting)) active.add(name);
        const options = s.value['linterOptions'];
        if (isRecord(options) && options['noInlineConfig'] === true) active.add(NO_INLINE_CONFIG);
      }
      return [workspace.dir, active] as const;
    }),
  );
  return new Map(resolved);
};

/**
 * Every workspace an `applies_to` target covers. A target is a path prefix
 * and names a SET: `packages` covers every workspace under it, and each must
 * enforce the rule. A target under no workspace belongs to the root one,
 * where root-level folders live.
 */
export const ownersOf = (target: string, workspaces: Iterable<string>): string[] => {
  const matches = [...workspaces].filter((dir) => target === dir || target.startsWith(`${dir}/`) || dir.startsWith(`${target}/`));
  return matches.length > 0 ? matches : ['.'];
};

const verifyRules = (standard: Standard, rules: readonly string[], field: string, problems: Problem[], anywhere: ReadonlySet<string>, byWorkspace: ReadonlyMap<string, ReadonlySet<string>>): void => {
  for (const rule of rules) {
    if (!anywhere.has(rule)) {
      problems.push({ file: standard.file, id: standard.id, rule, reason: `(${field}) is not enabled in ANY workspace config — the claim is false` });
      continue;
    }
    const scopes = standard.appliesTo
      .flatMap((target) => ownersOf(target, byWorkspace.keys()))
      .map((dir) => byWorkspace.get(dir))
      .filter((active): active is ReadonlySet<string> => active !== undefined);
    // EVERY, not some: a rule enabled in one of two claimed workspaces is
    // unenforced in the other. No applies_to has no scope, and passes.
    if (!scopes.every((active) => active.has(rule))) {
      problems.push({
        file: standard.file,
        id: standard.id,
        rule,
        reason: `(${field}) is enabled elsewhere but NOT in ${standard.appliesTo.join(', ')}, which is where this rule claims to apply`,
      });
    }
  }
};

/** The eslint-rule, partial_gates and dispatcher-target problems, against each workspace's active rules. */
export const findEnforcementProblems = (standards: readonly Standard[], byWorkspace: ReadonlyMap<string, ReadonlySet<string>>, dispatch: string, config: Pick<Config, 'dispatcher' | 'dispatchCall'>): Problem[] => {
  const anywhere = new Set([...byWorkspace.values()].flatMap((rules) => [...rules]));
  const targets = dispatcherTargets(dispatch);
  const problems: Problem[] = [];
  for (const standard of standards) {
    // A retired standard claims nothing.
    if (standard.deprecated) continue;
    // partial_gates is verified whatever the enforcement mode: the field
    // exists to be usable on a guidance standard. Prose there names no rule,
    // would check nothing, and is refused like an empty eslint-rule claim.
    const partial = claimedRules(standard.partialGates);
    if (standard.partialGates !== '' && partial.length === 0) {
      problems.push({ file: standard.file, id: standard.id, rule: standard.partialGates, reason: '(partial_gates) names no rule this gate can adjudicate — a partial gate that cannot be checked is not a gate' });
    }
    verifyRules(standard, partial, 'partial_gates', problems, anywhere, byWorkspace);

    // A validator claim naming a dispatcher target must name a real one, by
    // any alias on its case line; otherwise relabelling an eslint-rule claim
    // as a validator would be the cheapest way past this check.
    if (standard.enforcement === 'validator') {
      const target = config.dispatchCall.exec(standard.enforcementConfig);
      if (target !== null && !targets.has(target[1] as string)) {
        problems.push({ file: standard.file, id: standard.id, rule: target[1] as string, reason: `is not a case in ${config.dispatcher} — the command does not exist` });
      }
      continue;
    }
    if (standard.enforcement !== 'eslint-rule') continue;
    const rules = claimedRules(standard.enforcementConfig);
    if (rules.length === 0) {
      problems.push({
        file: standard.file,
        id: standard.id,
        rule: standard.enforcementConfig || '(empty)',
        reason: 'claims eslint-rule enforcement but enforcement_config names no rule — nothing here can be checked, by a reader or by this gate',
      });
      continue;
    }
    verifyRules(standard, rules, 'enforcement_config', problems, anywhere, byWorkspace);
  }
  return problems;
};

/** What one run found: every standard read, and every problem. */
export interface Outcome {
  readonly standards: readonly Standard[];
  readonly problems: readonly Problem[];
}

/** Reads the standards and checks every claim; throws on anything that leaves the check unable to run. */
export const checkClaims = async (root: string, config: Config, ESLint: LinterClass): Promise<Outcome> => {
  const dir = statSync(join(root, config.standards), { throwIfNoEntry: false });
  if (!dir?.isDirectory()) throw new Error(`the standards folder ${config.standards} is not a folder under the root`);
  const standards = readStandards(root, config.standards);
  if (standards.length === 0) throw new Error(`no standard under ${config.standards} declares an enforcement — the scan failed`);
  const dispatch = readFileSync(posix.join(root, config.dispatcher), 'utf8');
  const byWorkspace = await activeRules(ESLint, root, config.workspaces);
  return { standards, problems: [...findEnforcementProblems(standards, byWorkspace, dispatch, config), ...findUncalledValidators(root, standards, config)] };
};

/** The verdict lines: each problem, or the counts of the claims that held. */
export const formatOutcome = (prefix: string, outcome: Outcome): { ok: boolean; out: string[]; err: string[] } => {
  const { standards, problems } = outcome;
  if (problems.length > 0) {
    return {
      ok: false,
      out: [],
      err: [
        ...problems.map((p) => `${prefix} ${p.file} (${p.id || 'no id'}): \`${p.rule}\` ${p.reason}`),
        `${prefix} ${problems.length} untrue enforcement claim(s); a standard whose enforcement is described wrongly reads as enforced while nothing runs`,
      ],
    };
  }
  const claimed = standards.filter((s) => s.enforcement === 'eslint-rule' && !s.deprecated).length;
  const run = standards.filter((s) => s.enforcement === 'validator' && !s.deprecated).length;
  return { ok: true, out: [`${prefix} every eslint-rule claim is real and every validator claim runs at a stage (${claimed} + ${run} of ${standards.length} rule(s))`], err: [] };
};
