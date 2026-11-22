// The security checks through the command line: license-check and
// codeql-baseline, their flags and their `.pariksha.json` entries.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CONFIGURABLE, run } from './cli.ts';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A git repository holding `files`, outside any other, so its own `.pariksha.json` is the one read. */
const repo = (files: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-sec-')));
  temps.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

const capture = (cwd: string, licenses?: (root: string) => string) => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: () => cwd, ...(licenses === undefined ? {} : { licenses }) }, out, err };
};

const SETTINGS = { allow: ['MIT', 'ISC'], packages: { 'tool@1.0.0': 'declares no licence; its LICENSE file is MIT' } };
const pnpmOutput = (groups: Record<string, [string, string][]>): string => JSON.stringify(Object.fromEntries(Object.entries(groups).map(([licence, list]) => [licence, list.map(([name, version]) => ({ name, versions: [version] }))])));
const CLEAN = pnpmOutput({ MIT: [['a', '1.0.0']], Unknown: [['tool', '1.0.0']] });
const COPYLEFT = pnpmOutput({ MIT: [['a', '1.0.0']], 'GPL-3.0-only': [['copyleft', '2.0.0']] });

describe('run license-check', () => {
  it('is configurable from .pariksha.json, and so is codeql-baseline', () => {
    assert.ok(CONFIGURABLE.includes('license-check') && CONFIGURABLE.includes('codeql-baseline'));
  });

  it('judges pnpm’s list at the root by the inline entry’s allow list', () => {
    const root = repo({ '.pariksha.json': JSON.stringify({ checks: { 'license-check': SETTINGS } }) });
    const roots: string[] = [];
    const ok = capture(root, (at) => {
      roots.push(at);
      return CLEAN;
    });
    assert.equal(run(['license-check', '--root', root], ok.io, '1.0.0', {}), 0);
    assert.deepEqual(ok.out, ['license-check: 2 packages, every licence allowed exactly']);
    assert.deepEqual(roots, [root]);
    const refused = capture(root, () => COPYLEFT);
    assert.equal(run(['license-check'], refused.io, '1.0.0', {}), 1);
    assert.deepEqual(refused.out, ['license-check: 1 of 2 packages have a licence not on the allow list:', '  copyleft@2.0.0  GPL-3.0-only']);
  });

  it('reads a saved report with --report, and a settings file with --config, without running pnpm', () => {
    const root = repo({ 'licences.json': JSON.stringify(SETTINGS), 'report.json': COPYLEFT });
    const c = capture(root, () => {
      throw new Error('pnpm must not run');
    });
    assert.equal(run(['license-check', '--config', 'licences.json', '--report', join(root, 'report.json'), '--root', root], c.io, '1.0.0', {}), 1);
    assert.equal(c.out[1], '  copyleft@2.0.0  GPL-3.0-only');
  });

  it('reads a file entry from the config file’s folder', () => {
    const root = repo({ 'cfg/licences.json': JSON.stringify(SETTINGS), '.pariksha.json': '{"checks": {"license-check": "cfg/licences.json"}}' });
    assert.equal(run(['license-check'], capture(root, () => CLEAN).io, '1.0.0', {}), 0);
  });

  it('refuses to run with no allow list, naming where to set one', () => {
    const root = repo({});
    const c = capture(root, () => CLEAN);
    assert.equal(run(['license-check', '--root', root], c.io, '1.0.0', {}), 2);
    assert.deepEqual(c.err, ['pariksha license-check: no allow list: name a settings file with --config or set checks.license-check in .pariksha.json; nothing was checked, so this is not a pass']);
  });

  it('exits 2 on settings it cannot read, and on output pnpm could not give', () => {
    const root = repo({ '.pariksha.json': JSON.stringify({ checks: { 'license-check': { allow: [] } } }) });
    const bad = capture(root, () => CLEAN);
    assert.equal(run(['license-check'], bad.io, '1.0.0', {}), 2);
    assert.match(bad.err[0] ?? '', /^pariksha license-check: "allow" must be a non-empty list of licence names, none blank or with surrounding spaces; nothing was checked, so this is not a pass$/);
    const good = repo({ '.pariksha.json': JSON.stringify({ checks: { 'license-check': SETTINGS } }) });
    const empty = capture(good, () => '{}');
    assert.equal(run(['license-check'], empty.io, '1.0.0', {}), 2);
    assert.deepEqual(empty.err, ['license-check: pnpm licenses listed no packages to judge']);
  });

  it('refuses an unknown flag', () => {
    const c = capture(repo({}));
    assert.equal(run(['license-check', '--allow', 'MIT'], c.io, '1.0.0', {}), 2);
    assert.match(c.err[0] ?? '', /^usage: /);
  });
});

/** A CodeQL log with one error-level result per `[rule, file, hash]`. */
const scan = (results: [string, string, string][]): string =>
  JSON.stringify({
    runs: [
      {
        tool: { driver: { rules: [{ id: 'js/sql-injection', defaultConfiguration: { level: 'error' } }] } },
        results: results.map(([ruleId, uri, hash]) => ({ ruleId, message: { text: 'm' }, partialFingerprints: { primaryLocationLineHash: hash }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 4 } } }] })),
      },
    ],
  });

describe('run codeql-baseline', () => {
  it('writes the baseline at the default path, then passes the same scan and fails a new alert', () => {
    const root = repo({ 'old.sarif': scan([['js/sql-injection', 'a.ts', 'h1']]), 'new.sarif': scan([['js/sql-injection', 'a.ts', 'h1'], ['js/sql-injection', 'b.ts', 'h2']]) });
    const wrote = capture(root);
    assert.equal(run(['codeql-baseline', '--write', join(root, 'old.sarif'), '--root', root], wrote.io, '1.0.0', {}), 0);
    assert.deepEqual(wrote.out, ['Wrote 1 alert(s) to .github/codeql/error-baseline.json']);
    assert.match(readFileSync(join(root, '.github/codeql/error-baseline.json'), 'utf8'), /"fingerprint": "js\/sql-injection\|a\.ts\|h1"/);
    assert.equal(run(['codeql-baseline', '--check', join(root, 'old.sarif'), '--root', root], capture(root).io, '1.0.0', {}), 0);
    const refused = capture(root);
    assert.equal(run(['codeql-baseline', '--check', join(root, 'new.sarif'), '--root', root], refused.io, '1.0.0', {}), 1);
    assert.deepEqual(refused.out, ['CodeQL: 2 error-level alert(s), 1 in the baseline', 'CodeQL: 1 new error-level alert(s):', '  js/sql-injection  b.ts:4  m']);
  });

  it('reads the baseline path from .pariksha.json, from the config file’s folder, and --baseline wins', () => {
    const root = repo({ 'scan.sarif': scan([['js/sql-injection', 'a.ts', 'h1']]), 'empty.json': '{"description": "", "alerts": []}', '.pariksha.json': JSON.stringify({ checks: { 'codeql-baseline': { baseline: 'security/baseline.json' } } }) });
    const wrote = capture(root);
    assert.equal(run(['codeql-baseline', '--write', join(root, 'scan.sarif'), '--root', root], wrote.io, '1.0.0', {}), 0);
    assert.deepEqual(wrote.out, ['Wrote 1 alert(s) to security/baseline.json']);
    assert.equal(run(['codeql-baseline', '--check', join(root, 'scan.sarif'), '--root', root], capture(root).io, '1.0.0', {}), 0);
    assert.equal(run(['codeql-baseline', '--check', join(root, 'scan.sarif'), '--baseline', 'empty.json', '--root', root], capture(root).io, '1.0.0', {}), 1);
  });

  it('resolves the baseline entry from a config file in another folder than --root', () => {
    const root = repo({ 'scan.sarif': scan([['js/sql-injection', 'a.ts', 'h1']]), 'cfg/settings.json': JSON.stringify({ checks: { 'codeql-baseline': { baseline: 'security/baseline.json' } } }) });
    const env = { PARIKSHA_CONFIG: join(root, 'cfg/settings.json') };
    const wrote = capture(root);
    assert.equal(run(['codeql-baseline', '--write', join(root, 'scan.sarif'), '--root', root], wrote.io, '1.0.0', env), 0);
    assert.deepEqual(wrote.out, ['Wrote 1 alert(s) to cfg/security/baseline.json']);
    assert.match(readFileSync(join(root, 'cfg/security/baseline.json'), 'utf8'), /"fingerprint": "js\/sql-injection\|a\.ts\|h1"/);
    assert.equal(run(['codeql-baseline', '--check', join(root, 'scan.sarif'), '--root', root], capture(root).io, '1.0.0', env), 0);
  });

  it('exits 2 with no baseline to read', () => {
    const root = repo({ 'scan.sarif': scan([]) });
    const c = capture(root);
    assert.equal(run(['codeql-baseline', '--check', join(root, 'scan.sarif'), '--root', root], c.io, '1.0.0', {}), 2);
    assert.match(c.err[0] ?? '', /^pariksha codeql-baseline: cannot read the baseline \.github\/codeql\/error-baseline\.json: ENOENT/);
  });

  it('asks for exactly one of --check and --write', () => {
    const root = repo({});
    for (const args of [[], ['--check', 'a.sarif', '--write', 'a.sarif'], ['--root', root], ['--check']]) {
      const c = capture(root);
      assert.equal(run(['codeql-baseline', ...args], c.io, '1.0.0', {}), 2, args.join(' '));
      assert.match(c.err[0] ?? '', /^usage: .*\n.*pariksha codeql-baseline \(--check <results\.sarif> \| --write <results\.sarif>\)/s);
    }
  });

  it('refuses a baseline entry that is not a path', () => {
    const root = repo({ '.pariksha.json': JSON.stringify({ checks: { 'codeql-baseline': { baseline: 1 } } }) });
    const c = capture(root);
    assert.equal(run(['codeql-baseline', '--check', 'x.sarif'], c.io, '1.0.0', {}), 2);
    assert.match(c.err[0] ?? '', /checks\.codeql-baseline\.baseline must be a string \(pariksha 1\.0\.0\)/);
  });
});
