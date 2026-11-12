/**
 * Fixtures with exactly one thing wrong must fail: each reproduces a way pnpm
 * 11 can silently disarm a repository's security overrides or patches, every
 * one with a green `pnpm install`. Ported case for case from the original's
 * suite; its real-repository cases run here on this repository.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run } from './cli.ts';
import { checkPnpmSettings, DEFAULT_PNPM_CONFIG, parseExclusionExpiry, parsePnpmConfig, parseSelector, releaseAgeExclusionComment, splitNameVersion, type PnpmConfig } from './pnpm-settings.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const OWN: PnpmConfig = { id: 'CFG-005', ownScopes: ['@acme/*', '@veda-hq/*'] };

const temps: string[] = [];
/** A fresh temporary directory, removed when this file's tests end. */
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A minimal repository root with the three inputs. */
const fixture = (opts: { pkg?: unknown; workspace?: string; lock?: string; patchFiles?: string[] } = {}): string => {
  const root = temp('pariksha-pnpm-');
  writeFileSync(join(root, 'package.json'), JSON.stringify(opts.pkg ?? { name: 'fx' }, null, 2));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), opts.workspace ?? ['overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'patchedDependencies:', '  foo@1.0.0: patches/foo@1.0.0.patch', ''].join('\n'));
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    opts.lock ?? ["lockfileVersion: '9.0'", 'overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'patchedDependencies:', '  foo@1.0.0:', '    hash: abc', '    path: patches/foo@1.0.0.patch', 'packages:', '  tar@7.5.21: {}', ''].join('\n'),
  );
  for (const p of opts.patchFiles ?? ['patches/foo@1.0.0.patch']) {
    mkdirSync(join(root, dirname(p)), { recursive: true });
    writeFileSync(join(root, p), 'diff --git a/x b/x\n');
  }
  return root;
};

const check = (root: string, config: PnpmConfig = OWN, now?: number) => checkPnpmSettings(root, config, now);
const failures = (root: string) => check(root).failures.join('\n');

const PATCH_HASH = createHash('sha256').update('diff --git a/x b/x\n').digest('hex');

const workspaceWith = (...excludeLines: string[]): string => ['overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'patchedDependencies:', '  foo@1.0.0: patches/foo@1.0.0.patch', ...excludeLines, ''].join('\n');

/** The default lockfile, its patch hash real, plus extra resolved packages. */
const lockWith = (...extraPackages: string[]): string =>
  ["lockfileVersion: '9.0'", 'overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'patchedDependencies:', '  foo@1.0.0:', `    hash: ${PATCH_HASH}`, '    path: patches/foo@1.0.0.patch', 'packages:', '  tar@7.5.21: {}', ...extraPackages, ''].join('\n');

const lockBlocks = (overrides: string[], patches: string[]): string => ["lockfileVersion: '9.0'", 'overrides:', ...overrides, 'patchedDependencies:', ...patches, 'packages:', '  tar@7.5.21: {}', ''].join('\n');

const DOCUMENTED = ['# WHY: pinned inside the cooling-off window by the evidence work.', '# EXPIRES: 2099-01-01T00:00Z — delete both lines once the pins age out.'];
const EXPIRED = ['# WHY: pinned inside the cooling-off window by the evidence work.', '# EXPIRES: 2026-09-02T18:54Z, 1440 minutes after publication.'];

describe('pnpm-settings: this repository', () => {
  it('passes, and is no vacuous pass: it has a lockfile to read', () => {
    const report = check(REPO_ROOT, DEFAULT_PNPM_CONFIG);
    assert.deepEqual(report.failures, []);
    assert.equal(report.releaseAgeExclusionCount, 0);
  });
});

describe('pnpm-settings: single-defect fixtures fail', () => {
  it('rejects settings stranded in package.json#pnpm', () => {
    assert.match(failures(fixture({ pkg: { name: 'fx', pnpm: { overrides: { 'tar@<=7.5.20': '>=7.5.21 <8' } } } })), /package\.json#pnpm still declares .*overrides/);
  });

  it('rejects every pnpm-11-ignored key, not just overrides', () => {
    assert.match(failures(fixture({ pkg: { name: 'fx', pnpm: { onlyBuiltDependencies: ['esbuild'] } } })), /onlyBuiltDependencies/);
  });

  it('rejects a lockfile whose overrides block was dropped entirely', () => {
    assert.match(failures(fixture({ lock: ["lockfileVersion: '9.0'", 'packages:', '  tar@7.5.21: {}', ''].join('\n') })), /declares 1 overrides but pnpm-lock\.yaml records none/);
  });

  it('rejects an override that is declared but did not take effect', () => {
    const lock = ["lockfileVersion: '9.0'", 'overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'patchedDependencies:', '  foo@1.0.0:', '    path: patches/foo@1.0.0.patch', 'packages:', '  tar@7.5.19: {}', ''].join('\n');
    assert.match(failures(fixture({ lock })), /did not take effect: tar@7\.5\.19/);
  });

  it('rejects a patch that is declared but missing from the lockfile', () => {
    const lock = ["lockfileVersion: '9.0'", 'overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'packages:', '  tar@7.5.21: {}', ''].join('\n');
    assert.match(failures(fixture({ lock })), /patch `foo@1\.0\.0`.*absent from the lockfile/);
  });

  it('reads the pnpm 11 patch format, where the entry is a bare hash', () => {
    const report = check(fixture({ lock: ["lockfileVersion: '9.0'", 'overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'patchedDependencies:', `  foo@1.0.0: ${PATCH_HASH}`, 'packages:', '  tar@7.5.21: {}', ''].join('\n') }));
    assert.deepEqual(report.failures, []);
    assert.equal(report.patchCount, 1);
  });

  it('rejects a patch file edited without re-running patch-commit', () => {
    const lock = ["lockfileVersion: '9.0'", 'overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'patchedDependencies:', `  foo@1.0.0: ${'d'.repeat(64)}`, 'packages:', '  tar@7.5.21: {}', ''].join('\n');
    assert.match(failures(fixture({ lock })), /content does not match the lockfile/);
  });

  it('rejects a patch whose .patch file is not on disk', () => {
    assert.match(failures(fixture({ patchFiles: [] })), /patch file for `foo@1\.0\.0` does not exist on disk/);
  });

  it('fails closed when an input file is missing', () => {
    assert.match(failures(temp('pariksha-pnpm-empty-')), /required file missing/);
  });

  it('fails cleanly on a malformed pnpm-workspace.yaml rather than throwing', () => {
    assert.match(failures(fixture({ workspace: 'overrides:\n  bad: >=1.0.0\n' })), /pnpm-workspace\.yaml is not valid YAML/);
  });

  const PACKAGE_MANAGER_DOCUMENT = ['---', "lockfileVersion: '9.0'", 'importers:', '  .:', '    packageManagerDependencies:', '      pnpm:', '        specifier: 12.9.0', '        version: 12.9.0', 'packages:', '  tar@7.5.19: {}', '', '---'];

  it('reads the project document of a pnpm 12 two-document lockfile', () => {
    const lock = [...PACKAGE_MANAGER_DOCUMENT, "lockfileVersion: '9.0'", 'overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'patchedDependencies:', `  foo@1.0.0: ${PATCH_HASH}`, 'packages:', '  tar@7.5.21: {}', ''].join('\n');
    const report = check(fixture({ lock }));
    assert.deepEqual(report.failures, []);
    assert.equal(report.overrideCount, 1);
    assert.equal(report.patchCount, 1);
  });

  it('judges the last document, not the first, of a two-document lockfile', () => {
    const lock = ['---', "lockfileVersion: '9.0'", 'overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", '---', "lockfileVersion: '9.0'", 'packages:', '  tar@7.5.21: {}', ''].join('\n');
    assert.match(failures(fixture({ lock })), /declares 1 overrides but pnpm-lock\.yaml records none/);
  });

  it('skips a trailing empty document to reach the project lockfile', () => {
    const lock = [...PACKAGE_MANAGER_DOCUMENT, "lockfileVersion: '9.0'", 'overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'packages:', '  tar@7.5.21: {}', '---', ''].join('\n');
    const report = check(fixture({ lock }));
    assert.equal(report.overrideCount, 1);
    assert.doesNotMatch(report.failures.join('\n'), /records none/);
  });

  it('reports a damaged first document instead of skipping it', () => {
    assert.match(failures(fixture({ lock: ['---', 'importers: [unclosed', '---', "lockfileVersion: '9.0'", ''].join('\n') })), /pnpm-lock\.yaml could not be parsed/);
  });

  it('reads an empty lockfile as one that records nothing', () => {
    assert.match(failures(fixture({ lock: '' })), /declares 1 overrides but pnpm-lock\.yaml records none/);
  });

  const bare = (target: string, resolved: string) =>
    fixture({ workspace: ['overrides:', `  weird-pkg: '${target}'`, ''].join('\n'), lock: ["lockfileVersion: '9.0'", 'overrides:', `  weird-pkg: '${target}'`, 'packages:', `  weird-pkg@${resolved}: {}`, ''].join('\n') });

  it('rejects a bare-name override whose forced target was not applied', () => {
    assert.match(failures(bare('>=1.0.0', '0.1.0')), /forces every version to/);
  });

  it('accepts a bare-name override that was applied', () => {
    const report = check(bare('>=1.0.0', '2.0.0'));
    assert.deepEqual(report.failures, []);
    assert.equal(report.versionsChecked, 1);
  });

  it('surfaces an unusable range instead of silently skipping it', () => {
    assert.match(check(bare('npm:other@1.0.0', '2.0.0')).notes.join('\n'), /no parseable semver range/);
  });

  it('reads semver sugar in a range, as semver does', () => {
    const caret = check(bare('^1.0.0', '0.1.0'));
    assert.deepEqual(caret.notes, []);
    assert.match(caret.failures.join('\n'), /weird-pkg@0\.1\.0 is resolved, but the override forces every version to `\^1\.0\.0`/);
    assert.deepEqual(check(bare('<2', '1.9.0')).failures, []);
  });

  // A peer suffix holds an `@`, and keys split on the last one, so a
  // peer-suffixed key names another package: the original read it so too.
  it('skips a resolved version that is not one, and a peer-suffixed key', () => {
    const report = check(fixture({ workspace: workspaceWith(), lock: lockWith('  tar@https://example.com/tar.tgz: {}', '  tar@7.5.19(peer@1.0.0): {}') }));
    assert.deepEqual(report.failures, []);
    assert.equal(report.versionsChecked, 1);
  });
});

describe('pnpm-settings: cooling-off exceptions (minimumReleaseAgeExclude)', () => {
  const aws = (workspace: string, ...lock: string[]) => fixture({ workspace, lock: lockWith(...lock) });

  it('rejects an exception pnpm wrote with nobody recording a decision', () => {
    assert.match(failures(aws(workspaceWith('minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'"), "  '@aws-sdk/client-s3@3.1124.0': {}")), /minimumReleaseAgeExclude declares 1 cooling-off exception\(s\) with no comment/);
  });

  it('rejects a rationale that never says when the exception expires', () => {
    assert.match(failures(aws(workspaceWith('# WHY: needed a same-day SDK release.', 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'"), "  '@aws-sdk/client-s3@3.1124.0': {}")), /does not say when the exception expires/);
  });

  it('does not accept a comment that belongs to the setting above it', () => {
    const ws = workspaceWith('# EXPIRES: 2026-09-02 — this comment documents minimumReleaseAge.', 'minimumReleaseAge: 1440', '', 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'");
    assert.match(failures(aws(ws, "  '@aws-sdk/client-s3@3.1124.0': {}")), /cooling-off exception\(s\) with no comment/);
  });

  it('rejects an entry that is not pinned to one exact version, or a range', () => {
    assert.match(failures(aws(workspaceWith(...DOCUMENTED, 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3'"), "  '@aws-sdk/client-s3@3.1124.0': {}")), /`@aws-sdk\/client-s3` is not pinned to an exact version/);
    assert.match(failures(aws(workspaceWith(...DOCUMENTED, 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@^3.0.0'"), "  '@aws-sdk/client-s3@3.1124.0': {}")), /is not pinned to an exact/);
  });

  it('rejects an exception that outlived the pin it was taken for', () => {
    assert.match(failures(aws(workspaceWith(...DOCUMENTED, 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'"), "  '@aws-sdk/client-s3@3.1200.0': {}")), /`@aws-sdk\/client-s3@3\.1124\.0` is stale/);
  });

  it('rejects an exception whose recorded expiry has already passed, naming the entry', () => {
    const joined = failures(aws(workspaceWith(...EXPIRED, 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'"), "  '@aws-sdk/client-s3@3.1124.0': {}"));
    assert.match(joined, /exception expired; delete the entries/);
    assert.match(joined, /@aws-sdk\/client-s3@3\.1124\.0/);
  });

  it('rejects an EXPIRES value it cannot read as a date', () => {
    const ws = workspaceWith('# WHY: needed a same-day SDK release.', '# EXPIRES: when-the-audit-lands', 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'");
    assert.match(failures(aws(ws, "  '@aws-sdk/client-s3@3.1124.0': {}")), /EXPIRES value .*`when-the-audit-lands`.* is not a date this check can read/);
  });

  it('accepts a documented, exactly pinned, still-resolved exception', () => {
    const report = check(aws(workspaceWith(...DOCUMENTED, 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'"), "  '@aws-sdk/client-s3@3.1124.0': {}"));
    assert.deepEqual(report.failures, []);
    assert.equal(report.releaseAgeExclusionCount, 1);
  });

  it('asks nothing of the config’s own scopes, which are standing entries', () => {
    const report = check(aws(workspaceWith('minimumReleaseAgeExclude:', "  - '@acme/*'", "  - '@veda-hq/*'")));
    assert.deepEqual(report.failures, []);
    assert.equal(report.releaseAgeExclusionCount, 0);
  });

  it('holds own scopes to the rules when the config names none', () => {
    const report = check(aws(workspaceWith(...DOCUMENTED, 'minimumReleaseAgeExclude:', "  - '@acme/*'")), DEFAULT_PNPM_CONFIG);
    assert.match(report.failures.join('\n'), /`@acme\/\*` is not pinned to an exact version/);
  });

  it('still holds a third-party entry beside own scopes to the rules', () => {
    const report = check(aws(workspaceWith('minimumReleaseAgeExclude:', "  - '@veda-hq/*'", "  - '@aws-sdk/client-s3@3.1124.0'"), "  '@aws-sdk/client-s3@3.1124.0': {}"));
    assert.match(report.failures.join('\n'), /declares 1 cooling-off exception\(s\) with no comment/);
    assert.equal(report.releaseAgeExclusionCount, 1);
  });

  it('rejects a scope pattern that is not one of the config’s', () => {
    assert.match(failures(aws(workspaceWith(...DOCUMENTED, 'minimumReleaseAgeExclude:', "  - '@aws-sdk/*'"))), /`@aws-sdk\/\*` is not pinned to an exact version/);
  });

  it('asks nothing of no exception, an emptied list, or a key with no value', () => {
    for (const lines of [[], ['minimumReleaseAgeExclude: []'], ['minimumReleaseAgeExclude:']]) {
      const report = check(aws(workspaceWith(...lines)));
      assert.deepEqual(report.failures, []);
      assert.equal(report.releaseAgeExclusionCount, 0);
    }
  });

  it('reports a non-string entry, and a scalar in place of the list', () => {
    assert.match(failures(aws(workspaceWith(...DOCUMENTED, 'minimumReleaseAgeExclude:', '  - 42'))), /entry `42` is not a string, so pnpm cannot match it/);
    assert.match(failures(fixture({ workspace: workspaceWith(...DOCUMENTED, "minimumReleaseAgeExclude: '@aws-sdk/client-s3@3.1124.0'") })), /minimumReleaseAgeExclude must be a list/);
  });
});

describe('releaseAgeExclusionComment', () => {
  it('returns the contiguous comment block above the setting', () => {
    const text = ['# unrelated', '', '# WHY: same-day pin', '# EXPIRES: 2026-09-02T18:54Z', 'minimumReleaseAgeExclude:', "  - 'x@1.0.0'"].join('\n');
    assert.equal(releaseAgeExclusionComment(text), 'WHY: same-day pin\nEXPIRES: 2026-09-02T18:54Z');
  });

  it('returns empty when the setting is absent, and reads a block from the first line', () => {
    assert.equal(releaseAgeExclusionComment('minimumReleaseAge: 1440\n'), '');
    assert.equal(releaseAgeExclusionComment('# WHY: top of file\nminimumReleaseAgeExclude:\n'), 'WHY: top of file');
  });
});

describe('parseExclusionExpiry', () => {
  it('reads an ISO instant followed by prose', () => {
    assert.deepEqual(parseExclusionExpiry('EXPIRES: 2026-09-02T18:54Z, 1440 minutes after publication.'), { kind: 'at', at: new Date('2026-09-02T18:54Z'), raw: '2026-09-02T18:54Z' });
  });

  it('reports a value that is not a date, and an absent line', () => {
    assert.deepEqual(parseExclusionExpiry('EXPIRES: someday'), { kind: 'invalid', raw: 'someday' });
    assert.deepEqual(parseExclusionExpiry('WHY: because.'), { kind: 'absent' });
  });

  it('ignores EXPIRES mentioned mid-sentence', () => {
    assert.deepEqual(parseExclusionExpiry('ANY FUTURE ENTRY MUST CARRY AN `EXPIRES: <ISO-8601 UTC>` LINE in this comment\nblock, e.g. `EXPIRES: 2026-09-02T18:54Z`.'), { kind: 'absent' });
  });

  it('reads as invalid what Date accepts but ISO-8601 does not', () => {
    for (const value of ['<ISO-8601', '2026', '2026-13-45', '2026-02-31', '2026-04-31T10:00Z', '2026-09-02x', '2026-09-02T18:54']) {
      assert.deepEqual(parseExclusionExpiry(`EXPIRES: ${value}`), { kind: 'invalid', raw: value }, value);
    }
  });

  it('does not borrow the next line, and reads an empty value as invalid', () => {
    assert.deepEqual(parseExclusionExpiry('EXPIRES:\n2099-01-01 is when we look again.'), { kind: 'invalid', raw: '' });
    assert.deepEqual(parseExclusionExpiry('EXPIRES: ,'), { kind: 'invalid', raw: '' });
  });

  it('reads a bare date and a full instant', () => {
    assert.equal(parseExclusionExpiry('EXPIRES: 2026-09-02').kind, 'at');
    assert.deepEqual(parseExclusionExpiry('  EXPIRES: 2026-09-02T18:54:00.000Z'), { kind: 'at', at: new Date('2026-09-02T18:54:00.000Z'), raw: '2026-09-02T18:54:00.000Z' });
  });
});

describe('parseSelector and splitNameVersion', () => {
  it('split on the last @, so scoped packages survive; a bare name targets every version', () => {
    assert.deepEqual(parseSelector('@babel/core@>=7.0.0 <7.29.6'), { name: '@babel/core', range: '>=7.0.0 <7.29.6' });
    assert.deepEqual(parseSelector('tar'), { name: 'tar', range: '*' });
    assert.deepEqual(parseSelector('@scope/pkg'), { name: '@scope/pkg', range: '*' });
    assert.deepEqual(splitNameVersion('@scope/pkg@1.0.0'), { name: '@scope/pkg', version: '1.0.0' });
    assert.equal(splitNameVersion('pkg'), null);
  });
});

describe('pnpm-settings: what each failure says', () => {
  it('names every stranded key and where to move it', () => {
    const root = fixture({ pkg: { name: 'fx', pnpm: { overrides: { 'tar@<=7.5.20': '>=7.5.21 <8' }, patchedDependencies: { 'foo@1.0.0': 'patches/foo@1.0.0.patch' } } } });
    assert.ok(
      check(root).failures.includes('package.json#pnpm still declares `overrides`, `patchedDependencies`. pnpm 11 does not read these and will not warn. Move them to pnpm-workspace.yaml. See https://github.com/pnpm/pnpm/issues/11536'),
    );
  });

  it('says how to repopulate a lockfile that recorded no overrides', () => {
    const root = fixture({ lock: ["lockfileVersion: '9.0'", 'packages:', '  tar@7.5.21: {}', ''].join('\n') });
    assert.ok(
      check(root).failures.includes(
        "pnpm-workspace.yaml declares 1 overrides but pnpm-lock.yaml records none. This is the signature of pnpm ignoring the settings source entirely. Re-run `pnpm install --lockfile-only` and confirm the lockfile's overrides: block is populated.",
      ),
    );
  });

  it('asks nothing of a repo with no overrides on either side', () => {
    const report = check(fixture({ workspace: '', lock: ["lockfileVersion: '9.0'", 'packages:', '  tar@7.5.21: {}', ''].join('\n') }));
    assert.deepEqual(report.failures, []);
    assert.equal(report.overrideCount, 0);
  });

  it('names an override the lockfile never recorded', () => {
    const root = fixture({ workspace: workspaceWith().replace('overrides:\n', "overrides:\n  lodash@<4.17.21: '>=4.17.21'\n"), lock: lockWith() });
    assert.deepEqual(check(root).failures, ['override `lodash@<4.17.21` is declared in pnpm-workspace.yaml but absent from the lockfile.']);
  });

  it('quotes both sides of an override the lockfile records differently', () => {
    const root = fixture({ workspace: workspaceWith(), lock: lockBlocks(["  tar@<=7.5.20: '>=7.5.22 <8'"], ['  foo@1.0.0:', `    hash: ${PATCH_HASH}`]) });
    assert.deepEqual(check(root).failures, ['override `tar@<=7.5.20` disagrees: workspace says `>=7.5.21 <8`, lockfile says `>=7.5.22 <8`.']);
  });

  it('names an override the lockfile still carries after it was removed', () => {
    const root = fixture({ workspace: workspaceWith(), lock: lockBlocks(["  tar@<=7.5.20: '>=7.5.21 <8'", "  lodash@<4.17.21: '>=4.17.21'"], ['  foo@1.0.0:', `    hash: ${PATCH_HASH}`]) });
    assert.deepEqual(check(root).failures, ['override `lodash@<4.17.21` is in the lockfile but no longer declared in pnpm-workspace.yaml.']);
  });

  it('quotes both paths of a patch the lockfile records elsewhere', () => {
    const root = fixture({ workspace: workspaceWith(), lock: lockBlocks(["  tar@<=7.5.20: '>=7.5.21 <8'"], ['  foo@1.0.0:', `    hash: ${PATCH_HASH}`, '    path: patches/other.patch']) });
    assert.deepEqual(check(root).failures, ['patch `foo@1.0.0` path disagrees: workspace says `patches/foo@1.0.0.patch`, lockfile says `patches/other.patch`.']);
  });

  it('names a patch the lockfile still carries after it was removed', () => {
    const root = fixture({ workspace: workspaceWith(), lock: lockBlocks(["  tar@<=7.5.20: '>=7.5.21 <8'"], ['  foo@1.0.0:', `    hash: ${PATCH_HASH}`, `  bar@2.0.0: ${PATCH_HASH}`]) });
    assert.deepEqual(check(root).failures, ['patch `bar@2.0.0` is in the lockfile but no longer declared in pnpm-workspace.yaml.']);
  });

  it('gives both hashes and the command that reconciles them', () => {
    const root = fixture({ lock: lockBlocks(["  tar@<=7.5.20: '>=7.5.21 <8'"], [`  foo@1.0.0: ${'d'.repeat(64)}`]) });
    assert.deepEqual(check(root).failures, [
      `patch \`foo@1.0.0\` content does not match the lockfile: patches/foo@1.0.0.patch hashes to ${PATCH_HASH.slice(0, 16)}… but the lockfile recorded dddddddddddddddd…. Re-run \`pnpm patch-commit\` so the applied patch and the committed file agree.`,
    ]);
  });

  it('reads an all-digit hash as its text', () => {
    const root = fixture({ lock: lockBlocks(["  tar@<=7.5.20: '>=7.5.21 <8'"], ['  foo@1.0.0: 1234']) });
    assert.match(check(root).failures.join('\n'), /the lockfile recorded 1234…/);
  });

  it('says a selector with no usable range went unchecked', () => {
    assert.deepEqual(check(bareOf('npm:other@1.0.0', '2.0.0')).notes, ['override `weird-pkg` has no parseable semver range (`npm:other@1.0.0`); version compliance not checked.']);
  });

  it('names the version a bare-name override failed to force', () => {
    assert.deepEqual(check(bareOf('>=1.0.0', '0.1.0')).failures, ['override `weird-pkg` did not take effect: weird-pkg@0.1.0 is resolved, but the override forces every version to `>=1.0.0`.']);
  });

  it('names the vulnerable version still inside the excluded range, a prerelease of it included', () => {
    assert.deepEqual(check(fixture({ workspace: workspaceWith(), lock: lockWith('  tar@7.5.19: {}') })).failures, ['override `tar@<=7.5.20` did not take effect: tar@7.5.19 is still resolved, and it falls inside the excluded range `<=7.5.20`.']);
    assert.deepEqual(check(fixture({ workspace: workspaceWith(), lock: lockWith('  tar@7.5.20-beta.1: {}') })).failures, [
      'override `tar@<=7.5.20` did not take effect: tar@7.5.20-beta.1 is still resolved, and it falls inside the excluded range `<=7.5.20`.',
    ]);
  });
});

const bareOf = (target: string, resolved: string) =>
  fixture({ workspace: ['overrides:', `  weird-pkg: '${target}'`, ''].join('\n'), lock: ["lockfileVersion: '9.0'", 'overrides:', `  weird-pkg: '${target}'`, 'packages:', `  weird-pkg@${resolved}: {}`, ''].join('\n') });

describe('pnpm-settings: what each cooling-off failure says', () => {
  const aws = (workspace: string, ...lock: string[]) => fixture({ workspace, lock: lockWith(...lock) });

  it('says a scalar list is not in force', () => {
    assert.deepEqual(check(aws(workspaceWith(...DOCUMENTED, "minimumReleaseAgeExclude: '@aws-sdk/client-s3@3.1124.0'"))).failures, [
      'minimumReleaseAgeExclude must be a list of `name@version` strings, but it is `string`. pnpm cannot apply it in this shape, so the exception it was meant to record is not in force either.',
    ]);
  });

  it('says what an undocumented exception needs recorded', () => {
    assert.deepEqual(check(aws(workspaceWith('minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'"), "  '@aws-sdk/client-s3@3.1124.0': {}")).failures, [
      'minimumReleaseAgeExclude declares 1 cooling-off exception(s) with no comment above the block. pnpm writes entries here on its own when minimumReleaseAgeStrict is false, so an undocumented entry is a supply-chain exception nobody took. Record why it was taken, what took it, and when it expires.',
    ]);
  });

  it('says how to write the missing expiry', () => {
    assert.deepEqual(check(aws(workspaceWith('# WHY: needed a same-day SDK release.', 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'"), "  '@aws-sdk/client-s3@3.1124.0': {}")).failures, [
      'the comment above minimumReleaseAgeExclude does not say when the exception expires. Add an `EXPIRES: <YYYY-MM-DD…>` line — an exception with no end date is a permanent hole in the cooling-off.',
    ]);
  });

  it('quotes the unreadable expiry and shows a readable one', () => {
    assert.deepEqual(check(aws(workspaceWith('# WHY: needed a same-day SDK release.', '# EXPIRES: when-the-audit-lands', 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'"), "  '@aws-sdk/client-s3@3.1124.0': {}")).failures, [
      'the EXPIRES value above minimumReleaseAgeExclude (`when-the-audit-lands`) is not a date this check can read, so the expiry cannot be enforced and the exception is open-ended in practice. Write an ISO-8601 UTC instant, e.g. `EXPIRES: 2026-09-02T18:54Z`.',
    ]);
  });

  it('names every entry an expired exception still covers', () => {
    const root = aws(workspaceWith(...EXPIRED, 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'", "  - 'left-pad@1.3.0'"), "  '@aws-sdk/client-s3@3.1124.0': {}", '  left-pad@1.3.0: {}');
    assert.deepEqual(check(root).failures, [
      'the minimumReleaseAgeExclude exception expired at 2026-09-02T18:54:00.000Z and is still in force for `@aws-sdk/client-s3@3.1124.0`, `left-pad@1.3.0`. The pinned versions have aged past minimumReleaseAge, so pnpm will not re-add them: exception expired; delete the entries.',
    ]);
  });

  it('treats the instant of expiry as expired', () => {
    const root = aws(workspaceWith(...DOCUMENTED, 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'"), "  '@aws-sdk/client-s3@3.1124.0': {}");
    assert.match(check(root, OWN, new Date('2099-01-01T00:00Z').getTime()).failures.join('\n'), /expired at 2099-01-01T00:00:00\.000Z/);
    assert.deepEqual(check(root, OWN, new Date('2099-01-01T00:00Z').getTime() - 1).failures, []);
  });

  it('says how to pin an unpinned entry', () => {
    assert.deepEqual(check(aws(workspaceWith(...DOCUMENTED, 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3'"))).failures, [
      'minimumReleaseAgeExclude entry `@aws-sdk/client-s3` is not pinned to an exact version. Scoped this way it exempts versions nobody has reviewed from the cooling-off — write `@aws-sdk/client-s3@<exact version>`.',
    ]);
  });

  it('says a stale entry is to be deleted', () => {
    assert.deepEqual(check(aws(workspaceWith(...DOCUMENTED, 'minimumReleaseAgeExclude:', "  - '@aws-sdk/client-s3@3.1124.0'"), "  '@aws-sdk/client-s3@3.1200.0': {}")).failures, [
      'minimumReleaseAgeExclude entry `@aws-sdk/client-s3@3.1124.0` is stale: the lockfile no longer resolves @aws-sdk/client-s3@3.1124.0. The exception has outlived the pin it was taken for — delete the line.',
    ]);
  });

  it('says a non-string entry cannot match a package', () => {
    assert.deepEqual(check(aws(workspaceWith(...DOCUMENTED, 'minimumReleaseAgeExclude:', '  - 42'))).failures, ['minimumReleaseAgeExclude entry `42` is not a string, so pnpm cannot match it against a package.']);
  });
});

describe('parsePnpmConfig', () => {
  it('takes the defaults, and reads both keys', () => {
    assert.deepEqual(parsePnpmConfig('{}'), DEFAULT_PNPM_CONFIG);
    assert.deepEqual(parsePnpmConfig('{"id": "CFG-1", "ownScopes": ["@a/*"]}'), { id: 'CFG-1', ownScopes: ['@a/*'] });
  });

  it('refuses anything else', () => {
    const cases: Array<[string, RegExp]> = [
      ['nope', /not JSON/],
      ['[]', /must be a JSON object/],
      ['{"scopes": []}', /unknown key "scopes"/],
      ['{"id": " "}', /"id" must be a non-empty string/],
      ['{"ownScopes": "@a/*"}', /"ownScopes" must be a list of entries/],
      ['{"ownScopes": [""]}', /"ownScopes" must be a list of entries/],
      ['{"id": null}', /"id" must be a non-empty string/],
      ['{"ownScopes": null}', /"ownScopes" must be a list of entries/],
    ];
    for (const [text, message] of cases) assert.throws(() => parsePnpmConfig(text), message, text);
  });
});

/** Runs the CLI, capturing what it prints and the code it exits with. */
const runCli = (args: readonly string[], now?: number) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(['pnpm-settings', ...args], { out: (l) => out.push(l), err: (l) => err.push(l), ...(now === undefined ? {} : { now: () => now }) }, '0');
  return { code, out, err };
};

describe('pnpm-settings: the CLI', () => {
  const withConfig = (root: string): string => {
    writeFileSync(join(root, 'cfg.json'), JSON.stringify(OWN));
    return root;
  };

  it('prints every note and failure, then exits 1', () => {
    const root = withConfig(
      fixture({
        workspace: ['overrides:', "  weird-pkg: 'npm:other@1.0.0'", "  tar@<=7.5.20: '>=7.5.21 <8'", ''].join('\n'),
        lock: ["lockfileVersion: '9.0'", 'overrides:', "  weird-pkg: 'npm:other@1.0.0'", 'packages:', '  weird-pkg@2.0.0: {}', ''].join('\n'),
      }),
    );
    assert.deepEqual(runCli(['--root', root, '--config', 'cfg.json']), {
      code: 1,
      out: [],
      err: [
        '⚠️  CFG-005: 1 selector(s) not version-checked:',
        '   - override `weird-pkg` has no parseable semver range (`npm:other@1.0.0`); version compliance not checked.',
        '\n❌ CFG-005: pnpm settings parity FAILED (1 problem(s))\n',
        ' • override `tar@<=7.5.20` is declared in pnpm-workspace.yaml but absent from the lockfile.\n',
        'A successful `pnpm install` is not evidence here — pnpm 11 drops these settings without warning.\n',
      ],
    });
  });

  it('reports a clean run with its counts and nothing else', () => {
    const root = withConfig(fixture({ workspace: workspaceWith(), lock: lockWith() }));
    assert.deepEqual(runCli(['--root', root, '--config', 'cfg.json']), { code: 0, out: ['✅ CFG-005: pnpm settings parity OK — 1 override(s), 1 patch(es), 1 resolved version(s) verified.'], err: [] });
  });

  it('adds documented exceptions and unchecked selectors to the clean line', () => {
    const root = withConfig(
      fixture({
        workspace: ['overrides:', "  weird-pkg: 'npm:other@1.0.0'", ...DOCUMENTED, 'minimumReleaseAgeExclude:', "  - 'weird-pkg@2.0.0'", ''].join('\n'),
        lock: ["lockfileVersion: '9.0'", 'overrides:', "  weird-pkg: 'npm:other@1.0.0'", 'packages:', '  weird-pkg@2.0.0: {}', ''].join('\n'),
      }),
    );
    const r = runCli(['--root', root, '--config', 'cfg.json'], new Date('2026-11-11T00:00Z').getTime());
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, ['✅ CFG-005: pnpm settings parity OK — 1 override(s), 0 patch(es), 0 resolved version(s) verified, 1 documented cooling-off exception(s), 1 selector(s) unchecked.']);
    assert.equal(r.err.length, 2);
  });

  it('defaults its id, and exits 2 on a bad config or an unreadable package.json', () => {
    const root = fixture({ workspace: workspaceWith(), lock: lockWith() });
    assert.deepEqual(runCli(['--root', root]).out, ['✅ pnpm-settings: pnpm settings parity OK — 1 override(s), 1 patch(es), 1 resolved version(s) verified.']);
    writeFileSync(join(root, 'bad.json'), '{"x": 1}');
    assert.deepEqual(runCli(['--root', root, '--config', 'bad.json']), { code: 2, out: [], err: ['pariksha pnpm-settings: unknown key "x"; nothing was checked, so this is not a pass'] });
    writeFileSync(join(root, 'package.json'), '{');
    const broken = runCli(['--root', root]);
    assert.equal(broken.code, 2);
    assert.match(broken.err[0] ?? '', /^pariksha pnpm-settings: .*JSON.*; nothing was checked, so this is not a pass$/);
  });

  it('exits 1 on a missing input, as the original did', () => {
    const r = runCli(['--root', temp('pariksha-pnpm-none-')]);
    assert.equal(r.code, 1);
    assert.match(r.err[1] ?? '', /required file missing/);
  });

  it('reads this repository’s own files', () => {
    assert.ok(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8').length > 0);
    assert.equal(runCli(['--root', REPO_ROOT]).code, 0);
  });
});
