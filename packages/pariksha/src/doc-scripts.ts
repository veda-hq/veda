// DOC-DRIFT-02, documented scripts: a `pnpm <script>` a doc shows exists, in
// the scope the doc runs it from, and a verification step does not run a
// script that changes the tree it is meant to check (`lint` auto-fixes:
// `lint:ci` is the check). A step that names a missing script looks like a
// check and runs nothing.
import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Config } from './doc-references-config.ts';
import { codeSpans as markdownCodeSpans } from './doc-references.ts';
import { isRecord } from './registry-ratchet.ts';
import { maskQuoted, stripComment } from './shell-text.ts';

/** Manifest text by repo-relative path; undefined when absent. */
export type ManifestReader = (path: string) => string | undefined;

/**
 * Executables in `node_modules/.bin`. THROWS rather than returning a
 * wildcard: a missing install that let every name pass would print a pass
 * while scanning nothing.
 */
export const binNames = (root: string): string[] => {
  const dir = join(root, 'node_modules', '.bin');
  try {
    return readdirSync(dir);
  } catch {
    throw new Error(`cannot read ${dir}; install the dependencies before this check`);
  }
};

interface Manifest {
  /** Scope key and directory: '.' for the root, else the workspace dir. */
  readonly scope: string;
  readonly name: string | undefined;
  readonly scripts: Readonly<Record<string, string>>;
}

/**
 * Every manifest the config lists that exists. One that does not parse would
 * silently shrink the known-script set, so it fails loud instead.
 */
const readManifests = (manifests: readonly string[], read: ManifestReader): Manifest[] =>
  manifests.flatMap((path) => {
    const text = read(path);
    if (text === undefined) return [];
    let pkg: unknown;
    try {
      pkg = JSON.parse(text);
    } catch {
      throw new Error(`${path} is not valid JSON — cannot determine which scripts exist`);
    }
    const name = isRecord(pkg) && typeof pkg['name'] === 'string' ? pkg['name'] : undefined;
    const raw = isRecord(pkg) ? pkg['scripts'] : undefined;
    const scripts: Record<string, string> = {};
    if (isRecord(raw)) for (const [key, body] of Object.entries(raw)) scripts[key] = String(body);
    return [{ scope: posix.dirname(path), name, scripts }];
  });

/** A manifest's scope keys: its directory, and its package name if any. */
const scopeKeys = (manifest: Manifest): string[] => (manifest.name === undefined ? [manifest.scope] : [manifest.scope, manifest.name]);

/** Every name `pnpm <name>` can resolve to: a script in any listed manifest, or an executable in `node_modules/.bin`. */
export const definedScripts = (root: string, manifests: readonly string[], read: ManifestReader): Set<string> =>
  new Set([...binNames(root), ...readManifests(manifests, read).flatMap((manifest) => Object.keys(manifest.scripts))]);

/**
 * Scripts per scope, because `pnpm foo` does not resolve `foo` from a
 * workspace. Keyed by both the workspace directory and the package name, as
 * `--filter` takes either. Bins resolve in every scope: pnpm puts the same
 * hoisted `.bin` on PATH for a filtered command.
 */
export const scriptScopes = (root: string, manifests: readonly string[], read: ManifestReader): Map<string, Set<string>> => {
  const scopes = new Map<string, Set<string>>();
  const bins = binNames(root);
  for (const manifest of readManifests(manifests, read)) {
    const names = new Set([...Object.keys(manifest.scripts), ...bins]);
    for (const key of scopeKeys(manifest)) scopes.set(key, names);
  }
  return scopes;
};

/** What the manifests say each scope's scripts run. */
export interface ScriptBodies {
  /** Script command strings per scope ('.', workspace dir, package name). */
  readonly scripts: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Manifest directory per scope key ('.' for the root). */
  readonly scopeDirs: ReadonlyMap<string, string>;
}

export const scriptBodies = (manifests: readonly string[], read: ManifestReader): ScriptBodies => {
  const scripts = new Map<string, Map<string, string>>();
  const scopeDirs = new Map<string, string>();
  for (const manifest of readManifests(manifests, read)) {
    const bodies = new Map(Object.entries(manifest.scripts));
    for (const key of scopeKeys(manifest)) {
      scripts.set(key, bodies);
      scopeDirs.set(key, manifest.scope);
    }
  }
  return { scripts, scopeDirs };
};

/** Half-open [start, end) ranges of every inline code span on a line, between its delimiters. */
export const spanRanges = (line: string): Array<readonly [number, number]> => markdownCodeSpans(line).map((span) => [span.start, span.end] as const);

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

export type FenceRole = 'prose' | 'fence' | 'code';

/**
 * Each line's place relative to fenced code blocks, by CommonMark's rule: an
 * opening fence is three or more backticks or tildes indented at most three
 * spaces (a backtick fence's info string has no backtick); it closes at a
 * fence of the same character, at least as long, with nothing after it but
 * spaces; an unclosed fence runs to the end.
 */
export const fenceRoles = (lines: readonly string[]): FenceRole[] => {
  const roles: FenceRole[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (fence === null) {
      const open = FENCE_OPEN.exec(line);
      const marker = open?.[2] ?? '';
      if (open !== null && !(marker.startsWith('`') && String(open[3]).includes('`'))) {
        fence = { char: marker.charAt(0), length: marker.length };
        roles.push('fence');
      } else {
        roles.push('prose');
      }
      continue;
    }
    const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
    if (close !== undefined && close.charAt(0) === fence.char && close.length >= fence.length) {
      fence = null;
      roles.push('fence');
    } else {
      roles.push('code');
    }
  }
  return roles;
};

/** pnpm's own subcommands, which are not package scripts. */
const BUILTIN: ReadonlySet<string> = new Set([
  'install',
  'add',
  'remove',
  'exec',
  'dlx',
  'why',
  'audit',
  'list',
  'outdated',
  'update',
  'publish',
  'pack',
  'link',
  'patch',
  'store',
  'config',
  'approve-builds',
  'rebuild',
  'prune',
  'setup',
  'licenses',
  'deploy',
  'env',
  'init',
  'create',
  'run',
  'help',
  'self-update',
  'doctor',
  'root',
  'bin',
  'fetch',
  'import',
  'unlink',
  'dedupe',
  'cache',
]);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What may precede `pnpm` for it to start a command: nothing, a separator, a prompt, env assignments, or a wrapper. */
export const commandStart = (wrappers: readonly string[]): RegExp =>
  new RegExp(`(?:^|&&|\\|\\||;|\\||\\$|\\(|\\b(?:${['exec', ...wrappers.map(escapeRegExp), 'time', 'env', 'then', 'do'].join('|')})|\\s--)\\s*(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*$`);

export interface ScriptProblem {
  readonly file: string;
  readonly line: number;
  readonly script: string;
  readonly reason: string;
}

/** The documented-script rules over `files`; `scopes` judges where each resolves. */
export const findScriptProblems = (config: Config, files: readonly string[], defined: ReadonlySet<string>, scopes: ReadonlyMap<string, ReadonlySet<string>>, read: (path: string) => string | undefined): ScriptProblem[] => {
  const problems: ScriptProblem[] = [];
  const start = commandStart(config.scripts.wrappers);
  // `pnpm run foo`, `pnpm foo`, `pnpm --filter x foo`; not `npx`, which
  // resolves from the registry. The `--filter` target is captured: a filtered
  // command resolves in another scope.
  const invocation = /\bpnpm\s+(?:run\s+)?(?:--filter[= ](\S+)\s+)?([a-z][a-z0-9:-]*)/g;
  for (const relative of files) {
    const content = read(relative);
    if (content === undefined) continue;
    const lines = content.split('\n');
    const roles = fenceRoles(lines);
    lines.forEach((line, index) => {
      const role = roles[index];
      // A fence line itself carries no command; its info string is a label.
      if (role === 'fence' || config.exemptMarker.test(line)) return;
      const inFence = role === 'code';
      const spans = inFence ? null : spanRanges(line);
      // A shell comment in a fence is prose; a `#` inside quotes or escaped starts none.
      const text = inFence ? stripComment(line) : line;
      // A fence line is shell: a quoted separator starts no command, so the
      // start is judged in the quote-masked line. Prose is not shell.
      const code = inFence ? maskQuoted(text) : text;
      for (const match of text.matchAll(invocation)) {
        const filter = match[1];
        const script = String(match[2]);
        if (BUILTIN.has(script)) continue;
        // Only text the author marked as code counts, and all of the invocation must be in it.
        const span = spans === null ? ([0, text.length] as const) : spans.find(([a, b]) => match.index >= a && match.index + match[0].length <= b);
        if (span === undefined) continue;
        // `pnpm dev:*` and `pnpm <script>` name a family, not a script.
        if (/^[*<]/.test(text.slice(match.index + match[0].length))) continue;
        // Only a command's start runs anything: `using pnpm v11` in a quoted log line is output.
        if (!start.test(code.slice(span[0], match.index))) continue;
        const report = (reason: string): void => {
          problems.push({ file: relative, line: index + 1, script, reason });
        };
        if (!defined.has(script)) {
          report(`no workspace defines a \`${script}\` script — this step runs nothing`);
          continue;
        }
        // Existing somewhere is not resolving where the doc runs it: an unknown
        // --filter target is not this check's to adjudicate.
        const scope = scopes.get(filter ?? '.');
        if (scope !== undefined && !scope.has(script)) {
          report(
            filter === undefined
              ? `\`${script}\` is not a root script — \`pnpm ${script}\` resolves the root manifest, so this needs \`--filter\``
              : `\`${script}\` is not a script of \`${filter}\` — the filter names a workspace that does not define it`,
          );
          continue;
        }
        const safer = config.scripts.mutating.get(script);
        if (safer !== undefined && config.scripts.verification.test(line)) report(`\`${script}\` MUTATES the tree (it auto-fixes) — a verification step must use \`${safer}\``);
      }
    });
  }
  return problems;
};
