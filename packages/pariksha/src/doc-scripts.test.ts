import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseConfig, type Config } from './doc-references-config.ts';
import { CONFIG, CONFIG_JSON, createTestRepo, testConfig } from './doc-references.fixture.test.ts';
import { binNames, commandStart, definedScripts, fenceRoles, findScriptProblems, scriptBodies, scriptScopes, spanRanges, type ManifestReader } from './doc-scripts.ts';

const MANIFESTS = CONFIG.scripts.manifests;
const roots: string[] = [];
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An empty directory, removed after the suite. */
const emptyRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'doc-scripts-'));
  roots.push(root);
  return root;
};

const writeTree = (root: string, files: Record<string, string>): void => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
};

/** Manifest text read from disk under `root`. */
const diskRead =
  (root: string): ManifestReader =>
  (path) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined;

/**
 * A manifest set across the scopes `scriptScopes` distinguishes: a named
 * root, a named workspace, one without a name, one without scripts. One bin
 * is installed; a package directory beside `.bin` is not a bin.
 */
const manifestTree = (): string => {
  const root = emptyRoot();
  writeTree(root, {
    'package.json': JSON.stringify({ name: 'root-pkg', scripts: { lint: 'eslint --fix .', 'lint:ci': 'eslint .' } }),
    'apps/server/package.json': JSON.stringify({ name: '@acme/server', scripts: { 'test:coverage': 'vitest --coverage' } }),
    'apps/web/package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
    'packages/shared/package.json': JSON.stringify({ name: '@acme/shared' }),
    'node_modules/.bin/turbo': '',
    'node_modules/left-pad/package.json': '{}',
  });
  return root;
};

const binError = (root: string): string => `cannot read ${join(root, 'node_modules', '.bin')}; install the dependencies before this check`;

/** Enough of a script set to make `definedScripts` meaningful. */
const DEFINED: ReadonlySet<string> = new Set(['lint', 'lint:ci', 'typecheck', 'test:cov', 'turbo', 'eslint']);
const FILE = '.agent/workflows/probe.md';
const NO_SCOPES: ReadonlyMap<string, ReadonlySet<string>> = new Map();

/** The problems `body`, as the one doc, has. */
const problems = (body: string, defined: ReadonlySet<string> = DEFINED, scopes: ReadonlyMap<string, ReadonlySet<string>> = NO_SCOPES, config: Config = CONFIG) =>
  findScriptProblems(config, [FILE], defined, scopes, (path) => (path === FILE ? body : undefined));

describe('binNames', () => {
  it('lists the installed executables', () => {
    assert.deepEqual(binNames(manifestTree()), ['turbo']);
  });

  it('names the bin directory it could not read', () => {
    const root = emptyRoot();
    assert.throws(() => binNames(root), { message: binError(root) });
  });
});

describe('definedScripts', () => {
  it('reads every manifest script and every installed bin, and nothing else', () => {
    const root = manifestTree();
    assert.deepEqual(definedScripts(root, MANIFESTS, diskRead(root)), new Set(['turbo', 'lint', 'lint:ci', 'test:coverage', 'dev']));
  });

  it('names the bin directory it could not read', () => {
    const root = emptyRoot();
    assert.throws(() => definedScripts(root, MANIFESTS, diskRead(root)), { message: binError(root) });
  });
});

describe('scriptScopes', () => {
  it('keys each manifest by directory AND package name, bins in every scope', () => {
    const root = manifestTree();
    const rootScope = new Set(['lint', 'lint:ci', 'turbo']);
    const serverScope = new Set(['test:coverage', 'turbo']);
    const sharedScope = new Set(['turbo']);
    assert.deepEqual(
      scriptScopes(root, MANIFESTS, diskRead(root)),
      new Map([
        ['.', rootScope],
        ['root-pkg', rootScope],
        ['apps/server', serverScope],
        ['@acme/server', serverScope],
        ['apps/web', new Set(['dev', 'turbo'])],
        ['packages/shared', sharedScope],
        ['@acme/shared', sharedScope],
      ]),
    );
  });

  it('names the bin directory it could not read', () => {
    const root = emptyRoot();
    assert.throws(() => scriptScopes(root, MANIFESTS, diskRead(root)), { message: binError(root) });
  });

  it('names the manifest that is not valid JSON', () => {
    const root = manifestTree();
    writeFileSync(join(root, 'apps', 'server', 'package.json'), '{ not json');
    assert.throws(() => scriptScopes(root, MANIFESTS, diskRead(root)), { message: 'apps/server/package.json is not valid JSON — cannot determine which scripts exist' });
  });

  it('reads a manifest that is not an object, or whose name and scripts are not, as naming nothing', () => {
    const root = manifestTree();
    writeFileSync(join(root, 'apps', 'server', 'package.json'), '[]');
    writeFileSync(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: 5, scripts: ['dev'] }));
    const scopes = scriptScopes(root, MANIFESTS, diskRead(root));
    assert.deepEqual([...scopes.keys()], ['.', 'root-pkg', 'apps/server', 'apps/web', 'packages/shared', '@acme/shared']);
    assert.deepEqual(scopes.get('apps/web'), new Set(['turbo']));
  });

  it('keeps every script body as a string', () => {
    const { scripts } = scriptBodies(['package.json'], () => JSON.stringify({ scripts: { n: 1 } }));
    assert.equal(scripts.get('.')?.get('n'), '1');
  });
});

describe('DOC-DRIFT-02: documented scripts', () => {
  /**
   * SCOPE. `pnpm foo` reads the ROOT manifest; it does not search
   * workspaces, so a workspace-only script documented as a bare command does
   * not run. Flattening every manifest into one set could not tell the two
   * apart.
   */
  describe('workspace scope', () => {
    const SCOPES = new Map<string, ReadonlySet<string>>([
      ['.', new Set(['lint', 'test:cov', 'turbo', 'prisma'])],
      ['apps/server', new Set(['test:coverage', 'prisma'])],
      ['@acme/server', new Set(['test:coverage', 'prisma'])],
    ]);
    const withCoverage = new Set([...DEFINED, 'test:coverage']);

    it('catches a workspace-only script written as a root command', () => {
      assert.deepEqual(problems('Coverage:\n\nRun `pnpm test:coverage` to verify.\n', withCoverage, SCOPES), [
        { file: FILE, line: 3, script: 'test:coverage', reason: '`test:coverage` is not a root script — `pnpm test:coverage` resolves the root manifest, so this needs `--filter`' },
      ]);
    });

    it('accepts the same script when the filter names its workspace', () => {
      assert.deepEqual(problems('Run `pnpm --filter @acme/server test:coverage`.\n', withCoverage, SCOPES), []);
    });

    it('catches a filter naming a workspace without that script', () => {
      assert.deepEqual(problems('Run `pnpm --filter . test:coverage`.\n', withCoverage, SCOPES), [
        { file: FILE, line: 1, script: 'test:coverage', reason: '`test:coverage` is not a script of `.` — the filter names a workspace that does not define it' },
      ]);
    });

    it('leaves a filter naming an unknown workspace alone', () => {
      assert.deepEqual(problems('Run `pnpm --filter=@acme/other test:coverage`.\n', withCoverage, SCOPES), []);
    });

    it('accepts a hoisted BIN at the root, which needs no filter', () => {
      // `pnpm turbo` and `pnpm eslint .` run binaries, not scripts.
      assert.deepEqual(problems('Run `pnpm turbo run build`.\n', DEFINED, SCOPES), []);
    });

    it('is inert when the scope map is empty', () => {
      assert.deepEqual(problems('Run `pnpm test:coverage`.\n', withCoverage), []);
    });
  });

  it('catches a script no workspace defines', () => {
    assert.deepEqual(problems('Before finalizing:\nRun `pnpm validate:prds` first.\n'), [
      { file: FILE, line: 2, script: 'validate:prds', reason: 'no workspace defines a `validate:prds` script — this step runs nothing' },
    ]);
  });

  it('catches `pnpm lint` used as a verification step', () => {
    // The script EXISTS, so a does-it-exist check passes it. It auto-fixes,
    // so it mutates the tree it is supposed to be verifying.
    assert.deepEqual(problems('Checks:\nVerify with `pnpm lint` and `pnpm typecheck`.\n'), [
      { file: FILE, line: 2, script: 'lint', reason: '`lint` MUTATES the tree (it auto-fixes) — a verification step must use `lint:ci`' },
    ]);
  });

  it('holds `lint:fix` and `format` to their read-only forms too', () => {
    assert.deepEqual(
      problems('Verify with `pnpm lint:fix`.\nCheck with `pnpm format`.\n', new Set([...DEFINED, 'lint:fix', 'format'])).map((p) => p.reason),
      ['`lint:fix` MUTATES the tree (it auto-fixes) — a verification step must use `lint:ci`', '`format` MUTATES the tree (it auto-fixes) — a verification step must use `format:check`'],
    );
  });

  it('reads pnpm text as prose when its backtick is never closed', () => {
    assert.deepEqual(problems('Run `pnpm validate:prds before merging.\n'), []);
  });

  it('reads prose pnpm as prose even when a code span follows it', () => {
    assert.deepEqual(problems('pnpm validate:prds is gone; use `pnpm lint:ci`.\n'), []);
  });

  for (const [script, safer] of [
    ['lint:fix', 'lint:ci'],
    ['format', 'format:check'],
  ] as const) {
    it(`catches \`pnpm ${script}\` used as a check and names \`${safer}\` as its safe twin`, () => {
      assert.deepEqual(problems(`Check with \`pnpm ${script}\`.\n`, new Set([...DEFINED, script, safer])), [
        { file: FILE, line: 1, script, reason: `\`${script}\` MUTATES the tree (it auto-fixes) — a verification step must use \`${safer}\`` },
      ]);
    });
  }

  it('accepts `pnpm lint:ci`, which is the fix', () => {
    assert.deepEqual(problems('Verify with `pnpm lint:ci`.\n'), []);
  });

  it('accepts a bare binary from node_modules/.bin', () => {
    assert.deepEqual(problems('Run `pnpm turbo run test` then `pnpm eslint .`.\n'), []);
  });

  it('ignores pnpm mentioned in prose rather than as a command', () => {
    assert.deepEqual(problems(['If a command fails to execute (e.g., pnpm not found), STOP.', 'The verdict is the exit code (Vitest/pnpm exit non-zero on failure).', ''].join('\n')), []);
  });

  it('reads commands inside fenced blocks, where most of them live', () => {
    assert.equal(problems(['```bash', 'pnpm validate:prds', '```', ''].join('\n')).length, 1);
  });

  it('does not flag pnpm subcommands as missing scripts', () => {
    assert.deepEqual(problems('Run `pnpm install --frozen-lockfile`.\n'), []);
  });

  it('throws when the bin directory is unreadable, rather than passing', () => {
    // A wildcard here would make every name pass: a pass while scanning nothing.
    const root = join(emptyRoot(), 'nonexistent');
    assert.throws(() => definedScripts(root, MANIFESTS, diskRead(root)), /install the dependencies/);
  });

  it('throws when a manifest is malformed, rather than disabling itself', () => {
    const root = emptyRoot();
    writeTree(root, { 'node_modules/.bin/.keep': '', 'package.json': '{ not json' });
    assert.throws(() => definedScripts(root, MANIFESTS, diskRead(root)), /not valid JSON/);
  });

  it('skips a file it cannot read, and a line carrying the exemption marker', () => {
    assert.deepEqual(findScriptProblems(CONFIG, ['docs/gone.md'], DEFINED, NO_SCOPES, () => undefined), []);
    assert.deepEqual(problems('Run `pnpm validate:prds`. <!-- doc-ref-ok: retired on purpose -->\n'), []);
  });
});

const MANIFEST = JSON.stringify({
  name: 'root',
  scripts: { gate: 'tsx scripts/gate.ts', tool: 'python3 scripts/tool.py', 'test:db': 'tsx scripts/test-db.ts vitest run', 'lint:ci': 'eslint .', wrapped: 'FOO=1 pnpm exec tsx scripts/gate.ts' },
});
const SERVER_MANIFEST = JSON.stringify({ name: '@acme/server', scripts: { 'validate:prds': 'tsx scripts/validate-prds.ts' } });
const XML = '.agent/skills/sync/run-quality-checks.xml';

/** The script problems of `doc` at XML in a repo with the two manifests; `scoped` false runs without a scope map. */
const commandRepo = (doc: string, scoped = true) => {
  const repo = createTestRepo({ 'package.json': MANIFEST, 'apps/server/package.json': SERVER_MANIFEST, [XML]: doc });
  const snapshot = repo.snapshot();
  const read = (path: string): string | undefined => snapshot.read(path);
  return findScriptProblems(CONFIG, [XML], definedScripts(repo.root, MANIFESTS, read), scoped ? scriptScopes(repo.root, MANIFESTS, read) : NO_SCOPES, read);
};

const fence = (...lines: string[]): string => ['<step>', '```bash', ...lines, '```', '</step>', ''].join('\n');

describe('DOC-DRIFT-02: a workspace-only script run from the root', () => {
  // A sync skill's quality step ran `pnpm validate:prds`, which only a
  // workspace defines, so the root command failed before it began.
  it('fails the example for the intended reason', () => {
    const found = commandRepo(fence('pnpm validate:prds'));
    assert.equal(found.length, 1);
    assert.equal(found[0]?.file, XML);
    assert.equal(found[0]?.line, 3);
    assert.match(found[0]?.reason ?? '', /not a root script/);
  });

  it('passes the corrected command', () => {
    assert.deepEqual(commandRepo(fence('pnpm --filter @acme/server validate:prds')), []);
  });

  it('near-miss: the same words in a shell comment are prose', () => {
    assert.deepEqual(commandRepo(fence('# pnpm validate:prds is server-only')), []);
  });

  it('removing the guard flips it: without the scope map it passes', () => {
    assert.deepEqual(commandRepo(fence('pnpm validate:prds'), false), []);
  });
});

describe('quoted comments and operators', () => {
  // Cutting at any ` #` hid the missing script after a quoted `#`.
  it('reads past a quoted `#` to the command after it', () => {
    assert.deepEqual(
      commandRepo(fence('echo "a # b" && pnpm nope')).map((p) => [p.line, p.script]),
      [[3, 'nope']],
    );
  });

  it('near-miss: an unquoted `#` still starts a comment', () => {
    assert.deepEqual(commandRepo(fence('echo a # && pnpm nope')), []);
  });

  // A `#` no longer cuts the line, so a quoted separator before `pnpm` must not start a command either.
  it('reads a quoted separator in a fence as no command start', () => {
    assert.deepEqual(
      commandRepo(fence('echo "a ; pnpm nope" \'&& pnpm nope\'', 'echo "a" ; pnpm gone')).map((p) => [p.line, p.script]),
      [[4, 'gone']],
    );
  });

  it('near-miss: an apostrophe in prose quotes nothing', () => {
    assert.deepEqual(
      commandRepo("<step>\nIt's `x; pnpm nope`, isn't it.\n</step>\n").map((p) => [p.line, p.script]),
      [[2, 'nope']],
    );
  });
});

describe('fenceRoles', () => {
  it('opens and closes fences by CommonMark’s rule', () => {
    assert.deepEqual(fenceRoles(['text', '```bash', '~~~', '``', '```` \t', '``` a`b', '   ~~~~\r', '~~~\r', '~~~~~ \r', '    ```', '```', 'pnpm x', '```', '~~~']), [
      'prose',
      'fence',
      'code',
      'code',
      'fence',
      'prose',
      'fence',
      'code',
      'fence',
      'prose',
      'fence',
      'code',
      'fence',
      'fence',
    ]);
  });
});

describe('spanRanges', () => {
  it('gives each inline code span between its delimiters', () => {
    assert.deepEqual(spanRanges('a `b` and ``c d`` e'), [
      [3, 4],
      [12, 15],
    ]);
    assert.deepEqual(spanRanges('no code'), []);
  });
});

describe('script manifests and bins', () => {
  const PATHS = ['package.json', 'apps/server/package.json', 'apps/mobile/package.json', 'apps/web/package.json', 'packages/shared/package.json', 'packages/test-utils/package.json', 'packages/tools/package.json'];
  const BODIES = new Map<string, unknown>([
    ['package.json', { name: 'root', scripts: { a: 'x' } }],
    ['apps/server/package.json', { name: '@acme/server', scripts: { b: 'y' } }],
    ['apps/mobile/package.json', { scripts: { c: 'z' } }],
    ['apps/web/package.json', { name: '@acme/web' }],
    ['packages/shared/package.json', { scripts: { d: 'd' } }],
    ['packages/test-utils/package.json', { scripts: { e: 'e' } }],
    ['packages/tools/package.json', { scripts: { f: 'f' } }],
  ]);
  const read: ManifestReader = (path) => (BODIES.has(path) ? JSON.stringify(BODIES.get(path)) : undefined);
  const installed = (): string => {
    const root = emptyRoot();
    writeTree(root, { 'node_modules/.bin/turbo': '' });
    return root;
  };
  const SCOPES: Record<string, [string, string[]]> = {
    '.': ['.', ['a']],
    root: ['.', ['a']],
    'apps/server': ['apps/server', ['b']],
    '@acme/server': ['apps/server', ['b']],
    'apps/mobile': ['apps/mobile', ['c']],
    'apps/web': ['apps/web', []],
    '@acme/web': ['apps/web', []],
    'packages/shared': ['packages/shared', ['d']],
    'packages/test-utils': ['packages/test-utils', ['e']],
    'packages/tools': ['packages/tools', ['f']],
  };

  it('knows every manifest’s scripts and every bin', () => {
    assert.deepEqual([...definedScripts(installed(), PATHS, read)].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'turbo']);
  });

  it('scopes scripts by workspace directory and package name, bins everywhere', () => {
    const scopes = scriptScopes(installed(), PATHS, read);
    assert.deepEqual(Object.fromEntries([...scopes].map(([key, names]) => [key, [...names]])), Object.fromEntries(Object.entries(SCOPES).map(([key, [, names]]) => [key, [...names, 'turbo']])));
  });

  it('keeps script bodies and manifest directories per scope', () => {
    const { scripts, scopeDirs } = scriptBodies(PATHS, read);
    assert.deepEqual(Object.fromEntries([...scripts].map(([key, bodies]) => [key, [scopeDirs.get(key), [...bodies.keys()]]])), SCOPES);
    assert.equal(scripts.get('.')?.get('a'), 'x');
  });

  it('names the bin directory it could not read', () => {
    const missing = join(installed(), 'nowhere');
    assert.throws(() => definedScripts(missing, PATHS, read), { message: binError(missing) });
    assert.throws(() => scriptScopes(missing, PATHS, read), { message: binError(missing) });
  });

  it('names a manifest that does not parse', () => {
    const broken: ManifestReader = (path) => (path === 'apps/web/package.json' ? '{' : read(path));
    const message = 'apps/web/package.json is not valid JSON — cannot determine which scripts exist';
    assert.throws(() => definedScripts(installed(), PATHS, broken), { message });
    assert.throws(() => scriptScopes(installed(), PATHS, broken), { message });
    assert.throws(() => scriptBodies(PATHS, broken), { message });
  });
});

describe('DOC-DRIFT-02 command positions', () => {
  const BUILTIN = [
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
  ];

  for (const command of BUILTIN) {
    it(`takes \`pnpm ${command}\` as pnpm’s own command`, () => {
      assert.deepEqual(problems(`Run \`pnpm ${command}\`.\n`), []);
    });
  }

  it('knows every pnpm subcommand it exempts, by name, in one document', () => {
    // Spelled out here rather than read from the source, so a dropped entry
    // shows up as that subcommand reported as a missing script.
    assert.deepEqual(problems(BUILTIN.map((name) => `Run \`pnpm ${name}\`.`).join('\n')), []);
  });

  it('reports the line and the whole reason', () => {
    assert.deepEqual(problems('x\n`pnpm validate:prds`\nVerify with `pnpm lint`.\n'), [
      { file: FILE, line: 2, script: 'validate:prds', reason: 'no workspace defines a `validate:prds` script — this step runs nothing' },
      { file: FILE, line: 3, script: 'lint', reason: '`lint` MUTATES the tree (it auto-fixes) — a verification step must use `lint:ci`' },
    ]);
  });

  it('counts only an invocation wholly inside a code span', () => {
    assert.deepEqual(problems('pnpm validate:prds then `x`\n'), []);
    assert.deepEqual(problems('`pnpm` validate:prds\n'), []);
    assert.deepEqual(problems('`pnpm --filter x` validate:prds\n'), []);
    assert.equal(problems('`pnpm validate:prds`\n').length, 1);
  });

  it('skips a script family and a tilde fence’s info string', () => {
    assert.deepEqual(problems('`pnpm dev:*` and `pnpm test:<name>`\n'), []);
    assert.deepEqual(problems('~~~ `pnpm validate:prds`\n~~~\n'), []);
  });

  it('starts a command after a separator, a prompt, env assignments or a builtin lead word', () => {
    for (const lead of ['', 'a && ', 'a || ', 'a; ', 'a | ', '$ ', '(', 'FOO=1 BAR=x ', 'time ', 'env ', 'then ', 'do ', 'x -- ', 'pnpm exec ']) {
      assert.deepEqual(
        problems(`\`${lead}pnpm nope\`\n`).map((p) => p.script),
        ['nope'],
        lead,
      );
    }
    assert.deepEqual(problems('`echo pnpm nope`\n'), []);
  });
});

describe('the config decides wrappers, mutating scripts and verification words', () => {
  /** CONFIG with its `scripts` section's `key` replaced outright. */
  const withScripts = (over: Record<string, unknown>): Config => parseConfig(JSON.stringify({ ...CONFIG_JSON, scripts: { ...CONFIG_JSON.scripts, ...over } }));

  it('a custom wrapper starts a command; without it the same line is not one', () => {
    const line = 'Run `sandboxed pnpm nope`.\n';
    assert.deepEqual(
      problems(line, DEFINED, NO_SCOPES, testConfig({ scripts: { wrappers: ['sandboxed'] } })).map((p) => p.script),
      ['nope'],
    );
    assert.deepEqual(problems(line, DEFINED, NO_SCOPES, withScripts({ wrappers: [] })), []);
  });

  it('a wrapper is matched literally, not as a pattern', () => {
    const config = withScripts({ wrappers: ['x.y'] });
    assert.equal(problems('Run `x.y pnpm nope`.\n', DEFINED, NO_SCOPES, config).length, 1);
    assert.deepEqual(problems('Run `xzy pnpm nope`.\n', DEFINED, NO_SCOPES, config), []);
  });

  it('commandStart lists the wrappers among the lead words', () => {
    assert.match('sandboxed ', commandStart(['sandboxed']));
    assert.doesNotMatch('sandboxed ', commandStart([]));
    assert.match('a && FOO=1 ', commandStart([]));
  });

  it('a custom mutating map names its own scripts and safe twins, and only those', () => {
    const config = withScripts({ mutating: { fmt: 'fmt:check' } });
    const defined = new Set([...DEFINED, 'fmt']);
    assert.deepEqual(problems('Verify with `pnpm fmt`.\n', defined, NO_SCOPES, config), [
      { file: FILE, line: 1, script: 'fmt', reason: '`fmt` MUTATES the tree (it auto-fixes) — a verification step must use `fmt:check`' },
    ]);
    assert.deepEqual(problems('Verify with `pnpm lint`.\n', defined, NO_SCOPES, config), []);
    assert.deepEqual(problems('Verify with `pnpm fmt`.\n', defined, NO_SCOPES, withScripts({ mutating: {} })), []);
  });

  it('a custom verification pattern decides which lines are verification steps', () => {
    const config = withScripts({ verification: { pattern: 'smoke', flags: '' } });
    assert.equal(problems('Smoke: run `pnpm lint`.\n', DEFINED, NO_SCOPES, config).length, 0);
    assert.deepEqual(
      problems('Before the smoke run, `pnpm lint`.\n', DEFINED, NO_SCOPES, config).map((p) => p.script),
      ['lint'],
    );
    assert.deepEqual(problems('Verify with `pnpm lint`.\n', DEFINED, NO_SCOPES, config), []);
    assert.equal(problems('Smoke: run `pnpm lint`.\n', DEFINED, NO_SCOPES, withScripts({ verification: { pattern: 'smoke', flags: 'i' } })).length, 1);
  });
});
