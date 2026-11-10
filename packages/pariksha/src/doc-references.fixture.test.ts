// Shared by the doc-references suites: a config with every check on, and
// throwaway git repositories. Importing this module makes the process's own
// git hermetic: every GIT_* variable a hook or a developer set is dropped, and
// no global or system config is read, so the code under test (which spawns
// its own git) sees only the fixture. node --test runs each suite in its own
// process, so this touches no other suite.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { after } from 'node:test';
import type { LinkRunner } from './doc-links.ts';
import { parseConfig, type Config } from './doc-references-config.ts';
import { createSnapshot, type RepoSnapshot } from './doc-references.ts';

for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
});

/** The config the suites run under, as JSON: every check on, the shapes a typical monorepo has. */
export const CONFIG_JSON = {
  baseline: 'scripts/docs/doc-references-baseline.json',
  exemptMarker: 'doc-ref-ok',
  files: {
    markdown: ['\\.(md|mdx)$', '^\\.agents?/.*\\.xml$'],
    html: ['^(?!.*\\.template\\.)(?:.*/)?docs/.*\\.html$'],
    code: ['\\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|bash|py)$|^\\.husky/[^/]+$'],
    codeExclude: ['\\.(test|spec|fixture)\\.[cm]?[jt]sx?$|(^|/)test_[^/]+\\.py$'],
    exclude: ['(^|/)node_modules/', '(^|/)__fixtures__/', '(^|/)fixtures?/', '(^|/)__snapshots__/', '^patches/', '(^|/)CHANGELOG\\.md$', '\\.min\\.js$', '(^|/)generated/', '^docs/history/(?!README\\.md$)'],
    hashComments: '\\.(sh|bash|py)$|^\\.husky/',
  },
  placeholder: '[<>${}%…]|\\.\\.\\.|NNN|XXXX|YYYY|MMDD|-NN\\b|\\[id\\]|\\bslug\\b',
  paths: {
    extensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'json5', 'md', 'mdx', 'sh', 'bash', 'zsh', 'py', 'yml', 'yaml', 'toml', 'prisma', 'sql', 'html', 'css', 'scss', 'xml', 'txt', 'csv', 'tsv', 'plist', 'gradle', 'kt', 'kts', 'java', 'swift', 'png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'example', 'sample', 'ini', 'cfg', 'conf', 'lock', 'mermaid', 'patch', 'rb', 'podspec', 'snap'],
    examples: { pattern: '(^|/)(foo|bar|baz|qux|x|y|z|a|b|c|thing|example|sample|my[-_][\\w-]+|\\d{4}-(thing|x|example))(\\.[\\w.]+)?$|^(dir|some-dir|path/to)/', flags: 'i' },
    untracked: ['.claude/worktrees/'],
    workspaces: '^(apps|packages)/[^/]+/package\\.json$',
    layouts: [{ pattern: '^(?:handoffs|evidence)/[A-Z]{1,3}-\\d{2,3}(?![\\w-])', except: '^docs/work/' }],
  },
  links: { include: '\\.md$' },
  scripts: {
    manifests: ['package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/shared/package.json'],
    mutating: { lint: 'lint:ci', 'lint:fix': 'lint:ci', format: 'format:check' },
    verification: { pattern: 'verif|check|validat|gate|quality|ensure', flags: 'i' },
    wrappers: ['dev:exec'],
  },
  commands: { typescriptRunner: 'pnpm exec tsx', nested: ['vitest', 'jest', 'playwright', 'detox', 'prisma', 'eslint', 'tsc', 'turbo', 'git', 'stryker'] },
  identifiers: {
    notIdentifiers: ['GitHub', 'TypeScript', 'JavaScript', 'PostgreSQL', 'NestJS', 'iOS', 'macOS', 'OAuth', 'xit', 'xtest'],
    searchExclude: ['\\.(md|mdx|html|jsonl|snap)$', '^(docs|\\.agents?)/', '^scripts/docs/(?:.*\\.(?:test|spec|fixture)\\.[cm]?[jt]sx?$|(?:.*/)?__fixtures__/)', '^pnpm-lock\\.yaml$'],
    diffExclude: ['*.md', 'docs/**'],
    prisma: { schemas: '^apps/server/prisma/.*\\.prisma$', migrations: 'apps/server/prisma/migrations', roles: { schema: 'apps/server/prisma/schema.prisma', enum: 'UserRoleEnum' } },
    routes: { controllers: '^apps/server/src/.*\\.controller\\.ts$', prefixes: '^(api|v\\d+)$' },
    jobs: { workflows: '^\\.github/workflows/[^/]+\\.ya?ml$' },
    packages: { manifests: '^(?!(?:.*/)?node_modules/)(?:.*/)?package\\.json$', lockfile: 'pnpm-lock.yaml', ownScopes: ['@acme/'] },
  },
};

type Json = Record<string, unknown>;
const isJson = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `base` with `over` merged in, object by object; a null or non-object value replaces. */
export const merged = (base: Json, over: Json): Json => {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const was = out[k];
    out[k] = isJson(v) && isJson(was) ? merged(was, v) : v;
  }
  return out;
};

/** The suites' config with `over` merged in. */
export const testConfig = (over: Json = {}): Config => parseConfig(JSON.stringify(merged(CONFIG_JSON, over)));

export const CONFIG = testConfig();

/** A link runner for trees with no links to judge: lychee's report of no error. */
export const noLinks: LinkRunner = () => '{"error_map":{}}';

/**
 * A stand-in for lychee: each doc's inline Markdown links `[text](target)`
 * to a relative file, judged by whether the file exists in `dir`. Anchors are
 * not judged (lychee's own job); a URL is skipped, as lychee offline skips it.
 */
export const fakeLinks: LinkRunner = (given, files) => {
  // As lychee does: targets under the real path, so a symlinked temp dir (macOS /var) names them as written.
  const dir = realpathSync(given);
  const errorMap: Record<string, unknown[]> = {};
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(/\]\(([^)\s#]+)(#[^)\s]*)?\)/g)) {
        const target = String(match[1]);
        if (/^[a-z]+:/.test(target)) continue;
        const full = target.startsWith('/') ? join(dir, target) : resolve(dirname(join(dir, file)), target);
        if (existsSync(full)) continue;
        (errorMap[file] ??= []).push({ url: `file://${full}${match[2] ?? ''}`, status: { text: 'Cannot find file' }, span: { line: index + 1 } });
      }
    });
  }
  return JSON.stringify({ error_map: errorMap });
};

export interface TestRepo {
  readonly root: string;
  write(path: string, content: string): void;
  remove(path: string): void;
  git(...args: string[]): string;
  /** Stages everything and commits; returns the new HEAD. */
  commit(message?: string): string;
  /** Stages everything, then a snapshot of the worktree or the index. */
  snapshot(kind?: 'worktree' | 'index'): RepoSnapshot;
  /** A path relative to the root, for messages. */
  rel(path: string): string;
}

const roots: string[] = [];
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A git repository holding `files`, an empty `node_modules/.bin` (a real install) and a .gitignore for it. */
export const createTestRepo = (files: Readonly<Record<string, string>> = {}): TestRepo => {
  const root = mkdtempSync(join(tmpdir(), 'doc-refs-'));
  roots.push(root);
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('.gitignore', 'node_modules/\n.tmp/\n');
  for (const [path, content] of Object.entries(files)) write(path, content);
  return {
    root,
    write,
    remove: (path) => rmSync(join(root, path), { force: true }),
    git,
    commit: (message = 'fixture') => {
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', message);
      return git('rev-parse', 'HEAD').trim();
    },
    snapshot: (kind = 'worktree') => {
      git('add', '-A');
      return createSnapshot(root, { kind });
    },
    rel: (path) => relative(root, path),
  };
};
