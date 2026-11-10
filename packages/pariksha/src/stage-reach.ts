// enforcement-claims, second half: a validator claim must name something a
// stage RUNS. A dispatcher target that exists proves nothing: a standard can
// name a working validator that no hook, workflow or task ever calls, and
// that validator can fail on the default branch for months unseen.
//
// This walks what the stages execute, from the roots out:
//
//   roots       the files directly in each hooks folder (not those starting
//               with `_`) and the `.yml`/`.yaml` workflows, plus the local
//               actions a workflow or action `uses: ./<actions folder>/<name>`
//   paths       a path a command names under a configured prefix, with a
//               configured extension, resolved against the caller's working
//               directory (a package script's `../../scripts/x.sh` is the
//               root's `scripts/x.sh`); shell scripts and hooks are followed,
//               nothing else is (a runner that spawns any command would make
//               everything reachable); a `<bin>/<name>` binary in command
//               position is reached the same way
//   dispatcher  `<dispatcher> <target>` resolves to that target's case block
//               only; the dispatcher FILE is never followed, since it names
//               every target
//   package     `<call> "X"` in the package runner resolves to
//               `<validatorsDir>/X.sh`
//   pnpm        `pnpm [run] <script>` resolves to the calling workspace's script
//   turbo       `turbo run <task>` resolves to every workspace's script of that
//               name, and to the root's when the turbo config declares
//               `//#<task>`
//
// A cited test file counts as run when a reached script of its workspace runs
// a test runner. A runner's include and exclude globs are not modelled.
//
// Only code lines are read: full-line comments and lines starting with `echo`
// or `printf` are dropped, since hooks print commands for a person to run. A
// workflow or action is parsed as YAML and only its `run:` steps are read: a
// `paths:` filter or a step `name:` that mentions a script watches or
// describes it, it does not run it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { load } from 'js-yaml';

/** The frontmatter of one standard, as the checks read it. */
export interface Standard {
  readonly file: string;
  readonly id: string;
  readonly enforcement: string;
  readonly enforcementConfig: string;
  /** Rules that gate PART of a standard whose whole cannot be linted; verified like `enforcementConfig`. */
  readonly partialGates: string;
  readonly appliesTo: readonly string[];
  /** The script or test a validator claim names. */
  readonly enforcementScript: string;
  /** `status: deprecated`: a retired standard claims nothing. */
  readonly deprecated: boolean;
}

/** One untrue claim: the standard's file and id, the rule or path it names, and why. */
export interface Problem {
  readonly file: string;
  readonly id: string;
  readonly rule: string;
  readonly reason: string;
}

export interface PackageRunner {
  /** The script whose `<call> "X"` lines run validators. */
  readonly path: string;
  /** The shell function that runs one validator. */
  readonly call: string;
  /** Where validator X is, as `<validatorsDir>/X.sh`. */
  readonly validatorsDir: string;
}

/** What the stage walk reads from the config. */
export interface StageConfig {
  /** The validation dispatcher, a shell `case` over target names. */
  readonly dispatcher: string;
  /** `<dispatcher file name> <target>`, capturing the target. */
  readonly dispatchCall: RegExp;
  readonly packageRunner: PackageRunner | undefined;
  readonly hooks: readonly string[];
  readonly workflows: readonly string[];
  readonly actions: readonly string[];
  /** What a command can name: script paths, then (when configured) binaries in command position. */
  readonly runnable: readonly RegExp[];
  /** The pnpm workspace file, whose `packages:` lists the workspaces. */
  readonly workspaceFile: string;
  /** The turbo config, read for `//#<task>`; undefined when the repository has none. */
  readonly turbo: string | undefined;
  /** A cited file that is a test. */
  readonly testFile: RegExp;
  /** A script command that runs a test runner. */
  readonly testRunner: RegExp;
}

/** The repository root, both as a working directory and as a workspace key. */
export const ROOT_DIR = '.';

const read = (root: string, path: string): string => readFileSync(posix.join(root, path), 'utf8');

/** What the stages reach: files, and the package scripts they run. */
export interface StageReach {
  readonly files: Set<string>;
  /** `<workspace dir>\t<script name>` → the script's command. */
  readonly scripts: Map<string, string>;
  readonly workspaces: readonly string[];
}

/** Drops comments and printed text, keeping the lines a shell or runner executes. */
export const codeLines = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*(?:#|echo\b|printf\b)/.test(line))
    .join('\n');

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A `working-directory` as a root-relative folder (GitHub resolves it against
 * the checkout); `fallback` when there is none, or when it is an expression,
 * absolute, or climbs out of the root.
 */
const workingDir = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('${{') || posix.isAbsolute(value.trim())) return fallback;
  const dir = posix.normalize(value.trim()).replace(/\/$/, '');
  return dir === '..' || dir.startsWith('../') ? fallback : dir;
};

/** A workflow's or job's `defaults.run.working-directory`, else `fallback`. */
const defaultsDir = (node: Node, fallback: string): string => {
  const defaults = node['defaults'];
  const run = isNode(defaults) ? defaults['run'] : undefined;
  return isNode(run) ? workingDir(run['working-directory'], fallback) : fallback;
};

/** One `run:` step: its script, and the folder it runs in. */
export interface RunStep {
  readonly text: string;
  readonly dir: string;
}

/**
 * What a workflow or action executes: the `run:` of each step (an entry of a
 * `steps` list, in the folder its `working-directory` or the enclosing
 * `defaults.run.working-directory` names), and the local actions a step
 * `uses:`. A `run` or `uses` anywhere else (an action input under `with:`, an
 * env value) executes nothing.
 */
export const yamlCommands = (text: string, actionDirs: readonly string[]): { runs: RunStep[]; actions: string[] } => {
  const runs: RunStep[] = [];
  const actions: string[] = [];
  const local = actionDirs.map((dir) => new RegExp(`\\./(${escape(dir)}/[\\w-]+)`));
  const step = (s: Node, dir: string): void => {
    if (typeof s['run'] === 'string') runs.push({ text: s['run'], dir: workingDir(s['working-directory'], dir) });
    const uses = s['uses'];
    if (typeof uses !== 'string') return;
    for (const pattern of local) {
      const hit = pattern.exec(uses);
      if (hit !== null) actions.push(hit[1] as string);
    }
  };
  const walk = (node: unknown, key: string | undefined, dir: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (key === 'steps' && isNode(item)) step(item, dir);
        walk(item, undefined, dir);
      }
      return;
    }
    if (!isNode(node)) return;
    const here = defaultsDir(node, dir);
    for (const [child, value] of Object.entries(node)) walk(value, child, here);
  };
  walk(load(text), undefined, ROOT_DIR);
  return { runs, actions };
};

/**
 * The workspace directories the pnpm workspace file declares: a literal folder,
 * or `dir/*` expanded to its folders holding a package.json; an exclusion
 * (`!dir` or `!dir/*`) removes what it names. Other globs match nothing.
 */
export const workspaceDirs = (root: string, workspaceFile: string): string[] => {
  const parsed = load(read(root, workspaceFile));
  const packages = isNode(parsed) ? parsed['packages'] : undefined;
  if (!Array.isArray(packages)) return [];
  const patterns = packages.filter((p): p is string => typeof p === 'string');
  const matches = (pattern: string, dir: string): boolean => (pattern.endsWith('/*') ? dir.startsWith(pattern.slice(0, -1)) && !dir.slice(pattern.length - 1).includes('/') : dir === pattern);
  const excluded = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const dirs: string[] = [];
  for (const pattern of patterns.filter((p) => !p.startsWith('!'))) {
    if (!pattern.endsWith('/*')) {
      dirs.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    const full = posix.join(root, parent);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full).sort()) {
      if (existsSync(posix.join(full, entry, 'package.json'))) dirs.push(`${parent}/${entry}`);
    }
  }
  return dirs.filter((dir) => !excluded.some((pattern) => matches(pattern, dir)));
};

const scriptsOf = (root: string, dir: string): Record<string, string> => {
  const file = posix.join(dir, 'package.json');
  if (!existsSync(posix.join(root, file))) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(root, file));
  } catch (e) {
    throw new Error(`${file} is not JSON: ${(e as Error).message}`);
  }
  const scripts = typeof parsed === 'object' && parsed !== null ? (parsed as { scripts?: unknown }).scripts : undefined;
  if (typeof scripts !== 'object' || scripts === null) return {};
  return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
};

/** The body of the dispatcher case that names `target` by any of its aliases, or '' when none does. */
export const dispatcherCase = (dispatch: string, target: string): string => {
  for (const match of dispatch.matchAll(/^\s*([a-z][a-z0-9|-]*)\)\n([\s\S]*?)^\s*;;/gm)) {
    if ((match[1] as string).split('|').includes(target)) return match[2] as string;
  }
  return '';
};

/** Every alias a dispatcher case line offers: `a|b)` offers both. */
export const dispatcherTargets = (dispatch: string): Set<string> => new Set([...dispatch.matchAll(/^\s*([a-z][a-z0-9|-]*)\)/gm)].flatMap((line) => (line[1] as string).split('|')));

/**
 * The patterns for what a command can name. `prefixes` are folder paths
 * ending in `/`, where a `*` segment is one folder name; `bin`, when set, is
 * the folder of installed binaries, read only in command position: a line's
 * first word, or one after a separator, `!`, a shell keyword that starts a
 * command (`if`, `elif`, `else`, `then`, `do`, `while`, `until`) or `exec`,
 * past any VAR=value prefixes. `test -x <bin>/x` runs nothing.
 */
export const runnablePatterns = (prefixes: readonly string[], extensions: readonly string[], bin: string | undefined): RegExp[] => {
  const folder = (prefix: string): string =>
    prefix
      .slice(0, -1)
      .split('/')
      .map((segment) => (segment === '*' ? '[\\w-]+' : escape(segment)))
      .join('\\/');
  const alternatives = [...prefixes].sort((a, b) => b.length - a.length).map((p) => `${folder(p)}\\/`);
  const patterns = [new RegExp(`(?<![\\w./-])((?:\\.\\.?\\/)*(?:${alternatives.join('|')})[\\w./-]*[\\w-]\\.(?:${extensions.map(escape).join('|')}))(?![\\w])`, 'g')];
  if (bin !== undefined) {
    patterns.push(new RegExp(`(?:^|[;&|(!]|\\b(?:if|elif|else|then|do|while|until|exec)\\b)[^\\S\\n]*(?:\\w+=\\S*[^\\S\\n]+)*["']?((?:\\.\\.?\\/)*${escape(bin)}\\/[\\w-]+)(?![\\w./-])`, 'gm'));
  }
  return patterns;
};

/** Root-relative paths a command names, resolved from the directory it runs in; a path that climbs out of the root is dropped. */
export const pathsIn = (text: string, cwd: string, runnable: readonly RegExp[]): string[] => {
  const paths: string[] = [];
  for (const pattern of runnable) {
    for (const match of text.matchAll(pattern)) {
      const resolved = posix.normalize(posix.join(cwd, match[1] as string));
      if (!resolved.startsWith('../')) paths.push(resolved);
    }
  }
  return paths;
};

/** Is `path` a file directly in one of the hooks folders? */
const isHook = (path: string, hooks: readonly string[]): boolean => hooks.some((dir) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'));

/** Walks every stage root and returns what it reaches. */
export const resolveStageReach = (root: string, config: StageConfig): StageReach => {
  const workspaces = workspaceDirs(root, config.workspaceFile);
  const turbo = config.turbo === undefined ? '' : read(root, config.turbo);
  const dispatch = read(root, config.dispatcher);
  const reach: StageReach = { files: new Set(), scripts: new Map(), workspaces };
  const seen = new Set<string>();
  const runner = config.packageRunner;
  const runnerCall = new RegExp(`${escape(runner?.call ?? '')}\\s+"([\\w-]+)"`, 'g');

  const visitScript = (dir: string, name: string): void => {
    const scripts = scriptsOf(root, dir);
    // Own keys only: `pnpm constructor` names no script, not Object's.
    const command = Object.hasOwn(scripts, name) ? scripts[name] : undefined;
    const key = `${dir}\t${name}`;
    if (command === undefined || reach.scripts.has(key)) return;
    reach.scripts.set(key, command);
    visitText(command, dir);
  };

  const visitFile = (path: string, cwd: string): void => {
    const key = `${path}\t${cwd}`;
    if (path === config.dispatcher || seen.has(key)) return;
    seen.add(key);
    const full = posix.join(root, path);
    if (!existsSync(full) || !statSync(full).isFile()) return;
    reach.files.add(path);
    if (/\.ya?ml$/.test(path)) {
      let commands: ReturnType<typeof yamlCommands>;
      try {
        commands = yamlCommands(read(root, path), config.actions);
      } catch (e) {
        throw new Error(`${path} is not YAML: ${(e as Error).message}`);
      }
      for (const action of commands.actions) {
        for (const name of ['action.yml', 'action.yaml']) visitFile(`${action}/${name}`, ROOT_DIR);
      }
      // A workflow or action runs from the checkout, so a step's folder is root-relative.
      for (const step of commands.runs) visitText(step.text, step.dir);
      return;
    }
    if (!path.endsWith('.sh') && !isHook(path, config.hooks)) return;
    const text = codeLines(read(root, path));
    if (runner !== undefined && path === runner.path) {
      for (const match of text.matchAll(runnerCall)) visitFile(`${runner.validatorsDir}/${match[1] as string}.sh`, cwd);
    }
    visitText(text, cwd);
  };

  const visitText = (raw: string, cwd: string): void => {
    const text = codeLines(raw);
    for (const path of pathsIn(text, cwd, config.runnable)) visitFile(path, cwd);
    for (const match of text.matchAll(new RegExp(config.dispatchCall.source, 'g'))) {
      visitText(dispatcherCase(dispatch, match[1] as string), ROOT_DIR);
    }
    for (const match of text.matchAll(/\bpnpm\s+(?:run\s+)?([a-z][\w:.-]*)/g)) visitScript(cwd, match[1] as string);
    for (const match of text.matchAll(/\bturbo\s+run((?:\s+[^-\s|&;>][^\s|&;>]*)+)/g)) {
      for (const task of (match[1] as string).trim().split(/\s+/)) {
        if (task.startsWith('//#')) {
          visitScript(ROOT_DIR, task.slice(3));
          continue;
        }
        for (const dir of workspaces) visitScript(dir, task);
        if (turbo.includes(`"//#${task}"`)) visitScript(ROOT_DIR, task);
      }
    }
  };

  const roots: string[] = [];
  for (const [dirs, isRoot] of [
    [config.hooks, (entry: string) => !entry.startsWith('_')],
    [config.workflows, (entry: string) => /\.ya?ml$/.test(entry)],
  ] as const) {
    for (const dir of dirs) {
      const full = posix.join(root, dir);
      if (!existsSync(full)) continue;
      for (const entry of readdirSync(full).sort()) if (isRoot(entry)) roots.push(`${dir}/${entry}`);
    }
  }
  for (const path of roots) visitFile(path, ROOT_DIR);
  return reach;
};

/** The workspace a path belongs to: the longest declared prefix, else the root. */
const ownerOf = (path: string, workspaces: readonly string[]): string => workspaces.filter((dir) => path.startsWith(`${dir}/`)).sort((a, b) => b.length - a.length)[0] ?? ROOT_DIR;

/** Is a cited test file run by a test runner some stage starts in its workspace? */
export const testFileRuns = (path: string, reach: StageReach, config: Pick<StageConfig, 'testFile' | 'testRunner'>): boolean => {
  if (!config.testFile.test(path)) return false;
  const owner = ownerOf(path, reach.workspaces);
  return [...reach.scripts].some(([key, command]) => key.startsWith(`${owner}\t`) && config.testRunner.test(command));
};

/** Every live validator claim whose named scripts no stage reaches. */
export const findUncalledValidators = (root: string, standards: readonly Standard[], config: StageConfig, given?: StageReach): Problem[] => {
  const claims = standards.filter((s) => s.enforcement === 'validator' && !s.deprecated);
  // Walked only when some claim needs it: a corpus with no live validator
  // claim has nothing to resolve, and its tree need not be a workspace.
  if (claims.length === 0) return [];
  const reach = given ?? resolveStageReach(root, config);
  const dispatch = read(root, config.dispatcher);
  const problems: Problem[] = [];

  for (const standard of claims) {
    const target = config.dispatchCall.exec(standard.enforcementConfig);
    // Once each: the script and the dispatcher target usually name one file.
    const named = [
      ...new Set([
        ...(standard.enforcementScript === '' ? [] : [posix.normalize(standard.enforcementScript)]),
        ...(target === null ? [] : pathsIn(dispatcherCase(dispatch, target[1] as string), ROOT_DIR, config.runnable)),
      ]),
    ];
    const report = (rule: string, reason: string): void => {
      problems.push({ file: standard.file, id: standard.id, rule, reason });
    };
    if (named.length === 0) {
      report(standard.enforcementConfig || '(empty)', 'claims validator enforcement but names no script — nothing here can run');
      continue;
    }
    const missing = named.filter((path) => !existsSync(posix.join(root, path)));
    for (const path of missing) report(path, 'does not exist');
    if (missing.length > 0) continue;
    if (!named.some((path) => reach.files.has(path) || testFileRuns(path, reach, config))) {
      report(named.join(', '), 'is never run by a hook or workflow — the claim names a validator nothing calls');
    }
  }
  return problems;
};
