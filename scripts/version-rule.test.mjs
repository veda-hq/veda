import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  askAlok,
  check,
  classify,
  defaultManifests,
  entry,
  fetchJson,
  gitTags,
  main,
  majorApproved,
  nextLegal,
  parse,
  realIo,
  releaseTags,
} from './version-rule.mjs';

const SCRIPT = fileURLToPath(new URL('./version-rule.mjs', import.meta.url));
const v = (/** @type {string} */ s) => /** @type {import('./version-rule.mjs').Version} */ (parse(s));

// Typed out here, not imported, so a mutant of the script's own text dies.
const DOC = 'https://github.com/veda-hq/veda#releasing';
const ALOK = 'AlokBansal8';
const ENVIRONMENT = 'major-release';
const ask = (/** @type {string} */ version) =>
  `${version} is a major bump. Only Alok decides a major version: ask him, and do not release it until he says yes. ` +
  `If he agrees, he approves this run's "major-release" deployment on GitHub himself, or pushes it himself; ` +
  `no one else's approval counts (https://github.com/veda-hq/veda#releasing).`;
const USAGE = 'usage: version-rule.mjs tag vX.Y.Z [manifest…] | pending [manifest…] | approval';

// Most tests are synchronous. One turn of the event loop before each lets the
// TAP line of a failed test reach stdout at once, so Stryker's tap runner
// bails on a mutant's first failure instead of running the whole file.
beforeEach(() => new Promise((resolve) => setImmediate(resolve)));

/** Temp folders made by the suite, removed at its end. */
const dirs = /** @type {string[]} */ ([]);
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A temp folder holding the given manifests, by path. @param {Record<string, string>} manifests */
function folder(manifests = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'version-rule-'));
  dirs.push(dir);
  for (const [path, version] of Object.entries(manifests)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify({ name: path, version }));
  }
  return dir;
}

/** @param {string} prev @param {string} next */
const rule = (prev, next) => classify(v(prev), v(next));
/** @param {string} next @param {string} why @param {string} prev @param {string} legal */
const broken = (next, why, prev, legal) =>
  `${next} breaks the version rule: ${why}. The next release after ${prev} is ${legal} (${DOC}).`;
const wrongShape = (/** @type {string} */ next, /** @type {string} */ shape) =>
  `${next} is a major bump of the wrong shape: a major release is ${shape}, and only with Alok's yes (${DOC}).`;

describe('the version rule', () => {
  test('a normal patch is allowed', () => {
    assert.deepEqual(rule('0.5.0', '0.5.1'), { bump: 'patch' });
    assert.deepEqual(rule('0.5.19', '0.5.20'), { bump: 'patch' });
  });

  test('0.5.20 → 0.6.0 is allowed, as a minor', () => {
    assert.deepEqual(rule('0.5.20', '0.6.0'), { bump: 'minor' });
  });

  test('0.5.20 → 0.5.21 is refused: 20 is the last patch', () => {
    assert.deepEqual(rule('0.5.20', '0.5.21'), {
      bump: 'patch',
      error: broken('0.5.21', '0.5.20 is the last patch of its line', '0.5.20', '0.6.0'),
    });
    // A line already past 20 (from before the rule) is past its last patch too.
    assert.deepEqual(rule('0.5.25', '0.5.26'), {
      bump: 'patch',
      error: broken('0.5.26', '0.5.20 is the last patch of its line', '0.5.25', '0.6.0'),
    });
  });

  test('0.5.3 → 0.6.0 is refused: minor only after .20', () => {
    assert.deepEqual(rule('0.5.3', '0.6.0'), {
      bump: 'minor',
      error: broken('0.6.0', 'the minor number goes up only after 0.5.20', '0.5.3', '0.5.4'),
    });
    // Not x.y.0, so not a minor bump, and refused for the same reason.
    assert.deepEqual(rule('0.5.3', '0.6.1'), {
      bump: 'patch',
      error: broken('0.6.1', 'the minor number goes up only after 0.5.20', '0.5.3', '0.5.4'),
    });
  });

  test('a skipped patch is refused (0.5.0 → 0.5.2)', () => {
    assert.deepEqual(rule('0.5.0', '0.5.2'), { bump: 'patch', error: broken('0.5.2', 'it skips a version', '0.5.0', '0.5.1') });
  });

  test('a skipped minor is refused (0.5.20 → 0.7.0, 0.5.20 → 0.6.1)', () => {
    assert.deepEqual(rule('0.5.20', '0.7.0'), { bump: 'minor', error: broken('0.7.0', 'it skips a version', '0.5.20', '0.6.0') });
    assert.deepEqual(rule('0.5.20', '0.6.1'), { bump: 'patch', error: broken('0.6.1', 'it skips a version', '0.5.20', '0.6.0') });
  });

  test('a release not above the previous is refused', () => {
    for (const next of ['0.5.3', '0.5.2', '0.5.0', '0.4.0']) {
      assert.deepEqual(
        rule('0.5.3', next),
        { bump: 'patch', error: broken(next, 'it is not above the previous release 0.5.3', '0.5.3', '0.5.4') },
        next,
      );
    }
  });

  test('a major bump is classed major; the right shape carries no error of its own', () => {
    assert.deepEqual(rule('0.5.3', '1.0.0'), { bump: 'major' });
    assert.deepEqual(rule('1.20.20', '2.0.0'), { bump: 'major' });
  });

  test('a major bump of the wrong shape is refused outright', () => {
    for (const next of ['1.0.1', '1.1.0', '2.0.0']) {
      assert.deepEqual(rule('0.5.3', next), { bump: 'major', error: wrongShape(next, '1.0.0') }, next);
    }
  });

  test('the first release: any 0.y.z, and a major one is still a major', () => {
    assert.deepEqual(classify(undefined, v('0.1.0')), { bump: 'first' });
    assert.deepEqual(classify(undefined, v('0.5.3')), { bump: 'first' });
    assert.deepEqual(classify(undefined, v('1.0.0')), { bump: 'major' });
    assert.deepEqual(classify(undefined, v('2.0.0')), { bump: 'major' });
    assert.deepEqual(classify(undefined, v('1.2.0')), { bump: 'major', error: wrongShape('1.2.0', '1.0.0') });
  });

  test('nextLegal walks patches to 20, then the minor', () => {
    assert.deepEqual(nextLegal(v('0.5.0')), v('0.5.1'));
    assert.deepEqual(nextLegal(v('0.5.19')), v('0.5.20'));
    assert.deepEqual(nextLegal(v('0.5.20')), v('0.6.0'));
    // A line already past 20 (from before the rule) ends at once.
    assert.deepEqual(nextLegal(v('0.5.25')), v('0.6.0'));
  });

  test('parse takes X.Y.Z or vX.Y.Z and nothing else', () => {
    assert.deepEqual(parse('v1.2.3'), { major: 1, minor: 2, patch: 3 });
    assert.deepEqual(parse('10.20.30'), { major: 10, minor: 20, patch: 30 });
    for (const bad of ['1.2', '1.2.3-rc.1', 'v1.2.3.4', 'x1.2.3', '']) assert.equal(parse(bad), undefined, bad);
  });

  test('releaseTags keeps vX.Y.Z tags only, highest first by version, not by text', () => {
    assert.deepEqual(
      releaseTags(['v0.5.0', 'v0.10.0', 'v0.9.20', '0.11.0', 'v1.0.0-rc.1', 'latest']).map((t) => `${t.major}.${t.minor}.${t.patch}`),
      ['0.10.0', '0.9.20', '0.5.0'],
    );
  });
});

describe('check over a repository', () => {
  const tags = ['v0.1.0', 'v0.2.0', 'v0.3.0', 'v0.3.1', 'v0.3.2', 'v0.4.0', 'v0.5.0'];
  const at = (/** @type {Record<string, string>} */ versions) =>
    Object.entries(versions).map(([path, version]) => ({ path, version }));

  test('the tag v0.5.1 after v0.5.0 is a patch, with released and tagged package versions', () => {
    const r = check({ tags: [...tags, 'v0.5.1'], tag: 'v0.5.1', manifests: at({ a: '0.5.1', b: '0.3.2', c: '0.5.0' }) });
    assert.deepEqual(r, { bump: 'patch', version: '0.5.1', previous: '0.5.0', errors: [] });
  });

  test('the tag is compared with the highest other tag, not with itself', () => {
    assert.deepEqual(check({ tags: [...tags, 'v0.5.2'], tag: 'v0.5.2', manifests: [] }), {
      bump: 'patch',
      version: '0.5.2',
      previous: '0.5.0',
      errors: [broken('0.5.2', 'it skips a version', '0.5.0', '0.5.1')],
    });
  });

  test('a tag not of the form vX.Y.Z is refused', () => {
    for (const tag of ['0.5.1', 'v0.5.1-rc.1', 'vnext']) {
      assert.deepEqual(
        check({ tags, tag, manifests: at({ a: '0.5.1' }) }),
        { bump: 'none', errors: [`tag ${tag} is not of the form vX.Y.Z (${DOC}).`] },
        tag,
      );
    }
  });

  test('at a tag, packages at some other unreleased version are refused', () => {
    const r = check({ tags, tag: 'v0.5.1', manifests: at({ a: '0.5.1', b: '0.5.2', c: '0.5.2' }) });
    assert.deepEqual(r, {
      bump: 'patch',
      version: '0.5.1',
      previous: '0.5.0',
      errors: ["b, c: version 0.5.2 is neither released nor this tag's 0.5.1."],
    });
  });

  test('pending: one shared next version is the release to come', () => {
    const r = check({ tags, manifests: at({ dvara: '0.5.1', pariksha: '0.5.1', kavach: '0.3.0' }) });
    assert.deepEqual(r, { bump: 'patch', version: '0.5.1', previous: '0.5.0', errors: [] });
  });

  test('pending: nothing unreleased is fine', () => {
    assert.deepEqual(check({ tags, manifests: at({ a: '0.5.0', b: '0.2.0' }) }), { bump: 'none', previous: '0.5.0', errors: [] });
    assert.deepEqual(check({ tags, manifests: [] }), { bump: 'none', previous: '0.5.0', errors: [] });
  });

  test('pending: a package bumped to an illegal version is refused', () => {
    assert.deepEqual(check({ tags, manifests: at({ a: '0.6.0' }) }), {
      bump: 'minor',
      version: '0.6.0',
      previous: '0.5.0',
      errors: [broken('0.6.0', 'the minor number goes up only after 0.5.20', '0.5.0', '0.5.1')],
    });
    // Below the last tag but never released: not a version any tag can publish.
    assert.deepEqual(check({ tags, manifests: at({ a: '0.4.5' }) }).errors, [
      broken('0.4.5', 'it is not above the previous release 0.5.0', '0.5.0', '0.5.1'),
    ]);
  });

  test('pending: two different unreleased versions are refused', () => {
    assert.deepEqual(check({ tags, manifests: at({ a: '0.5.1', b: '0.5.1', c: '0.5.2' }) }), {
      bump: 'none',
      previous: '0.5.0',
      errors: ['the unreleased versions differ: 0.5.1 (a, b); 0.5.2 (c). One tag releases them all, so they share one version.'],
    });
  });

  test('pending: a major is classed major, for the approval step to refuse', () => {
    assert.deepEqual(check({ tags, manifests: at({ a: '1.0.0' }) }), { bump: 'major', version: '1.0.0', previous: '0.5.0', errors: [] });
  });

  test('a manifest version not of the form X.Y.Z is refused', () => {
    for (const bad of ['v0.5.1', '0.5.1-rc.1', 'undefined']) {
      assert.deepEqual(
        check({ tags, manifests: at({ a: bad }) }),
        { bump: 'none', previous: '0.5.0', errors: [`a: version ${bad} is not of the form X.Y.Z.`] },
        bad,
      );
    }
  });

  test('no tags yet: the first release', () => {
    assert.deepEqual(check({ tags: [], manifests: at({ a: '0.1.0' }) }), { bump: 'first', version: '0.1.0', previous: undefined, errors: [] });
  });
});

describe('only Alok approves a major', () => {
  const approval = (/** @type {string} */ login, state = 'approved', env = ENVIRONMENT) => ({
    state,
    user: { login },
    environments: [{ name: env }],
  });

  test('his approval in the major-release environment counts', () => {
    assert.equal(majorApproved({ actor: 'release-bot', approvals: [approval(ALOK)] }), true);
    assert.equal(majorApproved({ actor: 'release-bot', approvals: [approval('release-bot'), approval(ALOK)] }), true);
    assert.equal(
      majorApproved({ actor: 'release-bot', approvals: [{ state: 'approved', user: { login: ALOK }, environments: [{ name: 'production' }, { name: ENVIRONMENT }] }] }),
      true,
    );
  });

  test('a push he made himself counts', () => {
    assert.equal(majorApproved({ actor: ALOK, approvals: [] }), true);
  });

  test("anyone else's approval, a rejection, or another environment does not", () => {
    for (const approvals of [
      [],
      [approval('release-bot')],
      [approval('alokbansal8')],
      [approval(ALOK, 'rejected')],
      [approval(ALOK, 'approved', 'production')],
      [{ state: 'approved', user: null, environments: [{ name: ENVIRONMENT }] }],
      [{ state: 'approved', user: { login: ALOK } }],
      [{ state: 'approved', user: { login: ALOK }, environments: [] }],
    ]) {
      assert.equal(majorApproved({ actor: 'release-bot', approvals }), false, JSON.stringify(approvals));
    }
    assert.equal(majorApproved({ approvals: [] }), false);
  });

  test('the refusal tells the releaser to ask Alok', () => {
    assert.equal(askAlok('1.0.0'), ask('1.0.0'));
  });
});

/** A throwaway repository: tags, and manifests by path. */
function repo(/** @type {string[]} */ tags, /** @type {Record<string, string>} */ manifests) {
  const dir = folder(manifests);
  // No automatic maintenance: a commit's detached `git maintenance run --auto`
  // outlives it and can write into the repository while the test removes it
  // (ENOTEMPTY). Nor the caller's git config: an agent session passes
  // tag.gpgsign=true through GIT_CONFIG_*, which makes `git tag` ask for a
  // message.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
  };
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd: dir, env, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root');
  for (const t of tags) git('tag', t);
  return dir;
}

// The real command line. These check the CLI end to end; Stryker sees no
// coverage from a child process, so the in-process tests below do the killing.
describe('the command line', () => {
  const run = (/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {Record<string, string>} */ env = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  test('tag: v0.5.1 after v0.5.0 passes, and writes the bump to GITHUB_OUTPUT', () => {
    const dir = repo(['v0.5.0', 'v0.5.1', 'latest'], { 'packages/a/package.json': '0.5.1', 'packages/b/package.json': '0.5.0' });
    const output = join(dir, 'out');
    const r = run(dir, ['tag', 'v0.5.1'], { GITHUB_OUTPUT: output });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'version rule: 0.5.1 is the patch release after 0.5.0.\n');
    assert.equal(readFileSync(output, 'utf8'), 'bump=patch\nversion=0.5.1\n');
  });

  test('tag: a skipped patch fails with an annotation', () => {
    const dir = repo(['v0.5.0', 'v0.5.2'], { 'packages/a/package.json': '0.5.2' });
    const r = run(dir, ['tag', 'v0.5.2']);
    assert.equal(r.code, 1);
    assert.equal(r.err, `::error::${broken('0.5.2', 'it skips a version', '0.5.0', '0.5.1')}\n`);
  });

  test('tag: a major passes this step as bump=major, with the ask-Alok warning', () => {
    const dir = repo(['v0.5.0', 'v1.0.0'], { 'package.json': '1.0.0' });
    const output = join(dir, 'out');
    const r = run(dir, ['tag', 'v1.0.0'], { GITHUB_OUTPUT: output });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, `::warning::${ask('1.0.0')} The release waits on that.\n`);
    assert.equal(readFileSync(output, 'utf8'), 'bump=major\nversion=1.0.0\n');
  });

  test('pending: explicit manifests, and nothing unreleased', () => {
    const dir = repo(['v0.5.20'], { 'package.json': '0.5.20', 'other/package.json': '0.6.0' });
    const none = run(dir, ['pending', 'package.json']);
    assert.equal(none.code, 0, none.err);
    assert.equal(none.out, 'version rule: nothing unreleased; the next release after 0.5.20 is 0.6.0.\n');
    const next = run(dir, ['pending', 'package.json', 'other/package.json']);
    assert.equal(next.code, 0, next.err);
    assert.equal(next.out, 'version rule: 0.6.0 is the minor release after 0.5.20.\n');
  });

  test('usage errors exit 2', () => {
    const dir = repo([], {});
    for (const args of [[], ['tag'], ['release', 'v1.0.0']]) {
      const r = run(dir, args);
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.err, `${USAGE}\n`);
    }
  });

  test('approval: outside a workflow run, it refuses', () => {
    const r = run(folder(), ['approval']);
    assert.equal(r.code, 1);
    assert.equal(r.err, `::error::approval needs GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_TOKEN. ${ask('this')}\n`);
  });
});

/**
 * A fake Io that records what main does with it.
 * @param {Partial<import('./version-rule.mjs').Io>} over
 * @param {{ tags?: string[], body?: unknown }} [answers] what git and GitHub answer
 */
function fakeIo(over = {}, { tags = ['v0.5.0'], body = [] } = {}) {
  const out = /** @type {string[]} */ ([]);
  const err = /** @type {string[]} */ ([]);
  const gitCalls = /** @type {string[]} */ ([]);
  const fetches = /** @type {[string, string][]} */ ([]);
  /** @type {import('./version-rule.mjs').Io} */
  const io = {
    cwd: folder(),
    env: {},
    gitTags: (cwd) => {
      gitCalls.push(cwd);
      return tags;
    },
    fetchJson: async (url, token) => {
      fetches.push([url, token]);
      return body;
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { io, out, err, gitCalls, fetches };
}

describe('main, in-process: tag and pending', () => {
  /** @param {string[]} tags @param {Record<string, string>} manifests @param {boolean} [withOutput] */
  const setup = (tags, manifests, withOutput = true) => {
    const dir = folder(manifests);
    const output = join(dir, 'github-output');
    const f = fakeIo({ cwd: dir, env: withOutput ? { GITHUB_OUTPUT: output } : {} }, { tags });
    return { ...f, dir, written: () => readFileSync(output, 'utf8') };
  };

  test('tag: the default manifests, a patch, and GITHUB_OUTPUT', async () => {
    const s = setup(['v0.5.0', 'v0.5.1'], { 'packages/a/package.json': '0.5.1', 'packages/b/package.json': '0.5.0' });
    assert.equal(await main(['tag', 'v0.5.1'], s.io), 0);
    assert.deepEqual(s.gitCalls, [s.dir]);
    assert.deepEqual(s.out, ['version rule: 0.5.1 is the patch release after 0.5.0.']);
    assert.deepEqual(s.err, []);
    assert.equal(s.written(), 'bump=patch\nversion=0.5.1\n');
  });

  test('tag: explicit manifests replace the default ones', async () => {
    const s = setup(['v0.5.0', 'v0.5.1'], { 'packages/a/package.json': '0.9.9', 'other/package.json': '0.5.1' });
    assert.equal(await main(['tag', 'v0.5.1', 'other/package.json'], s.io), 0);
    assert.deepEqual(s.out, ['version rule: 0.5.1 is the patch release after 0.5.0.']);
    assert.deepEqual(s.err, []);
  });

  test('pending: the default manifests, with no GITHUB_OUTPUT', async () => {
    const s = setup(['v0.5.0'], { 'packages/a/package.json': '0.5.1' }, false);
    assert.equal(await main(['pending'], s.io), 0);
    assert.deepEqual(s.out, ['version rule: 0.5.1 is the patch release after 0.5.0.']);
    assert.deepEqual(s.err, []);
  });

  test('pending: explicit manifests replace the default ones', async () => {
    const s = setup(['v0.5.0'], { 'packages/a/package.json': '0.9.9', 'other/package.json': '0.5.1' });
    assert.equal(await main(['pending', 'other/package.json'], s.io), 0);
    assert.deepEqual(s.out, ['version rule: 0.5.1 is the patch release after 0.5.0.']);
    assert.equal(s.written(), 'bump=patch\nversion=0.5.1\n');
  });

  test('a broken rule exits 1 with one annotation per error', async () => {
    const s = setup(['v0.5.0', 'v0.5.2'], { 'packages/a/package.json': '0.5.2', 'packages/b/package.json': '0.5.3' });
    assert.equal(await main(['tag', 'v0.5.2'], s.io), 1);
    assert.deepEqual(s.err, [
      "::error::packages/b/package.json: version 0.5.3 is neither released nor this tag's 0.5.2.",
      `::error::${broken('0.5.2', 'it skips a version', '0.5.0', '0.5.1')}`,
    ]);
    assert.deepEqual(s.out, []);
    assert.equal(s.written(), 'bump=patch\nversion=0.5.2\n');
  });

  test('differing unreleased versions exit 1, with bump=none and no version', async () => {
    const s = setup(['v0.5.0'], { 'packages/a/package.json': '0.5.1', 'packages/b/package.json': '0.5.2' });
    assert.equal(await main(['pending'], s.io), 1);
    assert.deepEqual(s.err, [
      '::error::the unreleased versions differ: 0.5.1 (packages/a/package.json); 0.5.2 (packages/b/package.json). One tag releases them all, so they share one version.',
    ]);
    assert.equal(s.written(), 'bump=none\nversion=\n');
  });

  test('a major exits 0 with bump=major and the ask-Alok warning', async () => {
    const s = setup(['v0.5.0'], { 'package.json': '1.0.0' });
    assert.equal(await main(['pending'], s.io), 0);
    assert.deepEqual(s.err, [`::warning::${ask('1.0.0')} The release waits on that.`]);
    assert.deepEqual(s.out, []);
    assert.equal(s.written(), 'bump=major\nversion=1.0.0\n');
  });

  test('the first release comes after none', async () => {
    const s = setup([], { 'package.json': '0.1.0' });
    assert.equal(await main(['pending'], s.io), 0);
    assert.deepEqual(s.out, ['version rule: 0.1.0 is the first release after none.']);
    assert.equal(s.written(), 'bump=first\nversion=0.1.0\n');
  });

  test('nothing unreleased reports the next legal release', async () => {
    const s = setup(['v0.5.20'], { 'package.json': '0.5.20' });
    assert.equal(await main(['pending'], s.io), 0);
    assert.deepEqual(s.out, ['version rule: nothing unreleased; the next release after 0.5.20 is 0.6.0.']);
    assert.deepEqual(s.err, []);
    assert.equal(s.written(), 'bump=none\nversion=\n');
  });

  test('no tags and no manifests: any 0.y.z is next', async () => {
    const s = setup([], {});
    assert.equal(await main(['pending'], s.io), 0);
    assert.deepEqual(s.out, ['version rule: nothing unreleased; the next release after none is any 0.y.z.']);
  });

  test('usage errors exit 2 and read nothing', async () => {
    for (const args of [[], ['tag'], ['release', 'v1.0.0'], ['release']]) {
      const f = fakeIo();
      assert.equal(await main(args, f.io), 2, args.join(' '));
      assert.deepEqual(f.err, [USAGE]);
      assert.deepEqual(f.out, []);
      assert.deepEqual(f.gitCalls, []);
      assert.deepEqual(f.fetches, []);
    }
  });
});

describe('main, in-process: approval', () => {
  const runEnv = { GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7', GITHUB_TOKEN: 't', VERSION: '1.0.0' };
  const approved = [{ state: 'approved', user: { login: ALOK }, environments: [{ name: ENVIRONMENT }] }];

  test('Alok approved → 0, at the API URL given, with the token', async () => {
    const f = fakeIo({ env: { ...runEnv, GITHUB_ACTOR: 'release-bot', GITHUB_API_URL: 'https://api.example' } }, { body: approved });
    assert.equal(await main(['approval'], f.io), 0);
    assert.deepEqual(f.fetches, [['https://api.example/repos/o/r/actions/runs/7/approvals', 't']]);
    assert.deepEqual(f.out, ['version rule: major release 1.0.0 approved by AlokBansal8.']);
    assert.deepEqual(f.err, []);
  });

  test("GitHub's own API by default; his own push counts", async () => {
    const f = fakeIo({ env: { ...runEnv, GITHUB_ACTOR: ALOK } });
    assert.equal(await main(['approval'], f.io), 0);
    assert.deepEqual(f.fetches, [['https://api.github.com/repos/o/r/actions/runs/7/approvals', 't']]);
    assert.deepEqual(f.out, ['version rule: major release 1.0.0 approved by AlokBansal8.']);
  });

  test('no approval → 1, ask Alok', async () => {
    const f = fakeIo({ env: { ...runEnv, GITHUB_ACTOR: 'release-bot' } });
    assert.equal(await main(['approval'], f.io), 1);
    assert.deepEqual(f.err, [`::error::${ask('1.0.0')}`]);
    assert.deepEqual(f.out, []);
  });

  test('unreadable approvals → 1, ask Alok', async () => {
    for (const body of [undefined, {}, 'approved']) {
      const f = fakeIo({ env: { ...runEnv, GITHUB_ACTOR: ALOK }, fetchJson: async () => body });
      assert.equal(await main(['approval'], f.io), 1, String(body));
      assert.deepEqual(f.err, [`::error::could not read this run's approvals. ${ask('1.0.0')}`]);
      assert.deepEqual(f.out, []);
    }
  });

  test('outside a workflow run → 1, ask Alok, and nothing fetched', async () => {
    const needs = 'approval needs GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_TOKEN.';
    for (const missing of ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_TOKEN']) {
      const env = /** @type {Record<string, string | undefined>} */ ({ ...runEnv, GITHUB_ACTOR: ALOK, [missing]: '' });
      const f = fakeIo({ env });
      assert.equal(await main(['approval'], f.io), 1, missing);
      assert.deepEqual(f.err, [`::error::${needs} ${ask('1.0.0')}`], missing);
      assert.deepEqual(f.fetches, [], missing);
    }
    const f = fakeIo({ env: { GITHUB_ACTOR: ALOK } });
    assert.equal(await main(['approval'], f.io), 1);
    assert.deepEqual(f.err, [`::error::${needs} ${ask('this')}`]);
  });
});

describe('entry', () => {
  const url = pathToFileURL(SCRIPT).href;

  // In a child, so the import is the module's first; the child inherits Stryker's active mutant.
  test("imported, it leaves the importer's exit code as it was", () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `process.exitCode = 7; await import(${JSON.stringify(url)});`], { encoding: 'utf8' });
    assert.equal(r.status, 7, r.stderr);
  });

  test('run as the script, it runs main on the arguments after it', async () => {
    const f = fakeIo({ cwd: folder({ 'package.json': '0.5.1' }) });
    assert.equal(await entry(['node', SCRIPT, 'pending'], url, f.io), 0);
    assert.deepEqual(f.out, ['version rule: 0.5.1 is the patch release after 0.5.0.']);
  });

  test('imported, it runs nothing', () => {
    const f = fakeIo();
    assert.equal(entry(['node', join(SCRIPT, '..', 'other.mjs'), 'pending'], url, f.io), undefined);
    assert.equal(entry(['node'], url, f.io), undefined);
    assert.deepEqual([f.out, f.err, f.gitCalls, f.fetches], [[], [], [], []]);
  });
});

describe('the real io', () => {
  test("this process's folder and environment, git and GitHub", () => {
    const io = realIo();
    assert.equal(io.cwd, process.cwd());
    assert.equal(io.env, process.env);
    assert.equal(io.gitTags, gitTags);
    assert.equal(io.fetchJson, fetchJson);
  });

  test('out is console.log and err is console.error', (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const error = t.mock.method(console, 'error', () => {});
    const io = realIo();
    io.out('to stdout');
    io.err('to stderr');
    assert.deepEqual(log.mock.calls.map((c) => c.arguments), [['to stdout']]);
    assert.deepEqual(error.mock.calls.map((c) => c.arguments), [['to stderr']]);
  });

  test('gitTags lists the v* tags, one per line', () => {
    /** @type {unknown[]} */
    const calls = [];
    const exec = (/** @type {string} */ file, /** @type {string[]} */ args, /** @type {{ cwd: string, encoding: 'utf8' }} */ options) => {
      calls.push([file, args, options]);
      return 'v0.5.0\nv0.5.1\n';
    };
    assert.deepEqual(gitTags('/repo', exec), ['v0.5.0', 'v0.5.1']);
    assert.deepEqual(calls, [['git', ['tag', '--list', 'v*'], { cwd: '/repo', encoding: 'utf8' }]]);
  });

  test("fetchJson sends GitHub's headers and the token, and reads only an ok response", async () => {
    /** @type {unknown[]} */
    const calls = [];
    const body = await fetchJson('https://api.example/x', 'tok', async (url, init) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ['body'] };
    });
    assert.deepEqual(body, ['body']);
    assert.deepEqual(calls, [
      [
        'https://api.example/x',
        { headers: { accept: 'application/vnd.github+json', authorization: 'Bearer tok', 'x-github-api-version': '2022-11-28' } },
      ],
    ]);
    assert.equal(await fetchJson('https://api.example/x', 'tok', async () => ({ ok: false, json: async () => ['unread'] })), undefined);
  });
});

describe('defaultManifests', () => {
  test('packages/*/package.json when there are any, else package.json, else none', () => {
    const dir = folder();
    assert.deepEqual(defaultManifests(dir), []);
    writeFileSync(join(dir, 'package.json'), '{}');
    assert.deepEqual(defaultManifests(dir), ['package.json']);
    mkdirSync(join(dir, 'packages', 'empty'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'README.md'), 'not a package');
    assert.deepEqual(defaultManifests(dir), ['package.json']);
    for (const p of ['b', 'c', 'a']) {
      mkdirSync(join(dir, 'packages', p), { recursive: true });
      writeFileSync(join(dir, 'packages', p, 'package.json'), '{}');
    }
    const sorted = [join('packages', 'a', 'package.json'), join('packages', 'b', 'package.json'), join('packages', 'c', 'package.json')];
    assert.deepEqual(defaultManifests(dir), sorted);
    // Sorted whatever order the filesystem lists them in (APFS sorts, ext4 does not).
    const listed = ['c', 'a', 'b', 'empty'].map((name) => ({ name, isDirectory: () => true }));
    assert.deepEqual(defaultManifests(dir, () => listed), sorted);
  });

  test('a link in packages/ is not a package folder, even to one', () => {
    const dir = folder({ 'elsewhere/package.json': '0.1.0', 'packages/a/package.json': '0.1.0' });
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'packages', 'link'));
    assert.deepEqual(defaultManifests(dir), [join('packages', 'a', 'package.json')]);
  });
});
