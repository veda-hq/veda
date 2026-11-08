/**
 * The rule registry: every checkable rule a consumer's agents learned the
 * hard way, the agent-memory notes it came from, where it came from, and what
 * enforces it now. The consumer owns the file; kavach validates it, words
 * refusals from it, and answers the count of rules still unenforced.
 *
 * A registry is JSON:
 *
 * ```json
 * {
 *   "owner": "the release manager",
 *   "rules": [
 *     {
 *       "id": "H-01",
 *       "title": "Resolve review threads only after fixes are pushed",
 *       "notes": ["never-sync-threads-before-pushing-fixes"],
 *       "origin": "work 12",
 *       "enforcer": { "pr": 34, "files": ["rules/threads-after-push.ts"] }
 *     }
 *   ]
 * }
 * ```
 *
 * `owner` (optional) is who a refusal without a pass tells the agent to ask;
 * absent, "the repository owner". `origin` (optional) is printed after the
 * rule's title. `enforcer` is `null` for a rule nothing checks yet. Other keys
 * are left alone, so a consumer may keep its own bookkeeping beside these.
 *
 * A rule counts as enforced only when its enforcer names files that exist in
 * the checkout, so a renamed or deleted enforcer reads as unenforced instead
 * of being trusted from the record.
 *
 * CLI: `cli.js count --registry <json> [--root <dir>] [--json]` prints the
 * count and the unenforced rules; `--json` prints the same as JSON.
 */
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { onlyKnown, option } from './args.ts';

export type Enforcer = {
  readonly pr: number;
  readonly files: readonly string[];
};

export type Rule = {
  readonly id: string;
  readonly title: string;
  readonly notes: readonly string[];
  /** Where the rule came from, printed after its title; absent: nothing printed. */
  readonly origin?: string;
  readonly enforcer: Enforcer | null;
};

export type Registry = {
  /** Who a refusal without a pass says to ask; absent: {@link DEFAULT_OWNER}. */
  readonly owner?: string;
  readonly rules: readonly Rule[];
};

/** Who a refusal says to ask when the registry names no one. */
export const DEFAULT_OWNER = 'the repository owner';

/** The environment variable the CLIs read the registry path from. */
export const REGISTRY_ENV = 'KAVACH_RULE_REGISTRY';

const RULE_ID = /^[A-Z]-\d{2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s]+$/;

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string, shape?: RegExp): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where}: expected a non-empty string`);
  }
  if (shape !== undefined && !shape.test(value)) {
    throw new Error(`${where}: ${JSON.stringify(value)} does not match ${shape}`);
  }
  return value;
}

function texts(value: unknown, where: string, shape: RegExp): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${where}: expected a non-empty list`);
  }
  return value.map((item: unknown, i) => text(item, `${where}[${i}]`, shape));
}

function enforcer(value: unknown, where: string): Enforcer | null {
  if (value === null) return null;
  const raw = record(value, where);
  const pr = raw['pr'];
  if (typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error(`${where}.pr: expected a positive integer`);
  }
  return { pr, files: texts(raw['files'], `${where}.files`, REPO_PATH) };
}

/** Validate a parsed registry file; throws naming the first bad field. */
export function parseRegistry(value: unknown): Registry {
  const raw = record(value, 'registry');
  const owner = raw['owner'] === undefined ? undefined : text(raw['owner'], 'registry.owner');
  if (!Array.isArray(raw['rules'])) {
    throw new Error('registry.rules: expected a list');
  }
  const seen = new Set<string>();
  const rules = raw['rules'].map((item: unknown, i): Rule => {
    const where = `registry.rules[${i}]`;
    const row = record(item, where);
    const id = text(row['id'], `${where}.id`, RULE_ID);
    if (seen.has(id)) throw new Error(`${where}.id: ${id} is listed twice`);
    seen.add(id);
    const origin = row['origin'] === undefined ? undefined : text(row['origin'], `${where}.origin`);
    return {
      id,
      title: text(row['title'], `${where}.title`),
      notes: texts(row['notes'], `${where}.notes`, SLUG),
      ...(origin === undefined ? {} : { origin }),
      enforcer: enforcer(row['enforcer'], `${where}.enforcer`),
    };
  });
  return { ...(owner === undefined ? {} : { owner }), rules };
}

export function loadRegistry(path: string): Registry {
  return parseRegistry(JSON.parse(readFileSync(path).toString()));
}

/** Is the rule enforced in the checkout at `root`: an enforcer whose paths are all files. */
export function isEnforced(rule: Rule, root: string): boolean {
  return (
    rule.enforcer !== null &&
    rule.enforcer.files.every((file) => statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true)
  );
}

export type Count = {
  readonly total: number;
  readonly unenforced: readonly Rule[];
};

export function count(registry: Registry, root: string): Count {
  return {
    total: registry.rules.length,
    unenforced: registry.rules.filter((rule) => !isEnforced(rule, root)),
  };
}

export function renderCount(result: Count): string {
  const lines = [`${result.unenforced.length} of ${result.total} checkable memory rules unenforced`];
  for (const rule of result.unenforced) {
    lines.push(`  ${rule.id}  ${rule.title}${rule.origin === undefined ? '' : `  (${rule.origin})`}`);
  }
  return lines.join('\n');
}

export type Io = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

/** Lines to standard output and standard error, for the CLIs. */
export const STDIO: Io = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

const USAGE = 'usage: count --registry <json> [--root <dir>] [--json]';

/**
 * `count`: the registry from `--registry` (else `KAVACH_RULE_REGISTRY`), the
 * checkout from `--root` (else `cwd`), both relative to `cwd`. Exit 2 on a
 * usage error or a registry that does not load.
 */
export function main(
  argv: readonly string[],
  io: Io,
  cwd: string = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  let result: Count;
  try {
    onlyKnown(argv, ['--registry', '--root'], ['--json']);
    const path = option(argv, '--registry') ?? env[REGISTRY_ENV];
    if (path === undefined || path === '') throw new Error(`no registry: pass --registry or set ${REGISTRY_ENV}`);
    result = count(loadRegistry(resolve(cwd, path)), resolve(cwd, option(argv, '--root') ?? '.'));
  } catch (error) {
    io.err(`count: ${error instanceof Error ? error.message : String(error)}`);
    io.err(USAGE);
    return 2;
  }
  if (argv.includes('--json')) {
    io.out(
      JSON.stringify({
        total: result.total,
        unenforced: result.unenforced.map((rule) => rule.id),
      }),
    );
  } else {
    io.out(renderCount(result));
  }
  return 0;
}
