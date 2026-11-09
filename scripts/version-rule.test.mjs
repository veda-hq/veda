import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  MAJOR_DECIDER,
  MAJOR_ENVIRONMENT,
  askAlok,
  check,
  classify,
  defaultManifests,
  main,
  majorApproved,
  nextLegal,
  parse,
  releaseTags,
} from './version-rule.mjs';

const SCRIPT = fileURLToPath(new URL('./version-rule.mjs', import.meta.url));
const v = (/** @type {string} */ s) => /** @type {import('./version-rule.mjs').Version} */ (parse(s));

/** @param {string} prev @param {string} next */
const rule = (prev, next) => classify(v(prev), v(next));

describe('the version rule', () => {
  test('a normal patch is allowed', () => {
    assert.deepEqual(rule('0.5.0', '0.5.1'), { bump: 'patch' });
    assert.deepEqual(rule('0.5.19', '0.5.20'), { bump: 'patch' });
  });

  test('0.5.20 → 0.6.0 is allowed, as a minor', () => {
    assert.deepEqual(rule('0.5.20', '0.6.0'), { bump: 'minor' });
  });

  test('0.5.20 → 0.5.21 is refused: 20 is the last patch', () => {
    const r = rule('0.5.20', '0.5.21');
    assert.match(r.error ?? '', /0\.5\.20 is the last patch of its line\. The next release after 0\.5\.20 is 0\.6\.0/);
  });

  test('0.5.3 → 0.6.0 is refused: minor only after .20', () => {
    const r = rule('0.5.3', '0.6.0');
    assert.match(r.error ?? '', /the minor number goes up only after 0\.5\.20\. The next release after 0\.5\.3 is 0\.5\.4/);
  });

  test('a skipped patch is refused (0.5.0 → 0.5.2)', () => {
    assert.match(rule('0.5.0', '0.5.2').error ?? '', /it skips a version\. The next release after 0\.5\.0 is 0\.5\.1/);
  });

  test('a skipped minor is refused (0.5.20 → 0.7.0)', () => {
    assert.match(rule('0.5.20', '0.7.0').error ?? '', /it skips a version\. The next release after 0\.5\.20 is 0\.6\.0/);
  });

  test('a release not above the previous is refused', () => {
    assert.match(rule('0.5.3', '0.5.3').error ?? '', /not above the previous release 0\.5\.3/);
    assert.match(rule('0.5.3', '0.5.2').error ?? '', /not above the previous release 0\.5\.3/);
    assert.match(rule('0.5.3', '0.4.0').error ?? '', /not above the previous release 0\.5\.3/);
  });

  test('a major bump is classed major; the right shape carries no error of its own', () => {
    assert.deepEqual(rule('0.5.3', '1.0.0'), { bump: 'major' });
    assert.deepEqual(rule('1.20.20', '2.0.0'), { bump: 'major' });
  });

  test('a major bump of the wrong shape is refused outright', () => {
    for (const next of ['1.0.1', '1.1.0', '2.0.0']) {
      const r = rule('0.5.3', next);
      assert.equal(r.bump, 'major');
      assert.match(r.error ?? '', /a major release is 1\.0\.0, and only with Alok's yes/);
    }
  });

  test('the first release: any 0.y.z, and a major one is still a major', () => {
    assert.deepEqual(classify(undefined, v('0.1.0')), { bump: 'first' });
    assert.deepEqual(classify(undefined, v('1.0.0')), { bump: 'major' });
    assert.match(classify(undefined, v('1.2.0')).error ?? '', /a major release is 1\.0\.0/);
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
    const r = check({ tags: [...tags, 'v0.5.2'], tag: 'v0.5.2', manifests: [] });
    assert.match(r.errors.join('\n'), /it skips a version\. The next release after 0\.5\.0 is 0\.5\.1/);
  });

  test('a tag not of the form vX.Y.Z is refused', () => {
    for (const tag of ['0.5.1', 'v0.5.1-rc.1', 'vnext']) {
      assert.match(check({ tags, tag, manifests: [] }).errors.join(''), /is not of the form vX\.Y\.Z/, tag);
    }
  });

  test('at a tag, a package at some other unreleased version is refused', () => {
    const r = check({ tags, tag: 'v0.5.1', manifests: at({ a: '0.5.1', b: '0.5.2' }) });
    assert.deepEqual(r.errors, ["b: version 0.5.2 is neither released nor this tag's 0.5.1."]);
  });

  test('pending: one shared next version is the release to come', () => {
    const r = check({ tags, manifests: at({ dvara: '0.5.1', pariksha: '0.5.1', kavach: '0.3.0' }) });
    assert.deepEqual(r, { bump: 'patch', version: '0.5.1', previous: '0.5.0', errors: [] });
  });

  test('pending: nothing unreleased is fine', () => {
    assert.deepEqual(check({ tags, manifests: at({ a: '0.5.0', b: '0.2.0' }) }), { bump: 'none', previous: '0.5.0', errors: [] });
  });

  test('pending: a package bumped to an illegal version is refused', () => {
    assert.match(check({ tags, manifests: at({ a: '0.6.0' }) }).errors.join(''), /minor number goes up only after 0\.5\.20/);
    // Below the last tag but never released: not a version any tag can publish.
    assert.match(check({ tags, manifests: at({ a: '0.4.5' }) }).errors.join(''), /not above the previous release 0\.5\.0/);
  });

  test('pending: two different unreleased versions are refused', () => {
    const r = check({ tags, manifests: at({ a: '0.5.1', b: '0.5.2' }) });
    assert.match(r.errors.join(''), /the unreleased versions differ: 0\.5\.1 \(a\); 0\.5\.2 \(b\)/);
    assert.equal(r.bump, 'none');
  });

  test('pending: a major is classed major, for the approval step to refuse', () => {
    assert.deepEqual(check({ tags, manifests: at({ a: '1.0.0' }) }), { bump: 'major', version: '1.0.0', previous: '0.5.0', errors: [] });
  });

  test('a manifest version not of the form X.Y.Z is refused', () => {
    for (const bad of ['v0.5.1', '0.5.1-rc.1', 'undefined']) {
      assert.match(check({ tags, manifests: at({ a: bad }) }).errors.join(''), /a: version .* is not of the form X\.Y\.Z/, bad);
    }
  });

  test('no tags yet: the first release', () => {
    assert.deepEqual(check({ tags: [], manifests: at({ a: '0.1.0' }) }), { bump: 'first', version: '0.1.0', previous: undefined, errors: [] });
  });
});

describe('only Alok approves a major', () => {
  const approval = (/** @type {string} */ login, state = 'approved', env = MAJOR_ENVIRONMENT) => ({
    state,
    user: { login },
    environments: [{ name: env }],
  });

  test('his approval in the major-release environment counts', () => {
    assert.equal(majorApproved({ actor: 'release-bot', approvals: [approval(MAJOR_DECIDER)] }), true);
  });

  test('a push he made himself counts', () => {
    assert.equal(majorApproved({ actor: MAJOR_DECIDER, approvals: [] }), true);
  });

  test("anyone else's approval, a rejection, or another environment does not", () => {
    for (const approvals of [
      [],
      [approval('release-bot')],
      [approval('alokbansal8')],
      [approval(MAJOR_DECIDER, 'rejected')],
      [approval(MAJOR_DECIDER, 'approved', 'production')],
      [{ state: 'approved', user: null, environments: [{ name: MAJOR_ENVIRONMENT }] }],
      [{ state: 'approved', user: { login: MAJOR_DECIDER } }],
    ]) {
      assert.equal(majorApproved({ actor: 'release-bot', approvals }), false, JSON.stringify(approvals));
    }
    assert.equal(majorApproved({ approvals: [] }), false);
  });

  test('the refusal tells the releaser to ask Alok', () => {
    assert.match(askAlok('1.0.0'), /^1\.0\.0 is a major bump\. Only Alok decides a major version: ask him/);
    assert.match(askAlok('1.0.0'), /"major-release" deployment/);
  });
});

/** A throwaway repository: tags, and manifests by path. */
function repo(/** @type {string[]} */ tags, /** @type {Record<string, string>} */ manifests) {
  const dir = mkdtempSync(join(tmpdir(), 'version-rule-'));
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root');
  for (const t of tags) git('tag', t);
  for (const [path, version] of Object.entries(manifests)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify({ name: path, version }));
  }
  return dir;
}

describe('the command line', () => {
  /** @type {string[]} */
  const dirs = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const run = (/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {Record<string, string>} */ env = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  test('tag: v0.5.1 after v0.5.0 passes, and writes the bump to GITHUB_OUTPUT', () => {
    const dir = repo(['v0.5.0', 'v0.5.1'], { 'packages/a/package.json': '0.5.1', 'packages/b/package.json': '0.5.0' });
    dirs.push(dir);
    const output = join(dir, 'out');
    const r = run(dir, ['tag', 'v0.5.1'], { GITHUB_OUTPUT: output });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /0\.5\.1 is the patch release after 0\.5\.0/);
    assert.equal(readFileSync(output, 'utf8'), 'bump=patch\nversion=0.5.1\n');
  });

  test('tag: a skipped patch fails with an annotation', () => {
    const dir = repo(['v0.5.0', 'v0.5.2'], { 'packages/a/package.json': '0.5.2' });
    dirs.push(dir);
    const r = run(dir, ['tag', 'v0.5.2']);
    assert.equal(r.code, 1);
    assert.match(r.err, /::error::0\.5\.2 breaks the version rule: it skips a version/);
  });

  test('tag: a major passes this step as bump=major, with the ask-Alok warning', () => {
    const dir = repo(['v0.5.0', 'v1.0.0'], { 'package.json': '1.0.0' });
    dirs.push(dir);
    const output = join(dir, 'out');
    const r = run(dir, ['tag', 'v1.0.0'], { GITHUB_OUTPUT: output });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /::warning::1\.0\.0 is a major bump\. Only Alok decides/);
    assert.equal(readFileSync(output, 'utf8'), 'bump=major\nversion=1.0.0\n');
  });

  test('pending: explicit manifests, and nothing unreleased', () => {
    const dir = repo(['v0.5.20'], { 'package.json': '0.5.20', 'other/package.json': '0.6.0' });
    dirs.push(dir);
    const none = run(dir, ['pending', 'package.json']);
    assert.equal(none.code, 0, none.err);
    assert.match(none.out, /nothing unreleased; the next release after 0\.5\.20 is 0\.6\.0/);
    const next = run(dir, ['pending', 'package.json', 'other/package.json']);
    assert.equal(next.code, 0, next.err);
    assert.match(next.out, /0\.6\.0 is the minor release after 0\.5\.20/);
  });

  test('usage errors exit 2', () => {
    const dir = repo([], {});
    dirs.push(dir);
    assert.equal(run(dir, []).code, 2);
    assert.equal(run(dir, ['tag']).code, 2);
    assert.equal(run(dir, ['release', 'v1.0.0']).code, 2);
  });
});

describe('main, in-process', () => {
  const io = (/** @type {Partial<import('./version-rule.mjs').Io>} */ over = {}) => {
    /** @type {string[]} */ const out = [];
    /** @type {string[]} */ const err = [];
    /** @type {import('./version-rule.mjs').Io} */
    const base = {
      cwd: tmpdir(),
      env: {},
      gitTags: () => ['v0.5.0'],
      fetchJson: async () => [],
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      ...over,
    };
    return { base, out, err };
  };
  const runEnv = { GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7', GITHUB_TOKEN: 't', VERSION: '1.0.0' };

  test('approval: Alok approved → 0, and the approvals URL names the run', async () => {
    /** @type {string[]} */ const urls = [];
    const { base, out } = io({
      env: { ...runEnv, GITHUB_ACTOR: 'release-bot', GITHUB_API_URL: 'https://api.example' },
      fetchJson: async (url) => {
        urls.push(url);
        return [{ state: 'approved', user: { login: MAJOR_DECIDER }, environments: [{ name: MAJOR_ENVIRONMENT }] }];
      },
    });
    assert.equal(await main(['approval'], base), 0);
    assert.deepEqual(urls, ['https://api.example/repos/o/r/actions/runs/7/approvals']);
    assert.match(out.join(''), /major release 1\.0\.0 approved by AlokBansal8/);
  });

  test('approval: no approval → 1, ask Alok', async () => {
    const { base, err } = io({ env: { ...runEnv, GITHUB_ACTOR: 'release-bot' } });
    assert.equal(await main(['approval'], base), 1);
    assert.match(err.join(''), /::error::1\.0\.0 is a major bump\. Only Alok decides a major version: ask him/);
  });

  test('approval: unreadable approvals → 1, ask Alok', async () => {
    const { base, err } = io({ env: runEnv, fetchJson: async () => undefined });
    assert.equal(await main(['approval'], base), 1);
    assert.match(err.join(''), /could not read this run's approvals\. 1\.0\.0 is a major bump/);
  });

  test('approval: outside a workflow run → 1, ask Alok', async () => {
    const { base, err } = io({ env: { GITHUB_ACTOR: MAJOR_DECIDER } });
    assert.equal(await main(['approval'], base), 1);
    assert.match(err.join(''), /approval needs GITHUB_REPOSITORY.*this is a major bump/);
  });

  test('pending with no manifests at all reports the next legal release', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'version-rule-empty-'));
    try {
      const { base, out } = io({ cwd: empty, gitTags: () => [] });
      assert.equal(await main(['pending'], base), 0);
      assert.match(out.join(''), /nothing unreleased; the next release after none is any 0\.y\.z/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('defaultManifests', () => {
  test('packages/*/package.json when there are any, else package.json, else none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'version-rule-m-'));
    try {
      assert.deepEqual(defaultManifests(dir), []);
      writeFileSync(join(dir, 'package.json'), '{}');
      assert.deepEqual(defaultManifests(dir), ['package.json']);
      mkdirSync(join(dir, 'packages', 'empty'), { recursive: true });
      assert.deepEqual(defaultManifests(dir), ['package.json']);
      for (const p of ['b', 'a']) {
        mkdirSync(join(dir, 'packages', p), { recursive: true });
        writeFileSync(join(dir, 'packages', p, 'package.json'), '{}');
      }
      assert.deepEqual(defaultManifests(dir), [join('packages', 'a', 'package.json'), join('packages', 'b', 'package.json')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
