// The enforcement-claims subcommand, end to end through `run`, against
// fixture trees with their own flat configs: every refusal (exit 1) and every
// guard (exit 2).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run, type Io } from './cli.ts';

const made: string[] = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

const CONFIG = {
  standards: 'docs/standards',
  workspaces: [
    { dir: '.', probes: ['scripts/probe.ts', 'scripts/probe.test.ts'] },
    { dir: 'apps/api', probes: ['src/probe.ts'] },
  ],
  dispatcher: { path: 'scripts/run-validation.sh' },
  packageRunner: null,
  stageRoots: { hooks: ['.husky'], workflows: ['.github/workflows'], actions: ['.github/actions'] },
  runnable: { prefixes: ['scripts/'], extensions: ['sh', 'ts'], bin: 'node_modules/.bin' },
  workspaceList: { pnpm: 'pnpm-workspace.yaml', turbo: 'turbo.json' },
  tests: { file: '\\.test\\.tsx?$', runner: '\\bvitest\\b|\\s--test\\b' },
};

/** A fixture tree: its config, a flat config per workspace, a dispatcher, and these standards by file name. */
const repo = (standards: Record<string, string>, over: Record<string, string> = {}, config: Record<string, unknown> = CONFIG): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-enforcement-cli-'));
  made.push(root);
  const files: Record<string, string> = {
    'claims.json': JSON.stringify(config),
    'eslint.config.mjs': "export default [{ files: ['**/*.ts'], rules: { 'no-console': 'error' } }];\n",
    'apps/api/eslint.config.mjs': "export default [{ files: ['**/*.ts'], rules: { 'no-console': 'error', 'no-debugger': 'error' } }];\n",
    'scripts/run-validation.sh': 'case "$1" in\n  probe)\n    bash scripts/probe-check.sh\n    ;;\nesac\n',
    'scripts/probe-check.sh': 'exit 0\n',
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
    'turbo.json': '{}\n',
    '.husky/pre-commit': 'bash scripts/run-validation.sh probe\n',
    ...Object.fromEntries(Object.entries(standards).map(([name, frontmatter]) => [`docs/standards/${name}`, `---\n${frontmatter}\n---\n`])),
    ...over,
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

const claims = async (root: string, extra: Partial<Io> = {}, args: string[] = ['--config', 'claims.json']) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['enforcement-claims', '--root', root, ...args], { out: (l) => out.push(l), err: (l) => err.push(l), ...extra }, '0');
  return { code, out, err };
};
const P = 'pariksha enforcement-claims:';
const rule = (id: string, ...lines: string[]): string => [`id: ${id}`, ...lines].join('\n');

describe('run enforcement-claims', () => {
  it('passes, counting the eslint-rule claims and the live validator claims, and skips a deprecated validator', async () => {
    const r = await claims(
      repo({
        'a.md': rule('BP-1', 'enforcement: eslint-rule', 'enforcement_config: no-console', 'applies_to: [apps/api, scripts]'),
        'b.md': rule('BP-2', 'enforcement: guidance'),
        'c.md': rule('BP-3', 'enforcement: validator', 'enforcement_config: run-validation.sh probe'),
        'd.md': rule('BP-4', 'enforcement: validator', 'status: deprecated', 'enforcement_config: run-validation.sh gone'),
        'e.md': rule('BP-5', 'enforcement: eslint-rule', 'enforcement_config: no-debugger', 'applies_to: apps/api'),
      }),
    );
    assert.deepEqual(r, { code: 0, out: [`${P} every eslint-rule claim is real and every validator claim runs at a stage (2 + 1 of 5 rule(s))`], err: [] });
  });

  it('prefixes its lines with the configured id', async () => {
    const r = await claims(repo({ 'a.md': rule('BP-1', 'enforcement: guidance') }, {}, { ...CONFIG, id: 'STD-001' }));
    assert.deepEqual(r.out, ['pariksha enforcement-claims (STD-001): every eslint-rule claim is real and every validator claim runs at a stage (0 + 0 of 1 rule(s))']);
  });

  it('lists each untrue claim on its own line and exits 1', async () => {
    const r = await claims(
      repo(
        {
          'a.md': rule('BP-1', 'enforcement: eslint-rule', 'enforcement_config: local/never-written'),
          'b.md': rule('BP-2', 'enforcement: eslint-rule', 'enforcement_config: no-debugger', 'applies_to: [apps/api, scripts]'),
          'c.md': rule('BP-3', 'enforcement: guidance', 'partial_gates: Reviewer eyeballs it'),
          'd.md': rule('BP-4', 'enforcement: validator', 'enforcement_config: run-validation.sh no-such'),
          'e.md': rule('BP-5', 'enforcement: validator', 'enforcement_script: scripts/unrun.sh'),
        },
        { 'scripts/unrun.sh': 'exit 0\n' },
      ),
    );
    assert.equal(r.code, 1);
    assert.deepEqual(r.out, []);
    assert.deepEqual(r.err, [
      `${P} docs/standards/a.md (BP-1): \`local/never-written\` (enforcement_config) is not enabled in ANY workspace config — the claim is false`,
      `${P} docs/standards/b.md (BP-2): \`no-debugger\` (enforcement_config) is enabled elsewhere but NOT in apps/api, scripts, which is where this rule claims to apply`,
      `${P} docs/standards/c.md (BP-3): \`Reviewer eyeballs it\` (partial_gates) names no rule this gate can adjudicate — a partial gate that cannot be checked is not a gate`,
      `${P} docs/standards/d.md (BP-4): \`no-such\` is not a case in scripts/run-validation.sh — the command does not exist`,
      `${P} docs/standards/d.md (BP-4): \`run-validation.sh no-such\` claims validator enforcement but names no script — nothing here can run`,
      `${P} docs/standards/e.md (BP-5): \`scripts/unrun.sh\` is never run by a hook or workflow — the claim names a validator nothing calls`,
      `${P} 6 untrue enforcement claim(s); a standard whose enforcement is described wrongly reads as enforced while nothing runs`,
    ]);
  });

  it('refuses a validator whose target exists when no stage calls it', async () => {
    const r = await claims(repo({ 'a.md': rule('BP-1', 'enforcement: validator', 'enforcement_config: run-validation.sh probe') }, { '.husky/pre-commit': 'echo "bash scripts/run-validation.sh probe"\n' }));
    assert.equal(r.code, 1);
    assert.equal(r.err[0], `${P} docs/standards/a.md (BP-1): \`scripts/probe-check.sh\` is never run by a hook or workflow — the claim names a validator nothing calls`);
  });

  describe('a linterOptions.noInlineConfig claim', () => {
    const claim = { 'a.md': rule('BP-1', 'enforcement: eslint-rule', 'enforcement_config: linterOptions.noInlineConfig, no-console', 'applies_to: [scripts]') };
    const withOption = (value: boolean): Record<string, string> => ({ 'eslint.config.mjs': `export default [{ files: ['**/*.ts'], linterOptions: { noInlineConfig: ${String(value)} }, rules: { 'no-console': 'error' } }];\n` });

    it('passes where the config sets it', async () => {
      assert.equal((await claims(repo(claim, withOption(true)))).code, 0);
    });

    it('fails where the config leaves inline directives on', async () => {
      const r = await claims(repo(claim, withOption(false)));
      assert.equal(r.code, 1);
      assert.equal(r.err[0], `${P} docs/standards/a.md (BP-1): \`linterOptions.noInlineConfig\` (enforcement_config) is not enabled in ANY workspace config — the claim is false`);
    });
  });

  it('exits 2 when the scan finds no standard', async () => {
    const r = await claims(repo({ 'a.md': 'id: BP-1' }));
    assert.deepEqual(r, { code: 2, out: [], err: [`${P} no standard under docs/standards declares an enforcement — the scan failed; nothing was checked, so this is not a pass`] });
  });

  it('exits 2 on a usage error: no --config, or a flag it does not take', async () => {
    for (const args of [[], ['--config', 'claims.json', '--base', 'main']]) {
      const r = await claims(repo({}), {}, args);
      assert.equal(r.code, 2);
      assert.match(r.err[0] ?? '', /^usage: /);
    }
  });

  it('exits 2 on a config that is missing or bad', async () => {
    const missing = await claims(repo({}), {}, ['--config', 'absent.json']);
    assert.equal(missing.code, 2);
    assert.match(missing.err[0] ?? '', /^pariksha enforcement-claims: ENOENT.*; nothing was checked, so this is not a pass$/);
    const bad = await claims(repo({}, {}, { ...CONFIG, extra: true }));
    assert.deepEqual(bad.err, [`${P} unknown key "extra"; nothing was checked, so this is not a pass`]);
  });

  it('exits 2 without ESLint, naming the peer', async () => {
    const r = await claims(repo({ 'a.md': rule('BP-1', 'enforcement: guidance') }, {}, { ...CONFIG, id: 'STD-001' }), { eslint: () => Promise.resolve('needs the eslint package') });
    assert.deepEqual(r, { code: 2, out: [], err: ['pariksha enforcement-claims (STD-001): needs the eslint package'] });
  });

  it('exits 2 when a workspace config does not load, rather than reading its rules as off', async () => {
    const r = await claims(repo({ 'a.md': rule('BP-1', 'enforcement: guidance') }, { 'apps/api/eslint.config.mjs': 'export default [' }));
    assert.equal(r.code, 2);
    assert.match(r.err[0] ?? '', /^pariksha enforcement-claims: no probe of workspace "apps\/api" resolves a config: /);
  });
});
