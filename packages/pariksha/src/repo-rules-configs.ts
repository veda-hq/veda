// repo-rules over tool configuration and the code that reads it: Vitest,
// ESLint, the pnpm lockfile, git hooks, Claude Code settings, and gates on a
// pull request's checks.
import { basename, dirname, join, normalize } from 'node:path';
import { lineAt, lineOf, type Finding, type Repo, type Rule } from './repo-rules.ts';
import { isAction, isWorkflow, yamlOf } from './repo-rules-workflows.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** `text` with `//` line comments and `/* *\/` blocks blanked, strings kept; offsets stay where they were. */
export const withoutJsComments = (text: string): string => {
  let out = '';
  let i = 0;
  let quote: string | undefined;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (quote !== undefined) {
      out += c;
      if (c === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === quote || (c === '\n' && quote !== '`')) quote = undefined;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
};

/** JSON with comments and trailing commas, as turbo.json allows; undefined when it does not parse. */
export const parseJsonc = (text: string): unknown => {
  try {
    return JSON.parse(withoutJsComments(text).replace(/,(\s*[}\]])/g, '$1')) as unknown;
  } catch {
    // fail-open: a file that is not JSON is its own tool's to refuse.
    return undefined;
  }
};

/** A Vitest or Vite config file. */
export const isVitestConfig = (path: string): boolean => /(^|\/)(vitest|vite)(\.[\w-]+)*\.(config|workspace)\.(ts|mts|cts|js|mjs|cjs)$/.test(path) || /(^|\/)vitest\.workspace\.(ts|mts|js|mjs|json)$/.test(path);

/** A shell assignment of VITEST_MAX_WORKERS (`VITEST_MAX_WORKERS=2`, `export VITEST_MAX_WORKERS=2`). */
const ASSIGNS_WORKERS = /(?<![\w$])VITEST_MAX_WORKERS=\S/;

/** A turbo run on a command line. */
const RUNS_TURBO = /(?<![\w./-])turbo(?![\w-])/;

/** A shell script: by extension, or a git hook folder's file. */
const isShell = (path: string): boolean => /\.(sh|bash|zsh)$/.test(path) || /^\.(husky|githooks)\/[^/.]+$/.test(path);

/**
 * The lines in `file` that hand VITEST_MAX_WORKERS to a turbo run: a package
 * script or shell line that assigns it and runs turbo, a shell script that
 * exports it and runs turbo later, or a workflow step that runs turbo under an
 * `env:` that sets it.
 */
export const workersIntoTurbo = (file: string, text: string): number[] => {
  if (isWorkflow(file) || isAction(file)) {
    const doc = yamlOf(text);
    const sets = (env: unknown): boolean => isRecord(env) && Object.hasOwn(env, 'VITEST_MAX_WORKERS');
    const top = isRecord(doc) && sets(doc['env']);
    const jobs = isRecord(doc) && isRecord(doc['jobs']) ? Object.values(doc['jobs']) : isRecord(doc) && isRecord(doc['runs']) ? [doc['runs']] : [];
    const hit = jobs.some((job) => {
      if (!isRecord(job) || !Array.isArray(job['steps'])) return false;
      const jobSets = top || sets(job['env']);
      return job['steps'].some((step) => isRecord(step) && typeof step['run'] === 'string' && RUNS_TURBO.test(step['run']) && (jobSets || sets(step['env'])));
    });
    const line = hit ? lineOf(text, 'VITEST_MAX_WORKERS') : undefined;
    return line === undefined ? [] : [line];
  }
  const lines = text.split('\n');
  if (basename(file) === 'package.json') return lines.flatMap((line, i) => (ASSIGNS_WORKERS.test(line) && RUNS_TURBO.test(line) ? [i + 1] : []));
  if (!isShell(file)) return [];
  const exported = lines.findIndex((line) => /^\s*export\s+VITEST_MAX_WORKERS=/.test(line));
  return lines.flatMap((line, i) => {
    if (/^\s*#/.test(line) || !RUNS_TURBO.test(line)) return [];
    return ASSIGNS_WORKERS.test(line) || (exported !== -1 && exported < i) ? [i + 1] : [];
  });
};

/** Whether turbo.json lets VITEST_MAX_WORKERS through strict env mode: loose mode, or a listing in a global or task env list. */
export const turboPassesWorkers = (turbo: unknown): boolean => {
  if (!isRecord(turbo)) return true;
  if (turbo['envMode'] === 'loose') return true;
  const lists: unknown[] = [turbo['globalPassThroughEnv'], turbo['globalEnv']];
  const tasks = turbo['tasks'] ?? turbo['pipeline'];
  if (isRecord(tasks)) for (const task of Object.values(tasks)) if (isRecord(task)) lists.push(task['passThroughEnv'], task['env']);
  const matches = (entry: unknown): boolean => typeof entry === 'string' && new RegExp(`^${entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test('VITEST_MAX_WORKERS');
  return lists.some((list) => Array.isArray(list) && list.some(matches));
};

export const vitest4InertPoolConfig: Rule = {
  id: 'vitest4-inert-pool-config',
  lesson:
    'Vitest 4 removed `poolOptions`, so `poolOptions.forks.maxForks` and its kin do nothing, and with no `maxWorkers` the pool takes `availableParallelism - 1`. Set `maxWorkers` (or `VITEST_MAX_WORKERS`, which Vitest 4 honours over it). Turborepo strict env mode strips `VITEST_MAX_WORKERS` unless turbo.json lists it in `globalPassThroughEnv`.',
  run: (repo) => {
    const findings: Finding[] = [];
    for (const file of repo.files.filter(isVitestConfig)) {
      const text = repo.read(file);
      if (text === undefined) continue;
      const code = withoutJsComments(text);
      const at = code.search(/\bpoolOptions\b/);
      if (at !== -1) findings.push({ file, line: lineAt(code, at), detail: 'sets poolOptions, which Vitest 4 ignores' });
    }
    const turboText = repo.read('turbo.json');
    if (turboText === undefined || turboPassesWorkers(parseJsonc(turboText))) return findings;
    // A turbo.json change can strip the variable from every caller, so it judges them all.
    const callers = repo.files.includes('turbo.json') ? repo.grep(['VITEST_MAX_WORKERS'], ['.']).map((hit) => hit.file) : repo.files;
    for (const file of [...new Set(callers)]) {
      const text = repo.read(file);
      if (text === undefined || !text.includes('VITEST_MAX_WORKERS')) continue;
      for (const line of workersIntoTurbo(file, text)) {
        findings.push({ file, line, detail: "hands VITEST_MAX_WORKERS to a turbo run, and turbo.json's globalPassThroughEnv does not list it, so turbo strips it" });
      }
    }
    return findings;
  },
};

/** The root ESLint flat config's names. */
const ESLINT_ROOT = /^eslint\.config\.(js|mjs|cjs|ts|mts|cts)$/;

export const eslintIgnoresWorktrees: Rule = {
  id: 'eslint-ignores-worktrees',
  lesson:
    "ESLint run from the repository root walks the nested git worktrees under `.claude/worktrees/` (whole checkouts, each with its own node_modules) and can run out of memory. Ignore the folder in the root flat config: `{ ignores: ['.claude/worktrees/**'] }`.",
  run: (repo) => {
    const findings: Finding[] = [];
    for (const file of repo.files.filter((p) => ESLINT_ROOT.test(p))) {
      const text = repo.read(file);
      if (text === undefined || withoutJsComments(text).includes('.claude/worktrees')) continue;
      // A config that reads .gitignore into its ignores holds the folder when .gitignore does.
      const gitignore = repo.read('.gitignore') ?? '';
      if (/includeIgnoreFile|gitignore/.test(text) && /^\/?\.claude\/(worktrees\/?)?(\*\*)?\s*$/m.test(gitignore)) continue;
      findings.push({ file, detail: "the root ESLint config does not ignore '.claude/worktrees/**'" });
    }
    return findings;
  },
};

/** A call that parses one YAML document: js-yaml's `load`, yaml's `parse`/`parseDocument`, PyYAML's `safe_load`. */
const SINGLE_DOC_CALL = /\b(?:(?:js)?yaml|YAML|jsYaml|jsyaml)\s*\.\s*(?:load|parse|parseDocument|safeLoad|safe_load|full_load)\s*\(|(?<![.\w$])(?:load|safeLoad|parseDocument|safe_load)\s*\(/g;

/** The text from `open` (an index just past a `(`) to its matching `)`, at most `limit` characters. */
export const callArguments = (text: string, open: number, limit = 600): string => {
  let depth = 1;
  for (let i = open; i < text.length && i < open + limit; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i);
    }
  }
  return text.slice(open, open + limit);
};

/** Names bound, directly or through one another, to text that mentions the lockfile. */
export const lockfileNames = (text: string): Set<string> => {
  const names = new Set<string>();
  const assignments = [...text.matchAll(/(?:\b(?:const|let|var)\s+|^\s*)([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?!=)([^\n;]*)/gm)];
  for (let round = 0; round < 4; round += 1) {
    const before = names.size;
    for (const [, name, value] of assignments) {
      if (name === undefined || value === undefined) continue;
      if (value.includes('pnpm-lock.yaml') || [...names].some((n) => new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(value))) names.add(name);
    }
    if (names.size === before) break;
  }
  return names;
};

export const lockfileSingleDocParse: Rule = {
  id: 'lockfile-single-doc-parse',
  lesson:
    'pnpm 12 writes `pnpm-lock.yaml` as two YAML documents (the package-manager record first, the project lockfile last), so a single-document parse throws or reads the wrong one. Parse every document (`loadAll`, `parseAllDocuments`, `safe_load_all`) and read the last non-empty one.',
  run: (repo) => {
    const findings: Finding[] = [];
    for (const file of repo.files.filter((p) => CODE.test(p) || p.endsWith('.py'))) {
      const text = repo.read(file);
      if (text === undefined || !text.includes('pnpm-lock.yaml')) continue;
      const code = file.endsWith('.py') ? text.replace(/(^|\s)#.*$/gm, '$1') : withoutJsComments(text);
      const names = lockfileNames(code);
      for (const match of code.matchAll(SINGLE_DOC_CALL)) {
        const args = callArguments(code, match.index + match[0].length);
        const reads = args.includes('pnpm-lock.yaml') || [...names].some((n) => new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(args));
        if (reads) findings.push({ file, line: lineAt(code, match.index), detail: `\`${match[0].replace(/\s+/g, '')}…)\` parses one document of pnpm-lock.yaml` });
      }
    }
    return findings;
  },
};

/** Lefthook's config files. */
const LEFTHOOK = /^(\.?lefthook(-local)?)\.ya?ml$/;

/** Tracked paths a hook script names: sourced files and scripts it runs, read from the root or the hook's folder. */
export const namedScripts = (text: string, from: string, tracked: ReadonlySet<string>): string[] => {
  const out = new Set<string>();
  const dir = dirname(from);
  const resolved = text.replace(/"?\$\(\s*dirname\s+(?:--\s+)?"?\$\{?0\}?"?\s*\)"?\/|"?\$\{0%\/\*\}"?\//g, `${dir === '.' ? '' : `${dir}/`}`);
  for (const [word] of resolved.matchAll(/[\w./-]+\.(?:sh|bash|ts|mts|js|mjs|cjs|py)\b|\.?[\w-]+\/[\w./-]+/g)) {
    for (const candidate of [word, join(dir, word)]) {
      const path = normalize(candidate).replace(/^\.\//, '');
      if (tracked.has(path)) out.add(path);
    }
  }
  return [...out];
};

/** The `run` lines of lefthook's `pre-merge-commit` hook. */
const lefthookRuns = (doc: unknown): string[] => {
  const hook = isRecord(doc) ? doc['pre-merge-commit'] : undefined;
  if (!isRecord(hook)) return [];
  const runs: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'run' && typeof child === 'string') runs.push(child);
      else visit(child);
    }
  };
  visit(hook);
  return runs;
};

/** `MERGE_HEAD` outside a shell comment. */
const READS_MERGE_HEAD = /^[^#]*\bMERGE_HEAD\b/;

export const preMergeCommitMergeHead: Rule = {
  id: 'pre-merge-commit-merge-head',
  lesson:
    'During a clean `git merge` the `pre-merge-commit` hook runs before MERGE_HEAD exists (only a stopped merge writes it), so a check that reads it never runs. The merged heads are in `GITHEAD_<sha>` variables and `GIT_REFLOG_ACTION`; trust a candidate only when `git merge-tree --write-tree HEAD <sha>` equals `git write-tree`, and test the hook through a real `.git/hooks/pre-merge-commit` in a fixture.',
  run: (repo) => {
    const tracked = repo.tracked();
    const all = new Set(tracked);
    const hooks = tracked.filter((p) => basename(p) === 'pre-merge-commit');
    const reach = new Set<string>(hooks);
    for (const config of tracked.filter((p) => LEFTHOOK.test(p))) {
      const text = repo.read(config);
      if (text === undefined) continue;
      for (const run of lefthookRuns(yamlOf(text))) for (const path of namedScripts(run, config, all)) reach.add(path);
    }
    for (const hook of [...reach]) {
      const text = repo.read(hook);
      if (text !== undefined) for (const path of namedScripts(text, hook, all)) reach.add(path);
    }
    const lefthookSelected = repo.files.some((p) => LEFTHOOK.test(p));
    if (!lefthookSelected && !repo.files.some((p) => reach.has(p))) return [];
    const findings: Finding[] = [];
    for (const file of [...reach].sort()) {
      const text = repo.read(file);
      if (text === undefined) continue;
      const line = lineOf(text, READS_MERGE_HEAD);
      if (line !== undefined) findings.push({ file, line, detail: 'the pre-merge-commit hook reaches this file, and it reads MERGE_HEAD' });
    }
    return findings;
  },
};

/** Claude Code settings and plugin hook files. */
const isHookSettings = (path: string): boolean => /(^|\/)\.claude\/settings(\.local)?\.json$/.test(path) || /(^|\/)hooks\/hooks\.json$/.test(path);

/** An MCP tool name with a connector's generated id: `mcp__<uuid>__<tool>`. */
const SERVER_ID = /mcp__[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__/i;

/** Each hook `matcher` string in a settings document. */
export const matchersOf = (doc: unknown): string[] => {
  const hooks = isRecord(doc) ? doc['hooks'] : undefined;
  if (!isRecord(hooks)) return [];
  return Object.values(hooks).flatMap((groups) => (Array.isArray(groups) ? groups.flatMap((g) => (isRecord(g) && typeof g['matcher'] === 'string' ? [g['matcher']] : [])) : []));
};

export const mcpMatcherServerId: Rule = {
  id: 'mcp-matcher-server-id',
  lesson:
    'A hook matcher naming `mcp__<server-id>__<tool>` goes stale when the connector is reconnected under a new id, and the hook silently stops firing. Match a suffix regex instead, such as `^mcp__.*__(save_issue|save_comment)$`.',
  run: (repo) => {
    const findings: Finding[] = [];
    for (const file of repo.files.filter(isHookSettings)) {
      const text = repo.read(file);
      if (text === undefined) continue;
      for (const matcher of matchersOf(parseJsonc(text))) {
        const id = SERVER_ID.exec(matcher)?.[0];
        if (id === undefined) continue;
        const line = lineOf(text, id);
        findings.push({ file, ...(line === undefined ? {} : { line }), detail: `matcher "${matcher}" names a connector id (${id.slice(0, -2)})` });
      }
    }
    return findings;
  },
};

/** Code that can gate on a pull request's checks: sources, scripts, workflows, queries. */
const isGateCode = (path: string): boolean => CODE.test(path) || /\.(py|sh|bash|graphql|gql)$/.test(path) || isWorkflow(path) || isAction(path) || /^\.(husky|githooks)\//.test(path);

/** `statusCheckRollup.state` (gh, JS, jq) or `statusCheckRollup { state` (GraphQL). */
const ROLLUP_STATE = /statusCheckRollup\??\s*\.\s*state\b|statusCheckRollup\s*\{\s*state\b/g;

export const rollupStateGate: Rule = {
  id: 'rollup-state-gate',
  lesson:
    "`statusCheckRollup.state` folds in every check, required or not, so one failing helper check makes everything that waits for rollup SUCCESS skip the pull request. Read the rollup's contexts and filter them by name, judging only the checks that gate.",
  run: (repo) => {
    const findings: Finding[] = [];
    for (const file of repo.files.filter(isGateCode)) {
      const text = repo.read(file);
      if (text === undefined || !text.includes('statusCheckRollup')) continue;
      for (const match of text.matchAll(ROLLUP_STATE)) {
        const line = lineAt(text, match.index);
        const source = text.split('\n')[line - 1] ?? '';
        if (/^\s*(\/\/|\/\*|#|\*)/.test(source)) continue;
        findings.push({ file, line, detail: 'gates on statusCheckRollup.state' });
      }
    }
    return findings;
  },
};

/** Test files by the common names: `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, `*_test.go`. */
export const TEST_PATHSPECS = [':(glob)**/*.test.*', ':(glob)**/*.spec.*', ':(glob)**/test_*.py', ':(glob)**/*_test.py', ':(glob)**/*_test.go'] as const;

export const deletedPathStillPinned: Rule = {
  id: 'deleted-path-still-pinned',
  lesson:
    "A test elsewhere can pin a file's path, asserting it still exists, so deleting or renaming the file passes the checks run on the change and fails only at the next full test run. Before deleting a file, `git grep -ln` its repository-relative path; update a live pin to the new path, or to a sibling the same glob reaches.",
  run: (repo) => {
    const removed = repo.removed();
    if (removed.length === 0) return [];
    const quoted = removed.flatMap((p) => [`'${p}'`, `"${p}"`, `\`${p}\``]);
    const gone = new Set(removed);
    return repo
      .grep(quoted, [...TEST_PATHSPECS])
      .filter((hit) => !gone.has(hit.file))
      .map((hit) => {
        const path = removed.find((p) => hit.text.includes(p)) as string;
        return { file: hit.file, line: hit.line, detail: `quotes ${path}, which this change deletes or renames` };
      });
  },
};

export const CONFIG_RULES: readonly Rule[] = [vitest4InertPoolConfig, eslintIgnoresWorktrees, lockfileSingleDocParse, preMergeCommitMergeHead, mcpMatcherServerId, rollupStateGate, deletedPathStillPinned];
