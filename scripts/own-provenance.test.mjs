// scripts/own-provenance.mjs, offline: the registry's answers are built here,
// or are real ones saved under fixtures/.
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  attestationsUrl,
  bundleVerifier,
  check,
  entry,
  fetchJson,
  ISSUER,
  main,
  OTHER_REPOSITORIES,
  ownPackages,
  provenanceFailures,
  readText,
  REPOSITORY,
  repositoryOf,
  signingPolicy,
  SLSA,
  tagCommit,
  tagUrl,
  TRUSTED_ROOT,
  WORKFLOW,
} from './own-provenance.mjs';

// Most tests are synchronous. One turn of the event loop before each lets the
// TAP line of a failed test reach stdout at once, so Stryker's tap runner
// bails on a mutant's first failure instead of running the whole file.
beforeEach(() => new Promise(resolve => setImmediate(resolve)));

/** Signature checks are tested on real bundles below; the statement tests accept any. */
const accept = () => {};

const INTEGRITY = `sha512-${Buffer.from('tarball').toString('base64')}`;
const DIGEST = Buffer.from('tarball').toString('hex');
const pkg = { name: '@veda-hq/sarathi', version: '0.6.0', integrity: INTEGRITY };

/** A registry attestations response whose SLSA statement is `statement`. @param {unknown} statement */
const served = statement => ({
  attestations: [
    { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: {} },
    { predicateType: SLSA, bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } },
  ],
});

/** veda's release of `version`, with workflow fields overridden. @param {string} version @param {object} [workflow] @param {string} [digest] */
const release = (version, workflow = {}, digest = DIGEST) =>
  served({
    subject: [{ name: `pkg:npm/%40veda-hq/sarathi@${version}`, digest: { sha512: digest } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { repository: REPOSITORY, path: WORKFLOW, ref: `refs/tags/v${version}`, ...workflow } } } },
  });

const NIYAM_REPO = 'https://github.com/veda-hq/niyam';
/** The commit niyam's v0.7.1 tag names, which its release from main built. */
const TAGGED = 'c7299473f3bb0fe17a11d8e8e25c91295331705f';
/** The commit niyam's v0.6.16 tag names. */
const OTHER = 'bc57410ee10806f10234785f2561dda259e0a0d2';

/** niyam's release of `version` from main at `commit`, with workflow fields overridden. @param {string} version @param {string} commit @param {object} [workflow] */
const niyamRelease = (version, commit, workflow = {}) => {
  const fields = { repository: NIYAM_REPO, path: WORKFLOW, ref: 'refs/heads/main', ...workflow };
  return served({
    subject: [{ name: `pkg:npm/%40veda-hq/niyam@${version}`, digest: { sha512: DIGEST } }],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: fields },
        resolvedDependencies: [{ uri: `git+${fields.repository}@${fields.ref}`, digest: { gitCommit: commit } }],
      },
    },
  });
};

const LOCK = [
  'packages:',
  '',
  "  '@veda-hq/kavach@0.6.0':",
  `    resolution: {integrity: ${INTEGRITY}}`,
  "    engines: {node: '>=24.15'}",
  '',
  "  '@veda-hq/sarathi@0.6.0':",
  `    resolution: {integrity: ${INTEGRITY}}`,
  '',
  "  'js-yaml@4.1.0':",
  `    resolution: {integrity: ${INTEGRITY}}`,
  '',
  'snapshots:',
  '',
  "  '@veda-hq/kavach@0.6.0': {}",
  '',
].join('\n');

describe('ownPackages', () => {
  test('reads each @veda-hq package once, from the packages section', () => {
    assert.deepEqual(ownPackages(LOCK), {
      packages: [
        { name: '@veda-hq/kavach', version: '0.6.0', integrity: INTEGRITY },
        { name: '@veda-hq/sarathi', version: '0.6.0', integrity: INTEGRITY },
      ],
      unread: [],
    });
  });
  test('a lockfile with none has none', () => assert.deepEqual(ownPackages('packages:\n'), { packages: [], unread: [] }));
  test('an own key in a shape it does not read is named, never skipped', () => {
    const lock = [
      'packages:',
      "  '@veda-hq/dvara@0.7.0-rc.1':",
      `    resolution: {integrity: ${INTEGRITY}}`,
      '  @veda-hq/niyam@0.6.14:',
      '    resolution: {tarball: https://github.com/veda-hq/niyam/releases/download/v0.6.14/niyam.tgz}',
      "  '@veda-hq/pariksha@0.5.20':",
      `    resolution: {integrity: ${INTEGRITY}, tarball: x}`,
      'snapshots:',
      "  '@veda-hq/pariksha@0.5.20(typescript@5.9.3)': {}",
      '',
    ].join('\n');
    assert.deepEqual(ownPackages(lock), { packages: [], unread: ['@veda-hq/dvara@0.7.0-rc.1', '@veda-hq/niyam@0.6.14', '@veda-hq/pariksha@0.5.20'] });
  });
  test('reads a key at two spaces, quoted or not, with any number of digits, and nothing after its integrity', () => {
    const lock = [
      'packages:',
      '  @veda-hq/kavach@10.20.30:',
      `    resolution: {integrity: ${INTEGRITY}}`,
      "   '@veda-hq/dvara@1.0.0':",
      `    resolution: {integrity: ${INTEGRITY}}`,
      "  '@veda-hq/sarathi@1.0.0':",
      `    resolution: {integrity: ${INTEGRITY}} # x`,
      "  '@veda-hq/local@link:packages/local':",
      '    resolution: {directory: packages/local}',
      '',
    ].join('\n');
    assert.deepEqual(ownPackages(lock), {
      packages: [{ name: '@veda-hq/kavach', version: '10.20.30', integrity: INTEGRITY }],
      unread: ['@veda-hq/sarathi@1.0.0', '@veda-hq/local@link:packages/local'],
    });
  });
});

test('attestationsUrl escapes the scope', () => {
  assert.equal(attestationsUrl('@veda-hq/sarathi', '0.6.0'), 'https://registry.npmjs.org/-/npm/v1/attestations/@veda-hq%2fsarathi@0.6.0');
});

describe('provenanceFailures', () => {
  test("veda's release of the version passes", () => assert.deepEqual(provenanceFailures(pkg, release('0.6.0'), accept), []));

  test('another repository, workflow or tag fails', () => {
    const cases = [
      [{ repository: 'https://github.com/someone/veda' }, /workflow repository "https:\/\/github.com\/someone\/veda"/],
      [{ path: '.github/workflows/other.yml' }, /workflow path/],
      [{ ref: 'refs/heads/main' }, /workflow ref "refs\/heads\/main", not "refs\/tags\/v0.6.0"/],
    ];
    for (const [workflow, reason] of cases) {
      const failures = provenanceFailures(pkg, release('0.6.0', workflow), accept);
      assert.equal(failures.length, 1);
      assert.match(failures[0], reason);
    }
  });

  test('a release of another version fails on the tag', () => {
    assert.match(provenanceFailures(pkg, release('0.5.15'), accept).join('\n'), /refs\/tags\/v0.5.15/);
  });

  test('another tarball fails', () => {
    assert.deepEqual(provenanceFailures(pkg, release('0.6.0', {}, 'beef'), accept), ['@veda-hq/sarathi@0.6.0: the attested tarball is not the one the lockfile installs']);
  });

  test('missing provenance fails, whatever shape the answer has', () => {
    for (const [document, reason] of [
      [null, 'the registry served no attestations'],
      [{}, 'the registry served no attestations'],
      [{ attestations: [{ predicateType: 'other' }] }, 'it has no SLSA provenance'],
      [{ attestations: [{ predicateType: SLSA, bundle: { dsseEnvelope: { payload: Buffer.from('{').toString('base64') } } }] }, 'its SLSA provenance is not JSON'],
    ]) {
      assert.deepEqual(provenanceFailures(pkg, document, accept), [`@veda-hq/sarathi@0.6.0: ${reason}`]);
    }
  });

  test('a statement with no workflow or subjects fails on each', () => {
    const failures = provenanceFailures(pkg, served({}), accept);
    assert.equal(failures.length, 4);
    assert.match(failures[0], /repository null/);
  });

  test('an attestation or bundle missing a field reads as no provenance, not a crash', () => {
    const good = release('0.6.0').attestations[1];
    assert.deepEqual(provenanceFailures(pkg, { attestations: [null, good] }, accept), []);
    for (const attestations of [[{ predicateType: SLSA }], [{ predicateType: SLSA, bundle: {} }], [{ predicateType: SLSA, bundle: { dsseEnvelope: { payload: 7 } } }]]) {
      assert.deepEqual(provenanceFailures(pkg, { attestations }, accept), ['@veda-hq/sarathi@0.6.0: it has no SLSA provenance']);
    }
  });

  test('a statement cut short at any depth fails on each field, not a crash', () => {
    const everything = [
      '@veda-hq/sarathi@0.6.0: built with workflow repository null, not "https://github.com/veda-hq/veda"',
      '@veda-hq/sarathi@0.6.0: built with workflow path null, not ".github/workflows/release.yml"',
      '@veda-hq/sarathi@0.6.0: built with workflow ref null, not "refs/tags/v0.6.0"',
      '@veda-hq/sarathi@0.6.0: the attested tarball is not the one the lockfile installs',
    ];
    for (const statement of [null, {}, { predicate: {} }, { predicate: { buildDefinition: {} } }, { predicate: { buildDefinition: { externalParameters: {} } } }]) {
      assert.deepEqual(provenanceFailures(pkg, served(statement), accept), everything);
    }
  });

  test('the attested tarball is found among subjects of any shape, and only in a list', () => {
    const workflow = { repository: REPOSITORY, path: WORKFLOW, ref: 'refs/tags/v0.6.0' };
    const predicate = { buildDefinition: { externalParameters: { workflow } } };
    assert.deepEqual(provenanceFailures(pkg, served({ subject: [null, {}, { digest: {} }, { digest: { sha512: DIGEST } }], predicate }), accept), []);
    assert.deepEqual(provenanceFailures(pkg, served({ subject: { digest: { sha512: DIGEST } }, predicate }), accept), [
      '@veda-hq/sarathi@0.6.0: the attested tarball is not the one the lockfile installs',
    ]);
  });
});

describe('check', () => {
  test('asks the registry for each own package, and gathers the failures', async () => {
    const asked = [];
    const policies = [];
    const { packages, failures } = await check(
      LOCK,
      async url => {
        asked.push(url);
        if (url.includes('kavach')) throw new Error('HTTP 404');
        return release('0.6.0');
      },
      (bundle, policy) => {
        policies.push(policy);
        throw new Error('no signature');
      },
    );
    assert.equal(packages.length, 2);
    assert.deepEqual(asked, [attestationsUrl('@veda-hq/kavach', '0.6.0'), attestationsUrl('@veda-hq/sarathi', '0.6.0')]);
    assert.deepEqual(policies, [signingPolicy('0.6.0')]);
    assert.deepEqual(failures, [
      '@veda-hq/kavach@0.6.0: its attestations could not be read (HTTP 404)',
      "@veda-hq/sarathi@0.6.0: its provenance is not signed by veda-hq/veda's release of v0.6.0 (no signature)",
    ]);
  });

  test('fails on what it cannot read, and on a lockfile with no own package', async () => {
    const never = async () => assert.fail('nothing to fetch');
    const unread = await check("packages:\n  '@veda-hq/dvara@1.0.0-rc.1':\n    resolution: {tarball: x}\n", never, accept);
    assert.deepEqual(unread.failures, [
      '@veda-hq/dvara@1.0.0-rc.1: the lockfile names it in a shape this check does not read, so it is not checked',
      'the lockfile resolves no @veda-hq/ package, so nothing was checked',
    ]);
    assert.deepEqual((await check('packages:\n', never, accept)).failures, ['the lockfile resolves no @veda-hq/ package, so nothing was checked']);
  });
});

test('signingPolicy names the release workflow at the tag, issued by GitHub Actions', () => {
  assert.deepEqual(signingPolicy('0.6.0'), {
    subjectAlternativeName: 'https://github.com/veda-hq/veda/.github/workflows/release.yml@refs/tags/v0.6.0',
    extensions: { issuer: 'https://token.actions.githubusercontent.com' },
  });
  assert.equal(ISSUER, 'https://token.actions.githubusercontent.com');
  assert.equal(signingPolicy('0.6.16', OTHER_REPOSITORIES['@veda-hq/niyam']).subjectAlternativeName, 'https://github.com/veda-hq/niyam/.github/workflows/release.yml@refs/tags/v0.6.16');
});

test('repositoryOf names niyam its own repository, and every other own package veda', () => {
  assert.equal(repositoryOf('@veda-hq/niyam'), 'https://github.com/veda-hq/niyam');
  for (const name of ['@veda-hq/sarathi', '@veda-hq/kavach', '@veda-hq/toString', '@veda-hq/__proto__']) assert.equal(repositoryOf(name), REPOSITORY);
});

test("a niyam statement naming veda's release fails, and a veda one naming niyam's", () => {
  const niyam = { ...pkg, name: '@veda-hq/niyam' };
  assert.deepEqual(provenanceFailures(niyam, niyamRelease('0.6.0', TAGGED, { repository: REPOSITORY }), accept, TAGGED), [
    '@veda-hq/niyam@0.6.0: built with workflow repository "https://github.com/veda-hq/veda", not "https://github.com/veda-hq/niyam"',
    `@veda-hq/niyam@0.6.0: built from commit null, not ${TAGGED}, the commit veda-hq/niyam's tag v0.6.0 names`,
  ]);
  assert.deepEqual(provenanceFailures(niyam, niyamRelease('0.6.0', TAGGED), accept, TAGGED), []);
  assert.deepEqual(provenanceFailures(pkg, release('0.6.0', { repository: 'https://github.com/veda-hq/niyam' }), accept), [
    '@veda-hq/sarathi@0.6.0: built with workflow repository "https://github.com/veda-hq/niyam", not "https://github.com/veda-hq/veda"',
  ]);
});

describe('niyam, released from main', () => {
  const niyam = { ...pkg, name: '@veda-hq/niyam', version: '0.7.1' };

  test('built from main at the commit its tag names passes, signed under the main policy', () => {
    const policies = [];
    assert.deepEqual(provenanceFailures(niyam, niyamRelease('0.7.1', TAGGED), (bundle, policy) => void policies.push(policy), TAGGED), []);
    assert.deepEqual(policies, [signingPolicy('0.7.1', NIYAM_REPO, TAGGED)]);
  });

  test('built from main at another commit than its tag names is refused', () => {
    assert.deepEqual(provenanceFailures(niyam, niyamRelease('0.7.1', OTHER), accept, TAGGED), [
      `@veda-hq/niyam@0.7.1: built from commit "${OTHER}", not ${TAGGED}, the commit veda-hq/niyam's tag v0.7.1 names`,
    ]);
  });

  test('built from its tag, or from another branch, is refused', () => {
    for (const ref of ['refs/tags/v0.7.1', 'refs/heads/main2']) {
      const failures = provenanceFailures(niyam, niyamRelease('0.7.1', TAGGED, { ref }), accept, TAGGED);
      assert.deepEqual(failures[0], `@veda-hq/niyam@0.7.1: built with workflow ref ${JSON.stringify(ref)}, not "refs/heads/main"`);
    }
  });

  test('with no tag commit to bind it to, it is refused before anything is read', () => {
    for (const commit of [undefined, '', 'c7299473', TAGGED.toUpperCase(), `x${TAGGED}`, `${TAGGED}0`, [TAGGED]]) {
      assert.deepEqual(provenanceFailures(niyam, niyamRelease('0.7.1', TAGGED), () => assert.fail('nothing to verify'), commit), [
        "@veda-hq/niyam@0.7.1: no commit of veda-hq/niyam's tag v0.7.1 was given, so nothing binds its build from main to its version",
      ]);
    }
  });

  test('a statement cut short at any depth, or with its source missing a field, names no commit, not a crash', () => {
    const at = '@veda-hq/niyam@0.7.1';
    const noCommit = `${at}: built from commit null, not ${TAGGED}, the commit veda-hq/niyam's tag v0.7.1 names`;
    const noWorkflow = ['repository null, not "https://github.com/veda-hq/niyam"', 'path null, not ".github/workflows/release.yml"', 'ref null, not "refs/heads/main"'].map(
      field => `${at}: built with workflow ${field}`,
    );
    const noTarball = `${at}: the attested tarball is not the one the lockfile installs`;
    for (const statement of [null, {}, { predicate: {} }, { predicate: { buildDefinition: {} } }]) {
      assert.deepEqual(provenanceFailures(niyam, served(statement), accept, TAGGED), [...noWorkflow, noCommit, noTarball]);
    }
    const fields = { repository: NIYAM_REPO, path: WORKFLOW, ref: 'refs/heads/main' };
    const uri = 'git+https://github.com/veda-hq/niyam@refs/heads/main';
    /** @param {unknown} resolvedDependencies */
    const builtWith = resolvedDependencies =>
      served({ subject: [{ digest: { sha512: DIGEST } }], predicate: { buildDefinition: { externalParameters: { workflow: fields }, resolvedDependencies } } });
    for (const dependencies of [[null, { uri }], [{ uri, digest: {} }], { uri, digest: { gitCommit: TAGGED } }, [{ uri: `${uri}2`, digest: { gitCommit: TAGGED } }]]) {
      assert.deepEqual(provenanceFailures(niyam, builtWith(dependencies), accept, TAGGED), [noCommit]);
    }
    assert.deepEqual(provenanceFailures(niyam, builtWith([null, {}, { uri, digest: { gitCommit: TAGGED } }]), accept, TAGGED), []);
  });

  test('any other own package built from main is still refused, whatever commit is given', () => {
    const policies = [];
    const failures = provenanceFailures(pkg, release('0.6.0', { ref: 'refs/heads/main' }), (bundle, policy) => void policies.push(policy), TAGGED);
    assert.deepEqual(failures, ['@veda-hq/sarathi@0.6.0: built with workflow ref "refs/heads/main", not "refs/tags/v0.6.0"']);
    assert.deepEqual(policies, [signingPolicy('0.6.0')]);
  });

  test('signingPolicy on main names the workflow on main, and the commit and exactly main as DER UTF8Strings', () => {
    const policy = signingPolicy('0.7.1', NIYAM_REPO, TAGGED);
    assert.equal(policy.subjectAlternativeName, 'https://github.com/veda-hq/niyam/.github/workflows/release.yml@refs/heads/main');
    assert.deepEqual(policy.extensions, { issuer: ISSUER });
    assert.deepEqual(policy.oids, [
      { oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, 13] }, value: Buffer.from(`\x0c\x28${TAGGED}`, 'latin1') },
      { oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, 14] }, value: Buffer.from('\x0c\x0frefs/heads/main', 'latin1') },
    ]);
  });
});

describe('tagCommit', () => {
  const TAG_OBJECT = 'a'.repeat(40);
  /** A GitHub that answers each URL from `answers`, and 404s the rest. @param {Record<string, unknown>} answers */
  const github = answers => async url => {
    if (Object.hasOwn(answers, url)) return answers[url];
    throw new Error('HTTP 404');
  };
  const REF = 'https://api.github.com/repos/veda-hq/niyam/git/ref/tags/v0.7.1';
  const ANNOTATED = `https://api.github.com/repos/veda-hq/niyam/git/tags/${TAG_OBJECT}`;

  test('reads the exact tag ref', () => assert.equal(tagUrl(NIYAM_REPO, '0.7.1'), REF));

  test('a lightweight tag names its commit', async () => {
    assert.deepEqual(await tagCommit(NIYAM_REPO, '0.7.1', github({ [REF]: { object: { type: 'commit', sha: TAGGED } } })), { commit: TAGGED });
  });

  test('an annotated tag is followed to its commit', async () => {
    const answers = { [REF]: { object: { type: 'tag', sha: TAG_OBJECT } }, [ANNOTATED]: { object: { type: 'commit', sha: TAGGED } } };
    assert.deepEqual(await tagCommit(NIYAM_REPO, '0.7.1', github(answers)), { commit: TAGGED });
  });

  test('a missing tag, or a GitHub that cannot be asked, is a problem, never a commit', async () => {
    assert.deepEqual(await tagCommit(NIYAM_REPO, '0.7.1', github({})), {
      problem: "veda-hq/niyam's tag v0.7.1 could not be read from GitHub (HTTP 404), so nothing binds its build from main to v0.7.1",
    });
    const annotatedGone = { [REF]: { object: { type: 'tag', sha: TAG_OBJECT } } };
    assert.deepEqual(await tagCommit(NIYAM_REPO, '0.7.1', github(annotatedGone)), {
      problem: "veda-hq/niyam's tag v0.7.1 could not be read from GitHub (HTTP 404), so nothing binds its build from main to v0.7.1",
    });
  });

  /** The problem of a tag whose object is `json`. @param {string} json */
  const namesNoCommit = json => ({ problem: `veda-hq/niyam's tag v0.7.1 names no commit on GitHub (its object is ${json}), so nothing binds its build from main to v0.7.1` });

  test('an answer that names no commit is a problem', async () => {
    const answers = [
      [null, 'null'],
      [{}, 'null'],
      [[], 'null'],
      [{ object: { type: 'tree', sha: TAGGED } }, `{"type":"tree","sha":"${TAGGED}"}`],
      [{ object: { type: 'commit', sha: 'c7299473' } }, '{"type":"commit","sha":"c7299473"}'],
      [{ object: { type: 'commit', sha: `x${TAGGED}` } }, `{"type":"commit","sha":"x${TAGGED}"}`],
      [{ object: { type: 'commit', sha: `${TAGGED}0` } }, `{"type":"commit","sha":"${TAGGED}0"}`],
      [{ object: { type: 'commit', sha: 7 } }, '{"type":"commit","sha":7}'],
      [{ object: { type: 'commit', sha: [TAGGED] } }, `{"type":"commit","sha":["${TAGGED}"]}`],
    ];
    for (const [answer, json] of answers) {
      assert.deepEqual(await tagCommit(NIYAM_REPO, '0.7.1', github({ [REF]: answer })), namesNoCommit(json));
    }
    const nested = { [REF]: { object: { type: 'tag', sha: TAG_OBJECT } }, [ANNOTATED]: { object: { type: 'tag', sha: TAG_OBJECT } } };
    assert.deepEqual(await tagCommit(NIYAM_REPO, '0.7.1', github(nested)), namesNoCommit(`{"type":"tag","sha":"${TAG_OBJECT}"}`));
  });

  test('an annotated tag GitHub answers with nothing names no commit', async () => {
    assert.deepEqual(await tagCommit(NIYAM_REPO, '0.7.1', github({ [REF]: { object: { type: 'tag', sha: TAG_OBJECT } }, [ANNOTATED]: null })), namesNoCommit('null'));
  });

  test('a tag object with no commit id is not followed', async () => {
    const asked = [];
    const answer = { object: { type: 'tag', sha: 'not-a-commit' } };
    const ask = async url => {
      asked.push(url);
      return github({ [REF]: answer })(url);
    };
    assert.deepEqual(await tagCommit(NIYAM_REPO, '0.7.1', ask), namesNoCommit('{"type":"tag","sha":"not-a-commit"}'));
    assert.deepEqual(asked, [REF]);
  });
});

describe('check, for niyam', () => {
  const NIYAM_LOCK = ['packages:', '', "  '@veda-hq/niyam@0.7.1':", `    resolution: {integrity: ${INTEGRITY}}`, ''].join('\n');
  const REF = 'https://api.github.com/repos/veda-hq/niyam/git/ref/tags/v0.7.1';
  /** @param {unknown} tag what GitHub answers for the tag, or undefined for a 404 @param {string[]} asked */
  const answers = (tag, asked) => async url => {
    asked.push(url);
    if (url === REF) {
      if (tag === undefined) throw new Error('HTTP 404');
      return tag;
    }
    if (url === attestationsUrl('@veda-hq/niyam', '0.7.1')) return niyamRelease('0.7.1', TAGGED);
    throw new Error(`unexpected ${url}`);
  };

  test('built from main where the tag names that commit: passes', async () => {
    const asked = [];
    const policies = [];
    const { failures } = await check(NIYAM_LOCK, answers({ object: { type: 'commit', sha: TAGGED } }, asked), (bundle, policy) => void policies.push(policy));
    assert.deepEqual(failures, []);
    assert.deepEqual(asked, [REF, attestationsUrl('@veda-hq/niyam', '0.7.1')]);
    assert.deepEqual(policies, [signingPolicy('0.7.1', NIYAM_REPO, TAGGED)]);
  });

  test('built from main where the tag names another commit: refused', async () => {
    const { failures } = await check(NIYAM_LOCK, answers({ object: { type: 'commit', sha: OTHER } }, []), accept);
    assert.deepEqual(failures, [`@veda-hq/niyam@0.7.1: built from commit "${TAGGED}", not ${OTHER}, the commit veda-hq/niyam's tag v0.7.1 names`]);
  });

  test('built from main with no tag: refused, and its attestations are not asked for', async () => {
    const asked = [];
    const { failures } = await check(NIYAM_LOCK, answers(undefined, asked), () => assert.fail('nothing to verify'));
    assert.deepEqual(failures, [
      "@veda-hq/niyam@0.7.1: veda-hq/niyam's tag v0.7.1 could not be read from GitHub (HTTP 404), so nothing binds its build from main to v0.7.1",
    ]);
    assert.deepEqual(asked, [REF]);
  });
});

// Real registry answers, verified against the committed trusted root with no network.
describe('the Sigstore bundle, on real attestations', () => {
  const verifyBundle = bundleVerifier(readFileSync(TRUSTED_ROOT, 'utf8'));
  /** @param {string} name */
  const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
  const KAVACH = fixture('attestations-kavach-0.6.0.json');
  const kavach = {
    name: '@veda-hq/kavach',
    version: '0.6.0',
    integrity: 'sha512-Oc8MEAjnvKsmIYahAQ561gv4jTvktVLeMBo8otnDwqF0ywsK63H6cpVdkfrBGROqeuKO7v0slO5bl6tcWAFMdQ==',
  };
  const notSigned = (version, reason) => `@veda-hq/kavach@${version}: its provenance is not signed by veda-hq/veda's release of v${version} (${reason})`;
  /** `document` with its SLSA bundle changed by `edit`. @param {any} document @param {(bundle: any) => void} edit */
  const withBundle = (document, edit) => {
    const copy = structuredClone(document);
    edit(copy.attestations.find(a => a.predicateType === SLSA).bundle);
    return copy;
  };

  test("kavach 0.6.0, as veda's release published it, passes", () => {
    assert.deepEqual(provenanceFailures(kavach, KAVACH, verifyBundle), []);
  });

  const NIYAM = fixture('attestations-niyam-0.6.16.json');
  const niyam = {
    name: '@veda-hq/niyam',
    version: '0.6.16',
    integrity: 'sha512-CMHf45Qd3NIEkvWAsGWhInubulZmFcHbe2ABaFK7g46vt6BAYp5Kdd6LXDeRv71sz2y/skk80/rCJ8tmpWUJNA==',
  };
  const NIYAM_REPOSITORY = 'https://github.com/veda-hq/niyam';

  const NIYAM_071 = fixture('attestations-niyam-0.7.1.json');
  const niyam071 = {
    name: '@veda-hq/niyam',
    version: '0.7.1',
    integrity: 'sha512-99aRxQsWROgoTMsGr57fLk+HYDFuKyVcA181W/oFB0itm1PCMCqFl4l03uSOedsUBJBgK7cRHEWZQ/ONbuQZiA==',
  };

  test("niyam 0.7.1, built from main at the commit its tag names, passes", () => {
    assert.deepEqual(provenanceFailures(niyam071, NIYAM_071, verifyBundle, TAGGED), []);
  });

  test('niyam 0.7.1 offered against a tag naming another commit fails on the certificate and the statement', () => {
    assert.deepEqual(provenanceFailures(niyam071, NIYAM_071, verifyBundle, OTHER), [
      `@veda-hq/niyam@0.7.1: its provenance is not signed by veda-hq/niyam's release of ${OTHER}, the commit its tag v0.7.1 names (invalid certificate extension - missing OID 1.3.6.1.4.1.57264.1.13)`,
      `@veda-hq/niyam@0.7.1: built from commit "${TAGGED}", not ${OTHER}, the commit veda-hq/niyam's tag v0.7.1 names`,
    ]);
  });

  test("niyam 0.7.1's certificate is held to exactly main as its source ref, not only by the SAN pattern", () => {
    const policy = signingPolicy('0.7.1', NIYAM_REPOSITORY, TAGGED);
    assert.doesNotThrow(() => verifyBundle(NIYAM_071.attestations.find(a => a.predicateType === SLSA).bundle, policy));
    const otherRef = { ...policy, oids: [policy.oids[0], { ...policy.oids[1], value: Buffer.from('\x0c\x10refs/heads/main2', 'latin1') }] };
    assert.throws(() => verifyBundle(NIYAM_071.attestations.find(a => a.predicateType === SLSA).bundle, otherRef), /missing OID 1\.3\.6\.1\.4\.1\.57264\.1\.14/);
  });

  test("niyam's signed release from main offered as a veda package fails on the certificate, the repository and the ref", () => {
    const asVeda = { ...niyam071, name: '@veda-hq/sarathi' };
    assert.deepEqual(provenanceFailures(asVeda, NIYAM_071, verifyBundle, TAGGED), [
      `@veda-hq/sarathi@0.7.1: its provenance is not signed by veda-hq/veda's release of v0.7.1 (certificate identity error - expected ${REPOSITORY}/${WORKFLOW}@refs/tags/v0.7.1, got ${NIYAM_REPOSITORY}/${WORKFLOW}@refs/heads/main)`,
      `@veda-hq/sarathi@0.7.1: built with workflow repository "${NIYAM_REPOSITORY}", not "${REPOSITORY}"`,
      '@veda-hq/sarathi@0.7.1: built with workflow ref "refs/heads/main", not "refs/tags/v0.7.1"',
    ]);
  });

  test('niyam 0.6.16, built from its tag before niyam released from main, now fails on the certificate and the ref', () => {
    assert.deepEqual(provenanceFailures(niyam, NIYAM, verifyBundle, OTHER), [
      `@veda-hq/niyam@0.6.16: its provenance is not signed by veda-hq/niyam's release of ${OTHER}, the commit its tag v0.6.16 names (certificate identity error - expected ${NIYAM_REPOSITORY}/${WORKFLOW}@refs/heads/main, got ${NIYAM_REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.16)`,
      '@veda-hq/niyam@0.6.16: built with workflow ref "refs/tags/v0.6.16", not "refs/heads/main"',
      `@veda-hq/niyam@0.6.16: built from commit null, not ${OTHER}, the commit veda-hq/niyam's tag v0.6.16 names`,
    ]);
  });

  test("niyam's signed release offered as a veda package fails on the certificate and the repository", () => {
    const asVeda = { ...niyam, name: '@veda-hq/sarathi' };
    assert.deepEqual(provenanceFailures(asVeda, NIYAM, verifyBundle), [
      `@veda-hq/sarathi@0.6.16: its provenance is not signed by veda-hq/veda's release of v0.6.16 (certificate identity error - expected ${REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.16, got ${NIYAM_REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.16)`,
      `@veda-hq/sarathi@0.6.16: built with workflow repository "${NIYAM_REPOSITORY}", not "${REPOSITORY}"`,
    ]);
  });

  test("veda's signed release offered as niyam fails on the certificate, the repository, the ref and the commit", () => {
    const asNiyam = { ...kavach, name: '@veda-hq/niyam' };
    assert.deepEqual(provenanceFailures(asNiyam, KAVACH, verifyBundle, TAGGED), [
      `@veda-hq/niyam@0.6.0: its provenance is not signed by veda-hq/niyam's release of ${TAGGED}, the commit its tag v0.6.0 names (certificate identity error - expected ${NIYAM_REPOSITORY}/${WORKFLOW}@refs/heads/main, got ${REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.0)`,
      `@veda-hq/niyam@0.6.0: built with workflow repository "${REPOSITORY}", not "${NIYAM_REPOSITORY}"`,
      '@veda-hq/niyam@0.6.0: built with workflow ref "refs/tags/v0.6.0", not "refs/heads/main"',
      `@veda-hq/niyam@0.6.0: built from commit null, not ${TAGGED}, the commit veda-hq/niyam's tag v0.6.0 names`,
    ]);
  });

  test('the same bundle offered for another version fails on the certificate and on the tag', () => {
    const other = { ...kavach, version: '0.6.1' };
    assert.deepEqual(provenanceFailures(other, KAVACH, verifyBundle), [
      notSigned('0.6.1', `certificate identity error - expected ${REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.1, got ${REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.0`),
      '@veda-hq/kavach@0.6.1: built with workflow ref "refs/tags/v0.6.0", not "refs/tags/v0.6.1"',
    ]);
  });

  test("another project's validly signed provenance fails on the certificate", () => {
    const foreign = { ...kavach, version: '4.1.3', integrity: 'sha512-V2ik+fLz2YTZOV4USVnjvLJWDjmBMWi7XhFR8CNp1tj7y09OrogDxPZZdbSWXIA7IpenJTyGukIgF2CFtH/8rA==' };
    const failures = provenanceFailures(foreign, fixture('attestations-sigstore-verify-4.1.3.json'), verifyBundle);
    assert.deepEqual(failures, [
      notSigned('4.1.3', `certificate identity error - expected ${REPOSITORY}/${WORKFLOW}@refs/tags/v4.1.3, got https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main`),
      '@veda-hq/kavach@4.1.3: built with workflow repository "https://github.com/sigstore/sigstore-js", not "https://github.com/veda-hq/veda"',
      '@veda-hq/kavach@4.1.3: built with workflow ref "refs/heads/main", not "refs/tags/v4.1.3"',
    ]);
  });

  test('a statement changed after signing fails on the signature alone', () => {
    // The workflow fields and subject still name veda's release; only the signature can tell.
    const tampered = withBundle(KAVACH, bundle => {
      const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
      statement.predicate.runDetails = { builder: { id: 'https://example.com/elsewhere' } };
      bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
    });
    assert.deepEqual(provenanceFailures(kavach, tampered, verifyBundle), [notSigned('0.6.0', 'DSSE payload hash mismatch')]);
  });

  test('a bundle without its certificate fails', () => {
    const bare = withBundle(KAVACH, bundle => delete bundle.verificationMaterial.certificate);
    const failures = provenanceFailures(kavach, bare, verifyBundle);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^@veda-hq\/kavach@0\.6\.0: its provenance is not signed by veda-hq\/veda's release of v0\.6\.0 \(.+\)$/);
  });

  test('a trusted root without the signing authorities trusts nothing', () => {
    const root = JSON.parse(readFileSync(TRUSTED_ROOT, 'utf8'));
    const empty = bundleVerifier(JSON.stringify({ ...root, certificateAuthorities: [] }));
    const failures = provenanceFailures(kavach, KAVACH, empty);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^@veda-hq\/kavach@0\.6\.0: its provenance is not signed by veda-hq\/veda's release of v0\.6\.0 \(.+\)$/);
  });

  test('the verifier asks for at least one transparency log entry, certificate timestamp and timestamp', () => {
    const made = [];
    class Recording {
      /** @param {unknown} material @param {unknown} options */
      constructor(material, options) {
        made.push(options);
      }
    }
    bundleVerifier(readFileSync(TRUSTED_ROOT, 'utf8'), /** @type {any} */ (Recording));
    assert.deepEqual(made, [{ tlogThreshold: 1, ctlogThreshold: 1, timestampThreshold: 1 }]);
  });
});

describe('fetchJson', () => {
  /** A fetch that records what it is asked and answers `response`. @param {unknown[]} calls @param {object} response */
  const recording = (calls, response) => /** @type {any} */ (async (url, init) => (calls.push([url, init]), response));
  const answer = { object: { type: 'commit' } };
  const ok = { ok: true, status: 200, json: async () => answer };
  const TAG = 'https://api.github.com/repos/veda-hq/niyam/git/ref/tags/v0.7.1';
  const GITHUB = { accept: 'application/vnd.github+json' };

  test('asks GitHub with the GH_TOKEN before the GITHUB_TOKEN, and returns the JSON', async () => {
    const calls = [];
    assert.equal(await fetchJson(TAG, { get: recording(calls, ok), env: { GH_TOKEN: 'gh', GITHUB_TOKEN: 'actions' } }), answer);
    assert.deepEqual(calls, [[TAG, { headers: { ...GITHUB, authorization: 'Bearer gh' } }]]);
  });

  test('asks GitHub with the GITHUB_TOKEN alone, or with no token', async () => {
    const calls = [];
    await fetchJson(TAG, { get: recording(calls, ok), env: { GITHUB_TOKEN: 'actions' } });
    await fetchJson(TAG, { get: recording(calls, ok), env: { GH_TOKEN: '' } });
    assert.deepEqual(calls, [
      [TAG, { headers: { ...GITHUB, authorization: 'Bearer actions' } }],
      [TAG, { headers: GITHUB }],
    ]);
  });

  test('never sends the token anywhere but GitHub', async () => {
    const calls = [];
    const registry = attestationsUrl('@veda-hq/kavach', '0.6.0');
    await fetchJson(registry, { get: recording(calls, ok), env: { GH_TOKEN: 'gh' } });
    await fetchJson('https://api.github.com.example/x', { get: recording(calls, ok), env: { GH_TOKEN: 'gh' } });
    assert.deepEqual(calls, [
      [registry, { headers: {} }],
      ['https://api.github.com.example/x', { headers: {} }],
    ]);
  });

  test('an answer that is not OK is an error naming its status', async () => {
    await assert.rejects(fetchJson(TAG, { get: recording([], { ok: false, status: 404, json: async () => answer }), env: {} }), { message: 'HTTP 404' });
  });
});

test('readText reads a file as text', () => {
  assert.equal(readText(TRUSTED_ROOT), readFileSync(TRUSTED_ROOT, 'utf8'));
});

describe('main and entry', () => {
  // In a child, so the import is the module's first; the child inherits Stryker's active mutant.
  test("imported, it leaves the importer's exit code as it was", () => {
    const own = new URL('./own-provenance.mjs', import.meta.url).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `process.exitCode = 7; await import(${JSON.stringify(own)});`], { encoding: 'utf8' });
    assert.equal(r.status, 7, r.stderr);
  });

  /** @param {string} name */
  const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
  const KAVACH_INTEGRITY = 'sha512-Oc8MEAjnvKsmIYahAQ561gv4jTvktVLeMBo8otnDwqF0ywsK63H6cpVdkfrBGROqeuKO7v0slO5bl6tcWAFMdQ==';
  const NIYAM_INTEGRITY = 'sha512-99aRxQsWROgoTMsGr57fLk+HYDFuKyVcA181W/oFB0itm1PCMCqFl4l03uSOedsUBJBgK7cRHEWZQ/ONbuQZiA==';
  const lock = [
    'packages:',
    '',
    "  '@veda-hq/kavach@0.6.0':",
    `    resolution: {integrity: ${KAVACH_INTEGRITY}}`,
    '',
    "  '@veda-hq/niyam@0.7.1':",
    `    resolution: {integrity: ${NIYAM_INTEGRITY}}`,
    '',
  ].join('\n');
  const TAG = 'https://api.github.com/repos/veda-hq/niyam/git/ref/tags/v0.7.1';
  const KAVACH_URL = 'https://registry.npmjs.org/-/npm/v1/attestations/@veda-hq%2fkavach@0.6.0';
  const NIYAM_URL = 'https://registry.npmjs.org/-/npm/v1/attestations/@veda-hq%2fniyam@0.7.1';
  const registry = {
    [TAG]: { object: { type: 'commit', sha: TAGGED } },
    [KAVACH_URL]: fixture('attestations-kavach-0.6.0.json'),
    [NIYAM_URL]: fixture('attestations-niyam-0.7.1.json'),
  };
  const root = readFileSync(TRUSTED_ROOT, 'utf8');

  /** Only the lockfile and the trusted root are read. @param {string} lockText */
  const files = lockText => path => {
    if (path === 'pnpm-lock.yaml') return lockText;
    if (path === TRUSTED_ROOT) return root;
    return assert.fail(`unexpected read of ${path}`);
  };
  /** A fetch that answers from `answers`, 404s the rest, and records each call. @param {Record<string, unknown>} answers @param {unknown[]} calls */
  const network = (answers, calls) =>
    /** @type {any} */ (
      async (url, init) => {
        calls.push([url, init]);
        return Object.hasOwn(answers, url) ? { ok: true, status: 200, json: async () => answers[url] } : { ok: false, status: 404 };
      }
    );
  const sink = () => {
    const sink = { text: '', write: text => void (sink.text += text) };
    return sink;
  };

  test('every own package built and signed by its release: 0, and what was checked on stdout', async () => {
    const calls = [];
    const stdout = sink();
    const stderr = sink();
    assert.equal(await main({ readText: files(lock), get: network(registry, calls), env: { GH_TOKEN: 'gh' }, stdout, stderr }), 0);
    assert.equal(
      stdout.text,
      'own-provenance: @veda-hq/kavach@0.6.0 (https://github.com/veda-hq/veda), @veda-hq/niyam@0.7.1 (https://github.com/veda-hq/niyam) built and signed by .github/workflows/release.yml\n',
    );
    assert.equal(stderr.text, '');
    assert.deepEqual(calls, [
      [KAVACH_URL, { headers: {} }],
      [TAG, { headers: { accept: 'application/vnd.github+json', authorization: 'Bearer gh' } }],
      [NIYAM_URL, { headers: {} }],
    ]);
  });

  test('a failure: 1, with each failure and why on stderr', async () => {
    const stdout = sink();
    const stderr = sink();
    const answers = { [KAVACH_URL]: registry[KAVACH_URL] };
    assert.equal(await main({ readText: files(lock), get: network(answers, []), env: {}, stdout, stderr }), 1);
    assert.equal(stdout.text, '');
    assert.equal(
      stderr.text,
      [
        "own-provenance: @veda-hq/niyam@0.7.1: veda-hq/niyam's tag v0.7.1 could not be read from GitHub (HTTP 404), so nothing binds its build from main to v0.7.1",
        "own-provenance: @veda-hq/* skips the release age only when its own repository's release built it.",
        '',
      ].join('\n'),
    );
  });

  test('every failure is printed', async () => {
    const stderr = sink();
    assert.equal(await main({ readText: files('packages:\n'), get: network({}, []), env: {}, stdout: sink(), stderr }), 1);
    assert.equal(
      stderr.text,
      [
        'own-provenance: the lockfile resolves no @veda-hq/ package, so nothing was checked',
        "own-provenance: @veda-hq/* skips the release age only when its own repository's release built it.",
        '',
      ].join('\n'),
    );
  });

  const script = '/repo/scripts/own-provenance.mjs';
  const url = pathToFileURL(script).href;

  test('run as the script, it returns main’s exit code', async () => {
    const stdout = sink();
    assert.equal(await entry(['node', script], url, { readText: files(lock), get: network(registry, []), env: {}, stdout, stderr: sink() }), 0);
    assert.match(stdout.text, /^own-provenance: @veda-hq\/kavach@0\.6\.0 /);
  });

  test('imported, it reads, asks and prints nothing', () => {
    const never = () => assert.fail('nothing runs on import');
    const io = { readText: never, get: /** @type {any} */ (never), env: {}, stdout: { write: never }, stderr: { write: never } };
    assert.equal(entry(['node', '/repo/scripts/other.mjs'], url, io), undefined);
    assert.equal(entry(['node'], url, io), undefined);
  });
});
