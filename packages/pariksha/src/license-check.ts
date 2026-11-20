// license-check: every installed package's licence equals a name on the
// repository's allow list, or the package is allowed by name, with a reason.
//
// WHY EXACT. A checker that accepts a licence when an allowed name is a
// substring of it passes `FSL-1.1-MIT` on "MIT" and `MIT-0` on "MIT". Here a
// licence passes only when it equals an allowed name. An SPDX expression
// passes when one `OR` branch passes, and a branch passes when every `AND`
// term does.
//
// THE INVENTORY is `pnpm licenses list --json --recursive`: every workspace's
// installed dependencies, dev included, read from the store pnpm already has.
// pnpm reads the `license` field only, and reports `Unknown` for a package
// that declares none; such a package is refused unless the allow list names
// `Unknown` or the package is allowed by name.
//
// The allow list and the by-name exceptions are the repository's, never
// pariksha's: with no settings the check refuses to run.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LicenseConfig {
  /** Licence names a package's licence must equal. */
  readonly allow: readonly string[];
  /** Packages allowed whatever their licence, each with its reason: `name` for every version, `name@version` for that one. */
  readonly packages: Readonly<Record<string, string>>;
}

export interface Violation {
  readonly pkg: string;
  readonly license: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{ "allow": ["MIT", …], "packages"?: { "name" | "name@version": "<reason>" } }`; anything else throws. */
export const parseLicenseConfig = (text: string): LicenseConfig => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  const unknown = Object.keys(raw).find((k) => k !== 'allow' && k !== 'packages');
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"; license-check reads allow, packages`);
  const allow = raw['allow'];
  // An empty list would refuse every package; a missing one is a config that names no policy.
  // A name with surrounding spaces would never equal a reported licence, which is trimmed.
  if (!Array.isArray(allow) || allow.length === 0 || allow.some((name) => typeof name !== 'string' || name.trim() === '' || name !== name.trim())) {
    throw new Error('"allow" must be a non-empty list of licence names, none blank or with surrounding spaces');
  }
  const packages = 'packages' in raw ? raw['packages'] : {};
  if (!isRecord(packages)) throw new Error('"packages" must be an object of package names to reasons');
  const unreasoned = Object.entries(packages).find(([name, reason]) => name === '' || typeof reason !== 'string' || reason.trim() === '');
  if (unreasoned !== undefined) throw new Error(`"packages": "${unreasoned[0]}" must be a package name with a reason, a non-empty string`);
  return { allow: allow as string[], packages: packages as Record<string, string> };
};

/** `name@1.2.3` or `@scope/name@1.2.3` → its name. */
export const packageName = (id: string): string => {
  const at = id.lastIndexOf('@');
  return at > 0 ? id.slice(0, at) : id;
};

/**
 * Whether an SPDX expression is allowed: AND binds tighter than OR, an OR
 * passes when either side does, an AND when both do, and a licence name when
 * it equals an allowed one. A name may hold spaces ("Apache 2.0"). A
 * malformed expression is refused.
 */
export const isAllowed = (expression: string, allowed: readonly string[]): boolean => {
  if (allowed.includes(expression.trim())) return true;
  const tokens = expression.split(/(\(|\)|\s+)/).filter((token) => token.trim() !== '');
  let at = 0;
  const isKeyword = (token: string | undefined): boolean => token === 'AND' || token === 'OR' || token === '(' || token === ')';
  // Each step returns null for a malformed expression.
  const atom = (): boolean | null => {
    if (tokens[at] === '(') {
      at += 1;
      const inner = or();
      if (inner === null || tokens[at] !== ')') return null;
      at += 1;
      return inner;
    }
    const words: string[] = [];
    while (at < tokens.length && !isKeyword(tokens[at])) {
      words.push(tokens[at] as string);
      at += 1;
    }
    return words.length === 0 ? null : allowed.includes(words.join(' '));
  };
  const and = (): boolean | null => {
    let value = atom();
    while (value !== null && tokens[at] === 'AND') {
      at += 1;
      const next = atom();
      value = next === null ? null : value && next;
    }
    return value;
  };
  const or = (): boolean | null => {
    let value = and();
    while (value !== null && tokens[at] === 'OR') {
      at += 1;
      const next = and();
      value = next === null ? null : value || next;
    }
    return value;
  };
  return or() === true && at === tokens.length;
};

/** The packages whose licence is not allowed, from a `name@version` report. */
export const violations = (report: Readonly<Record<string, { licenses?: string | string[] }>>, config: LicenseConfig): Violation[] =>
  Object.entries(report).flatMap(([pkg, info]) => {
    if (Object.hasOwn(config.packages, pkg) || Object.hasOwn(config.packages, packageName(pkg))) return [];
    const raw = info.licenses ?? 'UNKNOWN';
    const licenses = Array.isArray(raw) ? raw : [raw];
    // A package listing several licences offers each; one allowed is enough.
    return licenses.some((license) => isAllowed(license, config.allow)) ? [] : [{ pkg, license: licenses.join(', ') }];
  });

/**
 * `pnpm licenses list --json` groups packages by licence
 * (`{ "MIT": [{ name, versions }] }`); this keys them by `name@version`, the
 * shape `violations` judges. Anything else is unreadable: null.
 */
export const fromPnpm = (output: unknown): Record<string, { licenses: string }> | null => {
  if (!isRecord(output)) return null;
  const report: Record<string, { licenses: string }> = {};
  for (const [license, entries] of Object.entries(output)) {
    if (!Array.isArray(entries)) return null;
    for (const entry of entries as unknown[]) {
      const { name, versions } = (entry ?? {}) as { name?: unknown; versions?: unknown };
      // A blank name or version is not a package pnpm installed: an inventory of them would pass unjudged.
      if (typeof name !== 'string' || name.trim() === '' || !Array.isArray(versions) || versions.length === 0 || !versions.every((version) => typeof version === 'string' && version.trim() !== '')) return null;
      for (const version of versions as string[]) {
        const key = `${name}@${version}`;
        // Listed under two licences, a package must pass both: neither
        // group's answer may replace the other's.
        const earlier = report[key]?.licenses;
        report[key] = { licenses: earlier === undefined || earlier === license ? license : `(${earlier}) AND (${license})` };
      }
    }
  }
  return report;
};

/**
 * A report's verdict: the lines to print and the exit status. A report that
 * is not an object keyed by package, or that holds none, judged nothing: 2.
 */
export const judge = (report: unknown, config: LicenseConfig): { lines: string[]; status: number } => {
  // An empty array included: it would pass with no packages judged.
  if (!isRecord(report)) return { lines: ['license-check: unreadable pnpm licenses output'], status: 2 };
  const total = Object.keys(report).length;
  // A tree always has dependencies: an empty inventory judged nothing.
  if (total === 0) return { lines: ['license-check: pnpm licenses listed no packages to judge'], status: 2 };
  const found = violations(report as Record<string, { licenses?: string | string[] }>, config);
  if (found.length === 0) return { lines: [`license-check: ${total.toString()} packages, every licence allowed exactly`], status: 0 };
  return {
    lines: [`license-check: ${found.length.toString()} of ${total.toString()} packages have a licence not on the allow list:`, ...found.map((v) => `  ${v.pkg}  ${v.license}`)],
    status: 1,
  };
};

export type Exec = (file: string, args: readonly string[], options: { cwd: string; encoding: 'utf8'; maxBuffer: number }) => string;

export const execFile: Exec = (file, args, options) => execFileSync(file, args, options);

/** Gets `pnpm licenses list --json` text for the repository at a root. */
export type LicensesRunner = (root: string) => string;

/** pnpm's --json licence list of every workspace's installed dependencies, run at `root`. */
export const pnpmLicenses =
  (exec: Exec = execFile): LicensesRunner =>
  (root) =>
    exec('pnpm', ['licenses', 'list', '--json', '--recursive'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export interface Options {
  readonly config: LicenseConfig;
  readonly root: string;
  /** A saved `pnpm licenses list --json` report, read instead of running pnpm. */
  readonly report?: string;
}

/** The inventory's text, parsed: the saved report when one is named, else pnpm's. Throws, naming the source, when it cannot be read. */
export const readInventory = (options: Options, runner: LicensesRunner): unknown => {
  const source = options.report === undefined ? 'pnpm licenses list' : options.report;
  try {
    return JSON.parse(options.report === undefined ? runner(options.root) : readFileSync(resolve(options.report), 'utf8')) as unknown;
  } catch (e) {
    throw new Error(`cannot read ${source}: ${(e as Error).message}`, { cause: e });
  }
};

/**
 * The report's verdict on stdout, as the script it was ported from printed
 * it; 2, on `err`, when it lists no package or is not pnpm's shape. An
 * inventory that cannot be read throws (readInventory): the CLI turns that
 * into exit 2, never a pass.
 */
export const runLicenseCheck = (options: Options, runner: LicensesRunner, io: { readonly out: (line: string) => void; readonly err: (line: string) => void }): number => {
  const parsed = readInventory(options, runner);
  const { lines, status } = judge(fromPnpm(parsed), options.config);
  // A verdict on stdout; a report that judged nothing is an input error, on stderr.
  lines.forEach(status === 2 ? io.err : io.out);
  return status;
};
