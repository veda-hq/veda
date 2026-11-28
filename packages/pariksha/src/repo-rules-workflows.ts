// repo-rules over GitHub Actions workflows and compose files.
import { CORE_SCHEMA, load } from 'js-yaml';
import { lineOf, stringList, type Finding, type Repo, type Rule } from './repo-rules.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A workflow file: `.github/workflows/*.yml` or `.yaml`. */
export const isWorkflow = (path: string): boolean => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);

/** An action's metadata file, whose `runs` steps hold expressions too. */
export const isAction = (path: string): boolean => /(^|\/)action\.ya?ml$/.test(path);

/** A compose file, by Docker's own names and the common variants. */
export const isCompose = (path: string): boolean => /(^|\/)(docker-)?compose(\.[\w-]+)*\.ya?ml$/.test(path);

/** `text` as YAML in a box, `{ doc }`, or null when it does not parse; a document of `null` is `{ doc: null }`. */
export const yamlBox = (text: string): { doc: unknown } | null => {
  try {
    return { doc: load(text, { schema: CORE_SCHEMA }) };
  } catch {
    // fail-open: a file that is not YAML is actionlint's or compose's to refuse; these rules read only what parses.
    return null;
  }
};

/** `text` as YAML; undefined when it does not parse (a syntax check is another tool's). */
export const yamlOf = (text: string): unknown => yamlBox(text)?.doc;

/**
 * The selected files `pick` keeps, each with its text and parsed YAML. A
 * selected file that is gone reads as the text `undefined`, whose YAML is that
 * one word: no trigger, job or service, so no rule finds anything in it.
 */
const parsed = (repo: Repo, pick: (path: string) => boolean): Array<{ file: string; text: string; doc: unknown }> =>
  repo.files.filter(pick).map((file) => {
    const text = String(repo.read(file));
    return { file, text, doc: yamlOf(text) };
  });

/** The `on:` triggers of a workflow, as an event name to its settings (null when it has none). */
export const triggersOf = (doc: unknown): Map<string, unknown> => {
  const on = isRecord(doc) ? doc['on'] : undefined;
  const out = new Map<string, unknown>();
  if (typeof on === 'string') {
    out.set(on, null);
  } else if (Array.isArray(on)) {
    for (const name of on) if (typeof name === 'string') out.set(name, null);
  } else if (isRecord(on)) {
    for (const [name, value] of Object.entries(on)) out.set(name, value);
  }
  return out;
};

/** The jobs of a workflow, by id. */
export const jobsOf = (doc: unknown): Array<[string, Record<string, unknown>]> => {
  const jobs = isRecord(doc) ? doc['jobs'] : undefined;
  return isRecord(jobs) ? Object.entries(jobs).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])) : [];
};

/** The line of `id:` under `jobs:`, for a job's finding. */
const jobLine = (text: string, id: string): number | undefined => lineOf(text, new RegExp(`^\\s+["']?${id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}["']?\\s*:`), lineOf(text, /^jobs\s*:/) ?? 1);

export const actionsPathLeadingSlash: Rule = {
  id: 'actions-path-leading-slash',
  lesson:
    '`paths` and `paths-ignore` match each pattern against the path from the repository root, as written, and are not gitignore: a leading `/` matches nothing, so the workflow silently never runs for those files. A bare name is already root-only; write `docs/**`, not `/docs/**` (the filter cheat sheet in GitHub\'s workflow-syntax docs).',
  run: (repo) => {
    const findings: Finding[] = [];
    for (const { file, text, doc } of parsed(repo, isWorkflow)) {
      for (const [event, settings] of triggersOf(doc)) {
        if (!isRecord(settings)) continue;
        for (const key of ['paths', 'paths-ignore']) {
          const patterns = settings[key];
          if (!Array.isArray(patterns)) continue;
          for (const pattern of patterns) {
            if (typeof pattern !== 'string' || !/^!?\//.test(pattern)) continue;
            const line = lineOf(text, pattern);
            findings.push({ file, ...(line === undefined ? {} : { line }), detail: `on.${event}.${key} pattern "${pattern}" starts with "/"` });
          }
        }
      }
    }
    return findings;
  },
};

/** `&& <falsy literal> ||`: GitHub's `a && b || c` gives `c` whenever `b` is falsy. */
const FALSY_TERNARY = /&&\s*(0|''|""|false|null|-0|0\.0)\s*\|\|/;

export const falsyTernaryExpression: Rule = {
  id: 'falsy-ternary-expression',
  lesson:
    "A workflow expression `a && b || c` yields `b` only when `b` is itself truthy, so `cond && 0 || 1` always gives `1` and the fix silently does nothing; actionlint passes it. Quote the falsy value (`cond && '0' || '1'`) with a comment saying why.",
  run: (repo) => {
    const findings: Finding[] = [];
    for (const file of repo.files.filter((p) => isWorkflow(p) || isAction(p))) {
      const text = repo.read(file);
      if (text === undefined) continue;
      text.split('\n').forEach((line, i) => {
        // The text before a comment that runs to the end of the line.
        const code = line.split(/(?:^|\s)#.*$/)[0] as string;
        const match = FALSY_TERNARY.exec(code);
        if (match !== null) findings.push({ file, line: i + 1, detail: `\`&& ${match[1]} ||\` always takes the right-hand side` });
      });
    }
    return findings;
  },
};

export const jobLevelIfNotStep: Rule = {
  id: 'job-level-if-not-step',
  lesson:
    'GitHub bills each job rounded up to a whole minute, plus about 90 s of setup. A job whose every step has an `if:` still starts, sets up and bills when all of them skip. Put the condition on the job (`jobs.<id>.if`), build the matrix upstream, or drop the job.',
  run: (repo) => {
    const findings: Finding[] = [];
    for (const { file, text, doc } of parsed(repo, isWorkflow)) {
      for (const [id, job] of jobsOf(doc)) {
        const steps = job['steps'];
        if (job['if'] !== undefined || !Array.isArray(steps) || steps.length === 0) continue;
        if (!steps.every((step) => isRecord(step) && step['if'] !== undefined)) continue;
        const line = jobLine(text, id);
        findings.push({ file, ...(line === undefined ? {} : { line }), detail: `job "${id}" has no if:, and each of its ${steps.length} step(s) has one` });
      }
    }
    return findings;
  },
};

/** The triggers whose runs a merge queue waits on, by default: GitHub's queue and Mergify's draft pull requests. */
export const QUEUE_TRIGGERS = ['merge_group', 'pull_request', 'pull_request_target'] as const;

export const jobTimeoutMinutes: Rule = {
  id: 'job-timeout-minutes',
  lesson:
    'A job with no `timeout-minutes` can run for GitHub\'s default 360 minutes. In a merge queue a hung one ends as "Checks timed out": Mergify dequeues the pull request, re-adding the queue label does not requeue the same head, and only an `@mergifyio requeue` comment does. Give every job a merge queue waits on a `timeout-minutes`.',
  settings: { triggers: stringList },
  run: (repo, settings) => {
    const triggers = (settings['triggers'] as readonly string[] | undefined) ?? QUEUE_TRIGGERS;
    const findings: Finding[] = [];
    for (const { file, text, doc } of parsed(repo, isWorkflow)) {
      const on = [...triggersOf(doc).keys()];
      const queued = on.filter((t) => triggers.includes(t));
      if (queued.length === 0) continue;
      for (const [id, job] of jobsOf(doc)) {
        // A job that calls a reusable workflow cannot take timeout-minutes; the called jobs carry their own.
        if (job['uses'] !== undefined || job['timeout-minutes'] !== undefined) continue;
        const line = jobLine(text, id);
        findings.push({ file, ...(line === undefined ? {} : { line }), detail: `job "${id}" has no timeout-minutes (the workflow runs on ${queued.join(', ')})` });
      }
    }
    return findings;
  },
};

/**
 * Whether a `pg_isready` command line probes over TCP: a `-h`/`--host` naming
 * a host, after a space. The text read starts at `pg_isready` (or, with none,
 * is the last character), so the option never opens it.
 */
export const probesOverTcp = (command: string): boolean => /\s(-h\s*\S|--host(=|\s+)\S)/.test(command.slice(command.indexOf('pg_isready')));

export const pgIsreadyOverSocket: Rule = {
  id: 'pg-isready-over-socket',
  lesson:
    "A Postgres healthcheck of `pg_isready` over the Unix socket passes against the image entrypoint's first-boot temporary server (`listen_addresses` empty), so `compose up --wait` or a job's service returns mid-init and the next `psql` sees \"the database system is starting up\". Probe over TCP, `pg_isready -h 127.0.0.1`, so healthy means the real server accepts connections.",
  run: (repo) => {
    const findings: Finding[] = [];
    const judge = (file: string, text: string, command: string): void => {
      if (!command.includes('pg_isready') || probesOverTcp(command)) return;
      const line = lineOf(text, 'pg_isready');
      findings.push({ file, ...(line === undefined ? {} : { line }), detail: `healthcheck \`${command.trim()}\` probes over the socket` });
    };
    for (const { file, text, doc } of parsed(repo, isWorkflow)) {
      for (const [, job] of jobsOf(doc)) {
        const services = job['services'];
        if (!isRecord(services)) continue;
        for (const service of Object.values(services)) {
          const options = isRecord(service) ? service['options'] : undefined;
          if (typeof options !== 'string') continue;
          const cmd = /--health-cmd(?:=|\s+)("[^"]*"|'[^']*'|\S+)/.exec(options)?.[1];
          if (cmd !== undefined) judge(file, text, cmd.replace(/^["']|["']$/g, ''));
        }
      }
    }
    for (const { file, text, doc } of parsed(repo, isCompose)) {
      const services = isRecord(doc) ? doc['services'] : undefined;
      if (!isRecord(services)) continue;
      for (const service of Object.values(services)) {
        const health = isRecord(service) ? service['healthcheck'] : undefined;
        const test = isRecord(health) ? health['test'] : undefined;
        const command = Array.isArray(test) ? test.filter((w) => w !== 'CMD' && w !== 'CMD-SHELL').join(' ') : typeof test === 'string' ? test : undefined;
        if (command !== undefined) judge(file, text, command);
      }
    }
    return findings;
  },
};

export const WORKFLOW_RULES: readonly Rule[] = [actionsPathLeadingSlash, falsyTernaryExpression, jobLevelIfNotStep, jobTimeoutMinutes, pgIsreadyOverSocket];
