// The doc-references config: every fact about one repository the checks read
// (which files carry references, where scripts and identifiers are defined,
// what reads as a placeholder) lives here, never in the engine.
import { isRecord, isRepoPath, list, object, onlyKeys, parseJson, path, regex, required, text, type Raw } from './registry-ratchet.ts';

export interface PrismaConfig {
  /** Schema files: `Model.field` and `@@unique([a, b])` are judged against them. */
  readonly schemas: RegExp;
  /** The migrations directory a `20250101000000_name` span must be under, or undefined when not checked. */
  readonly migrations: string | undefined;
  /** The enum `@Roles(…)` values must belong to, and the schema declaring it, or undefined when not checked. */
  readonly roles: { readonly schema: string; readonly enum: string } | undefined;
}

export interface Config {
  readonly baseline: string;
  /** The per-line opt-out word: `<marker>: <reason>`. */
  readonly exemptMarker: RegExp;
  /** The marker as written, for the fix message. */
  readonly exemptWord: string;
  readonly files: {
    readonly markdown: readonly RegExp[];
    readonly html: readonly RegExp[];
    readonly code: readonly RegExp[];
    /** Code files whose paths name absent files on purpose (tests, fixtures). */
    readonly codeExclude: readonly RegExp[];
    /** Trees that are not this repository's prose: vendored, generated, frozen history. */
    readonly exclude: readonly RegExp[];
    /** Code whose comments start with `#`; every other code file uses `//`, `/*` and `*`. */
    readonly hashComments: RegExp;
  };
  /** A token or link target that names a pattern, not a file. */
  readonly placeholder: RegExp;
  readonly paths: {
    readonly extensions: ReadonlySet<string>;
    /** Illustrative names: an example, not a file. */
    readonly examples: RegExp;
    /** Directories tooling creates at run time and never tracks. */
    readonly untracked: readonly string[];
    /** Workspace manifests besides the root `package.json`: their folders (and `src`) are bases a path resolves from. */
    readonly workspaces: RegExp;
    /** Paths that name a layout rather than a file, unless the doc citing them matches `except`. */
    readonly layouts: ReadonlyArray<{ readonly pattern: RegExp; readonly except: RegExp | undefined }>;
  };
  /** Lychee's link and anchor check over the matching docs, or undefined when not checked. */
  readonly links: { readonly include: RegExp } | undefined;
  readonly scripts: {
    /** Manifests a documented `pnpm <script>` may resolve in. */
    readonly manifests: readonly string[];
    /** Scripts that change the tree, each with the one a verification step should use. */
    readonly mutating: ReadonlyMap<string, string>;
    /** Words that make a line a verification step. */
    readonly verification: RegExp;
    /** Repository wrappers that run the rest of the line as a command (`dev:exec`). */
    readonly wrappers: readonly string[];
  };
  readonly commands: {
    /** The command that runs a `.ts` script, for the fix message; undefined leaves `.ts` launches unjudged. */
    readonly typescriptRunner: string | undefined;
    /** Programs a wrapper script hands the rest of its words to (`vitest`, `turbo`). */
    readonly nested: readonly string[];
  };
  readonly identifiers: {
    /** Names that read as identifiers but are products or prose. */
    readonly notIdentifiers: ReadonlySet<string>;
    /** Tracked text that defines no name a doc may cite (prose, data, quoted wrong names). */
    readonly searchExclude: readonly RegExp[];
    /** Pathspecs the removed-identifier diff leaves out (prose, which defines nothing). */
    readonly diffExclude: readonly string[];
    readonly prisma: PrismaConfig | undefined;
    readonly routes: { readonly controllers: RegExp; readonly prefixes: RegExp } | undefined;
    readonly jobs: { readonly workflows: RegExp } | undefined;
    readonly packages: { readonly manifests: RegExp; readonly lockfile: string | undefined; readonly ownScopes: readonly string[] } | undefined;
  };
  /** Keys set to null: what this config leaves unchecked. */
  readonly skipped: readonly string[];
}

const strings = (raw: Raw, key: string, where: string): string[] =>
  list(raw, key, where).map((s, i) => {
    if (typeof s !== 'string' || s === '') throw new Error(`${where}${key}[${i}] must be a non-empty string`);
    return s;
  });

/** A list of regular expressions, empty allowed. */
const patterns = (raw: Raw, key: string, where: string, flags = ''): RegExp[] => list(raw, key, where).map((s, i) => regex(s, `${where}${key}[${i}]`, flags));

const nonEmpty = <T>(items: T[], key: string, where: string): T[] => {
  if (items.length === 0) throw new Error(`${where}"${key}" is empty, so nothing would match`);
  return items;
};

/** A regex at `raw[key]`, flags optional as `{ "pattern", "flags" }`. */
const pattern = (raw: Raw, key: string, where: string): RegExp => {
  const v = raw[key];
  if (isRecord(v)) {
    onlyKeys(v, ['pattern', 'flags'], `${where}${key}: `);
    const flags = v['flags'] ?? '';
    if (typeof flags !== 'string' || !/^[imsu]*$/.test(flags)) throw new Error(`${where}${key}.flags must be some of i, m, s, u`);
    return regex(v['pattern'], `${where}${key}.pattern`, flags);
  }
  return regex(v, `${where}"${key}"`);
};

const MARKER_WORD = /^[\w-]+$/;

export const parseConfig = (source: string): Config => {
  const raw = parseJson(source);
  onlyKeys(raw, ['baseline', 'exemptMarker', 'files', 'placeholder', 'paths', 'links', 'scripts', 'commands', 'identifiers'], '');
  const skipped: string[] = [];
  const exemptWord = text(raw, 'exemptMarker', '');
  if (!MARKER_WORD.test(exemptWord)) throw new Error('"exemptMarker" must be one word of letters, digits, _ and -');

  const filesRaw = object(raw, 'files', '');
  const fw = 'files: ';
  onlyKeys(filesRaw, ['markdown', 'html', 'code', 'codeExclude', 'exclude', 'hashComments'], fw);
  const files = {
    markdown: nonEmpty(patterns(filesRaw, 'markdown', fw), 'markdown', fw),
    html: patterns(filesRaw, 'html', fw),
    code: patterns(filesRaw, 'code', fw),
    codeExclude: patterns(filesRaw, 'codeExclude', fw),
    exclude: patterns(filesRaw, 'exclude', fw),
    hashComments: pattern(filesRaw, 'hashComments', fw),
  };

  const pathsRaw = object(raw, 'paths', '');
  const pw = 'paths: ';
  onlyKeys(pathsRaw, ['extensions', 'examples', 'untracked', 'workspaces', 'layouts'], pw);
  const extensions = nonEmpty(strings(pathsRaw, 'extensions', pw), 'extensions', pw).map((e, i) => {
    if (!/^[a-z0-9]+$/.test(e)) throw new Error(`${pw}extensions[${i}]: "${e}" must be lowercase letters and digits, no dot`);
    return e;
  });
  const untracked = strings(pathsRaw, 'untracked', pw).map((p, i) => {
    if (!p.endsWith('/') || !isRepoPath(p.slice(0, -1))) throw new Error(`${pw}untracked[${i}]: "${p}" must be a root-relative folder ending in /`);
    return p;
  });
  const layouts = list(pathsRaw, 'layouts', pw).map((l, i) => {
    const where = `${pw}layouts[${i}]: `;
    if (!isRecord(l)) throw new Error(`${pw}layouts[${i}] must be an object`);
    onlyKeys(l, ['pattern', 'except'], where);
    return { pattern: regex(l['pattern'], `${where}"pattern"`), except: l['except'] === undefined ? undefined : regex(l['except'], `${where}"except"`) };
  });
  const paths = {
    extensions: new Set(extensions),
    examples: pattern(pathsRaw, 'examples', pw),
    untracked,
    workspaces: pattern(pathsRaw, 'workspaces', pw),
    layouts,
  };

  const links = required(raw, 'links', '', skipped, () => {
    const l = object(raw, 'links', '');
    onlyKeys(l, ['include'], 'links: ');
    return { include: pattern(l, 'include', 'links: ') };
  });

  const scriptsRaw = object(raw, 'scripts', '');
  const sw = 'scripts: ';
  onlyKeys(scriptsRaw, ['manifests', 'mutating', 'verification', 'wrappers'], sw);
  const manifests = nonEmpty(strings(scriptsRaw, 'manifests', sw), 'manifests', sw).map((m, i) => {
    if (!isRepoPath(m) || !/(?:^|\/)package\.json$/.test(m)) throw new Error(`${sw}manifests[${i}]: "${m}" must be a root-relative package.json`);
    return m;
  });
  const mutatingRaw = object(scriptsRaw, 'mutating', sw);
  const mutating = new Map<string, string>();
  for (const [name, safer] of Object.entries(mutatingRaw)) {
    if (typeof safer !== 'string' || safer === '') throw new Error(`${sw}mutating.${name} must name the script to use instead`);
    mutating.set(name, safer);
  }
  const scripts = {
    manifests,
    mutating,
    verification: pattern(scriptsRaw, 'verification', sw),
    wrappers: strings(scriptsRaw, 'wrappers', sw),
  };

  const commandsRaw = object(raw, 'commands', '');
  const cw = 'commands: ';
  onlyKeys(commandsRaw, ['typescriptRunner', 'nested'], cw);
  const commands = {
    typescriptRunner: required(commandsRaw, 'typescriptRunner', cw, skipped, () => text(commandsRaw, 'typescriptRunner', cw)),
    nested: strings(commandsRaw, 'nested', cw),
  };

  const idRaw = object(raw, 'identifiers', '');
  const iw = 'identifiers: ';
  onlyKeys(idRaw, ['notIdentifiers', 'searchExclude', 'diffExclude', 'prisma', 'routes', 'jobs', 'packages'], iw);
  const prisma = required(idRaw, 'prisma', iw, skipped, (): PrismaConfig => {
    const p = object(idRaw, 'prisma', iw);
    const w = 'identifiers.prisma: ';
    onlyKeys(p, ['schemas', 'migrations', 'roles'], w);
    return {
      schemas: pattern(p, 'schemas', w),
      migrations: required(p, 'migrations', w, skipped, () => path(p, 'migrations', w)),
      roles: required(p, 'roles', w, skipped, () => {
        const r = object(p, 'roles', w);
        onlyKeys(r, ['schema', 'enum'], `${w}roles: `);
        const name = text(r, 'enum', `${w}roles: `);
        if (!/^\w+$/.test(name)) throw new Error(`${w}roles.enum must be an enum name`);
        return { schema: path(r, 'schema', `${w}roles: `), enum: name };
      }),
    };
  });
  const routes = required(idRaw, 'routes', iw, skipped, () => {
    const r = object(idRaw, 'routes', iw);
    const w = 'identifiers.routes: ';
    onlyKeys(r, ['controllers', 'prefixes'], w);
    return { controllers: pattern(r, 'controllers', w), prefixes: pattern(r, 'prefixes', w) };
  });
  const jobs = required(idRaw, 'jobs', iw, skipped, () => {
    const j = object(idRaw, 'jobs', iw);
    onlyKeys(j, ['workflows'], 'identifiers.jobs: ');
    return { workflows: pattern(j, 'workflows', 'identifiers.jobs: ') };
  });
  const packages = required(idRaw, 'packages', iw, skipped, () => {
    const p = object(idRaw, 'packages', iw);
    const w = 'identifiers.packages: ';
    onlyKeys(p, ['manifests', 'lockfile', 'ownScopes'], w);
    const ownScopes = strings(p, 'ownScopes', w).map((s, i) => {
      if (!/^@[a-z0-9][\w.-]*\/$/.test(s)) throw new Error(`${w}ownScopes[${i}]: "${s}" must be a scope ending in / (@acme/)`);
      return s;
    });
    return { manifests: pattern(p, 'manifests', w), lockfile: required(p, 'lockfile', w, skipped, () => path(p, 'lockfile', w)), ownScopes };
  });
  const identifiers = {
    notIdentifiers: new Set(strings(idRaw, 'notIdentifiers', iw)),
    searchExclude: patterns(idRaw, 'searchExclude', iw),
    diffExclude: strings(idRaw, 'diffExclude', iw),
    prisma,
    routes,
    jobs,
    packages,
  };

  return {
    baseline: path(raw, 'baseline', ''),
    exemptMarker: new RegExp(`${exemptWord}:\\s*\\S`),
    exemptWord,
    files,
    placeholder: pattern(raw, 'placeholder', ''),
    paths,
    links,
    scripts,
    commands,
    identifiers,
    skipped,
  };
};
