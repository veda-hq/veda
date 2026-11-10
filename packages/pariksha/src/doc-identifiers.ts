// DOC-DRIFT-04: a code identifier a doc names exists in the code. Every
// single-identifier code span in a doc's prose is asked of the code:
//
//   - env vars, constants and symbols (`DATABASE_URL`, `parseArgs()`,
//     `OrderService`): a whole word somewhere in the tracked code; when the doc
//     says "`x` in `path`", in that file;
//   - Prisma `Model.field`, `@@unique([a, b])`, migration folders and
//     `@Roles(…)` values (`identifiers.prisma`);
//   - HTTP routes (`GET /stores/:id`) against controller decorators
//     (`identifiers.routes`);
//   - CI jobs ("the `build` job") against workflow files (`identifiers.jobs`);
//   - packages (`@acme/core`, `zod@4.1.0`) against workspaces and the
//     lockfile (`identifiers.packages`).
//
// The code search reads the whole tree, so it runs at push and in CI, not at
// commit.
import { posix } from 'node:path';
import { load } from 'js-yaml';
import type { Config } from './doc-references-config.ts';
import { codeSpans, docKind, scanMarkdown, type ReferenceProblem, type RepoSnapshot } from './doc-references.ts';
import { isRecord } from './registry-ratchet.ts';

export type IdentifierKind = 'symbol' | 'prisma-field' | 'prisma-unique' | 'migration' | 'route' | 'roles' | 'job' | 'package';

export interface IdentifierRef {
  readonly kind: IdentifierKind;
  readonly text: string;
  /** The word the code search looks for (symbols). */
  readonly word?: string;
}

const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const CAMEL = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
const PASCAL = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/;
const CALL = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\)$/;
const DOTTED = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/;
const MIGRATION = /^\d{14}_[a-z0-9_]+$/;
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/;
const ROLES = /^@Roles\((.*)\)$/;
const SCOPED_PACKAGE = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)(?:@(\d+\.\d+\.\d+))?$/;
const VERSIONED_PACKAGE = /^([a-z0-9][\w.-]*)@(\d+\.\d+\.\d+)$/;

/** What a single code span names, if it names an identifier; `notIdentifiers` are products and prose. */
export const identifierRef = (span: string, notIdentifiers: ReadonlySet<string>): IdentifierRef | null => {
  const text = span.trim();
  if (/\s{2,}/.test(text)) return null;
  if (MIGRATION.test(text)) return { kind: 'migration', text };
  if (ROUTE.test(text)) return { kind: 'route', text };
  if (ROLES.test(text)) return { kind: 'roles', text };
  if (/^@@unique\(\[[\w\s,]+\]\)$/.test(text)) return { kind: 'prisma-unique', text };
  if (SCOPED_PACKAGE.test(text) || VERSIONED_PACKAGE.test(text)) return { kind: 'package', text };
  if (/\s/.test(text) || notIdentifiers.has(text)) return null;
  const call = CALL.exec(text);
  if (call !== null) {
    const word = String(call[1]).replace(/^.*\./, '');
    return word.length < 3 || notIdentifiers.has(word) ? null : { kind: 'symbol', text, word };
  }
  const dotted = DOTTED.exec(text);
  if (dotted !== null && /^[A-Z]/.test(String(dotted[1])) && /^[a-z]/.test(String(dotted[2]))) return { kind: 'prisma-field', text };
  // Lower snake_case is deliberately absent: it is dominated by names that are
  // not the repository's code (tool names, database settings, table keys).
  if (UPPER_SNAKE.test(text) || CAMEL.test(text) || PASCAL.test(text)) return { kind: 'symbol', text, word: text };
  return null;
};

interface PrismaModel {
  readonly fields: Set<string>;
  readonly uniques: string[];
}

/** Text of every tracked file whose path matches `pattern`. */
const contents = (snapshot: RepoSnapshot, pattern: RegExp): string[] => [...snapshot.readMany([...snapshot.files].filter((file) => pattern.test(file))).values()];

const prismaModels = (snapshot: RepoSnapshot, schemas: RegExp): Map<string, PrismaModel> => {
  const models = new Map<string, PrismaModel>();
  for (const text of contents(snapshot, schemas)) {
    for (const block of text.matchAll(/^(model|enum|type|view)\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const fields = new Set<string>();
      const uniques: string[] = [];
      for (const raw of String(block[3]).split('\n')) {
        // A blank line, a `//` comment or an `@@` attribute starts with no word, so it names no field.
        const line = raw.trim();
        const unique = /^@@(?:unique|id)\(\s*\[([^\]]+)\]/.exec(line);
        if (unique !== null) {
          uniques.push(
            String(unique[1])
              .split(',')
              .map((f) => String(f.trim().split(/[\s(]/)[0]))
              .join(','),
          );
          continue;
        }
        const name = /^(\w+)/.exec(line);
        if (name !== null) fields.add(String(name[1]));
      }
      models.set(String(block[2]), { fields, uniques });
    }
  }
  return models;
};

interface Route {
  readonly method: string;
  readonly segments: string[];
}

const splitRoute = (path: string): string[] =>
  path
    .split('/')
    .filter(Boolean)
    .map((segment) => (/^[:{]/.test(segment) ? ':' : segment.toLowerCase()));

/** Routes the controllers' decorators serve (`@Controller('x')`, `@Get(':id')`). */
const controllerRoutes = (snapshot: RepoSnapshot, controllers: RegExp): Route[] => {
  const routes: Route[] = [];
  for (const text of contents(snapshot, controllers)) {
    let prefix = '';
    for (const match of text.matchAll(/@(Controller|Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?[^)]*\)/g)) {
      const path = match[2] ?? '';
      if (match[1] === 'Controller') {
        prefix = path;
        continue;
      }
      routes.push({ method: String(match[1]).toUpperCase(), segments: splitRoute(`${prefix}/${path}`) });
    }
  }
  return routes;
};

/** A controller parameter takes any documented value (`/stores/42`); a documented parameter names only a parameter. */
const routeMatches = (route: Route, method: string, segments: readonly string[]): boolean =>
  route.method === method && route.segments.length === segments.length && route.segments.every((segment, index) => segment === ':' || segment === segments[index]);

const roleValues = (snapshot: RepoSnapshot, schema: string, name: string): Set<string> => {
  const roles = new Set<string>();
  const text = snapshot.read(schema);
  if (text === undefined) return roles;
  for (const [, block] of text.matchAll(new RegExp(`^enum ${name}\\s*\\{([\\s\\S]*?)^\\}`, 'gm'))) {
    for (const [, role] of String(block).matchAll(/^[ \t]*([A-Z_]+)\s*$/gm)) roles.add(String(role));
  }
  return roles;
};

/** Job ids and job names in the workflow files; one that does not parse is its linter's to fail. */
const workflowJobs = (snapshot: RepoSnapshot, workflows: RegExp): Set<string> => {
  const jobs = new Set<string>();
  for (const text of contents(snapshot, workflows)) {
    let workflow: unknown;
    try {
      workflow = load(text);
    } catch {
      continue;
    }
    const all = isRecord(workflow) ? workflow['jobs'] : undefined;
    if (!isRecord(all)) continue;
    for (const [id, job] of Object.entries(all)) {
      jobs.add(id);
      if (isRecord(job) && typeof job['name'] === 'string') jobs.add(job['name']);
    }
  }
  return jobs;
};

/** A manifest's parsed JSON as an object, or undefined: a malformed manifest is another check's to fail. */
export const manifestObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

interface PackageIndex {
  readonly names: Set<string>;
  readonly versions: Set<string>;
}

const packageIndex = (snapshot: RepoSnapshot, manifests: RegExp, lockfile: string | undefined): PackageIndex => {
  const names = new Set<string>();
  const versions = new Set<string>();
  for (const text of contents(snapshot, manifests)) {
    const name = manifestObject(text)?.['name'];
    if (typeof name === 'string') names.add(name);
  }
  const lock = lockfile === undefined ? undefined : snapshot.read(lockfile);
  for (const match of (lock ?? '').matchAll(/^ {2}'?((?:@[\w.-]+\/)?[\w.-]+)@(\d+\.\d+\.\d+[^:'(]*)/gm)) {
    names.add(String(match[1]));
    versions.add(`${String(match[1])}@${String(match[2])}`);
  }
  return { names, versions };
};

const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|ttf|otf|woff2?|jar|keystore|zip|gz|tgz|pdf|mp4|mov|mp3|wav|tflite|bin|so|a|dylib|car|lockb)$/i;

/** Tracked text that can define a name: everything but binaries, the baseline and the config's `searchExclude`. */
export const isCode = (config: Config, path: string): boolean => !BINARY.test(path) && path !== config.baseline && !config.identifiers.searchExclude.some((p) => p.test(path));

/** Which of `words` occur as whole words in the snapshot's code. */
export const wordsInCode = (config: Config, snapshot: RepoSnapshot, words: readonly string[]): Set<string> => {
  const wanted = new Set(words);
  const found = new Set<string>();
  if (wanted.size === 0) return found;
  // One tokenising pass over the code, in process: `git grep -F -w -f` with
  // thousands of patterns runs for minutes on a large tree.
  for (const text of snapshot.readMany([...snapshot.files].filter((path) => isCode(config, path))).values()) {
    for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (wanted.has(match[0])) {
        found.add(match[0]);
        if (found.size === wanted.size) return found;
      }
    }
  }
  return found;
};

interface Pending {
  readonly file: string;
  readonly line: number;
  readonly ref: IdentifierRef;
  /** "`x` in `path`": the file the doc says holds it. */
  readonly citedFile: string | undefined;
}

/** `\b` cannot bound a `$`: a word bounded by "no identifier character" on either side. */
export const boundedWord = (word: string): RegExp => new RegExp(`(?<![\\w$])${word.replace(/\$/g, '\\$')}(?![\\w$])`);

/** Runs DOC-DRIFT-04 over `files` in `snapshot`. */
export const findIdentifierProblems = (config: Config, snapshot: RepoSnapshot, files: readonly string[]): ReferenceProblem[] => {
  const { notIdentifiers, prisma, routes: routeConfig, jobs: jobConfig, packages: packageConfig } = config.identifiers;
  const pending: Pending[] = [];
  for (const file of files) {
    if (docKind(config, file) !== 'markdown') continue;
    const content = snapshot.read(file);
    if (content === undefined) continue;
    for (const line of scanMarkdown(content, config.exemptMarker)) {
      if (line.exempt || line.fence !== null || line.frontmatter) continue;
      const spans = codeSpans(line.text);
      spans.forEach((span, index) => {
        const ref = identifierRef(span.content, notIdentifiers);
        if (ref === null) return;
        // A CI job is named as one: "the `build` job".
        if (ref.kind === 'symbol' && /^\s+jobs?\b/.test(line.text.slice(span.end + 1))) {
          pending.push({ file, line: line.number, ref: { kind: 'job', text: ref.text }, citedFile: undefined });
          return;
        }
        const next = spans[index + 1];
        let citedFile: string | undefined;
        if (next !== undefined && /^\s*(?:in|from)\s*\[?$/.test(line.text.slice(span.end + 1, next.start - 1))) {
          const path = next.content.replace(/:\d+(?:-\d+)?$/, '');
          citedFile = [posix.join(posix.dirname(file), path), path].map((p) => posix.normalize(p)).find((p) => snapshot.files.has(p));
        }
        pending.push({ file, line: line.number, ref, citedFile });
      });
    }
  }

  const inCode = wordsInCode(
    config,
    snapshot,
    [...new Set(pending.flatMap((p) => (p.ref.word === undefined ? [] : [p.ref.word])))],
  );
  let models: Map<string, PrismaModel> | undefined;
  let routes: Route[] | undefined;
  let roles: Set<string> | undefined;
  let jobs: Set<string> | undefined;
  let packages: PackageIndex | undefined;

  const problems: ReferenceProblem[] = [];
  const flag = (p: Pending, reason: string): void => {
    problems.push({ check: 'DOC-DRIFT-04', file: p.file, line: p.line, ref: p.ref.text, reason });
  };

  for (const p of pending) {
    const { ref } = p;
    switch (ref.kind) {
      case 'symbol': {
        const word = ref.word ?? ref.text;
        if (p.citedFile !== undefined) {
          const text = snapshot.read(p.citedFile);
          if (text !== undefined && !boundedWord(word).test(text)) flag(p, `\`${word}\` does not occur in \`${p.citedFile}\`, the file the doc cites for it`);
        } else if (!inCode.has(word)) {
          flag(p, `\`${word}\` occurs nowhere in the code — renamed, removed, or never written`);
        }
        break;
      }
      case 'prisma-field': {
        if (prisma === undefined) break;
        models ??= prismaModels(snapshot, prisma.schemas);
        const [model = '', field = ''] = ref.text.split('.');
        const found = models.get(model);
        // Every `Capital.lower` reads as a column (`Object.keys`), so only a model the schema declares is judged.
        if (found !== undefined && !found.fields.has(field)) flag(p, `Prisma model \`${model}\` has no field \`${field}\``);
        break;
      }
      case 'prisma-unique': {
        if (prisma === undefined) break;
        models ??= prismaModels(snapshot, prisma.schemas);
        const wanted = ref.text
          .replace(/^@@unique\(\[|\]\)$/g, '')
          .split(',')
          .map((f) => f.trim())
          .join(',');
        if (![...models.values()].some((model) => model.uniques.includes(wanted))) flag(p, `no Prisma model declares \`${ref.text}\``);
        break;
      }
      case 'migration': {
        const dir = prisma?.migrations;
        if (dir !== undefined && !snapshot.dirs.has(`${dir}/${ref.text}`)) flag(p, `\`${ref.text}\` is not a directory under ${dir}/`);
        break;
      }
      case 'route': {
        if (routeConfig === undefined) break;
        routes ??= controllerRoutes(snapshot, routeConfig.controllers);
        const [, method = '', rawPath = ''] = ROUTE.exec(ref.text) ?? [];
        const path = rawPath.replace(/[?#].*$/, '');
        if (/[{][^}]*,/.test(path)) break; // a brace expansion lists several
        const all = splitRoute(path);
        const known = new Set(routes.map((route) => route.segments[0]));
        // Clients and proxies prefix the served paths (`/api/v1`); the server does not.
        const start = all.findIndex((segment) => known.has(segment) || !routeConfig.prefixes.test(segment));
        const segments = all.slice(start === -1 ? all.length : start);
        const head = segments[0];
        if (head === undefined || !known.has(head)) break; // not this repository's
        if (!routes.some((served) => routeMatches(served, method, segments))) flag(p, `no controller serves \`${method} ${path}\``);
        break;
      }
      case 'roles': {
        const rolesConfig = prisma?.roles;
        if (rolesConfig === undefined) break;
        roles ??= roleValues(snapshot, rolesConfig.schema, rolesConfig.enum);
        // No enum to read is a failure, not a pass: every role would go unchecked.
        if (roles.size === 0) {
          flag(p, `no \`${rolesConfig.enum}\` in the Prisma schema to check roles against`);
          break;
        }
        for (const match of ref.text.replace(/^@Roles\(|\)$/g, '').matchAll(/(?:\w+\.)?([A-Z][A-Z_]+)/g)) {
          const role = String(match[1]);
          if (!roles.has(role)) flag(p, `\`${role}\` is not a value of ${rolesConfig.enum}`);
        }
        break;
      }
      case 'job': {
        if (jobConfig === undefined) break;
        jobs ??= workflowJobs(snapshot, jobConfig.workflows);
        if (!jobs.has(ref.text)) flag(p, `no workflow has a job \`${ref.text}\``);
        break;
      }
      case 'package': {
        if (packageConfig === undefined) break;
        packages ??= packageIndex(snapshot, packageConfig.manifests, packageConfig.lockfile);
        const scoped = SCOPED_PACKAGE.exec(ref.text);
        const versioned = VERSIONED_PACKAGE.exec(ref.text);
        const name = scoped?.[1] ?? versioned?.[1] ?? ref.text;
        const version = scoped?.[2] ?? versioned?.[2];
        if (!packages.names.has(name)) {
          // Only the repository's own scopes are knowable; a third-party name the lockfile lacks may be installed elsewhere.
          if (packageConfig.ownScopes.some((scope) => name.startsWith(scope))) flag(p, `no workspace is named \`${name}\``);
        } else if (version !== undefined && !packages.versions.has(`${name}@${version}`)) {
          flag(p, `the lockfile has no \`${name}@${version}\``);
        }
        break;
      }
    }
  }
  return problems;
};
