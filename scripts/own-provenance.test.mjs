// scripts/own-provenance.mjs, offline: the registry's answers are built here,
// or are real ones saved under fixtures/.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  attestationsUrl,
  bundleVerifier,
  check,
  ISSUER,
  OTHER_REPOSITORIES,
  ownPackages,
  provenanceFailures,
  REPOSITORY,
  repositoryOf,
  signingPolicy,
  SLSA,
  TRUSTED_ROOT,
  WORKFLOW,
} from './own-provenance.mjs';

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
  assert.deepEqual(provenanceFailures(niyam, release('0.6.0'), accept), [
    '@veda-hq/niyam@0.6.0: built with workflow repository "https://github.com/veda-hq/veda", not "https://github.com/veda-hq/niyam"',
  ]);
  assert.deepEqual(provenanceFailures(niyam, release('0.6.0', { repository: 'https://github.com/veda-hq/niyam' }), accept), []);
  assert.deepEqual(provenanceFailures(pkg, release('0.6.0', { repository: 'https://github.com/veda-hq/niyam' }), accept), [
    '@veda-hq/sarathi@0.6.0: built with workflow repository "https://github.com/veda-hq/niyam", not "https://github.com/veda-hq/veda"',
  ]);
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

  test("niyam 0.6.16, as niyam's release published it, passes", () => {
    assert.deepEqual(provenanceFailures(niyam, NIYAM, verifyBundle), []);
  });

  test("niyam's signed release offered as a veda package fails on the certificate and the repository", () => {
    const asVeda = { ...niyam, name: '@veda-hq/sarathi' };
    assert.deepEqual(provenanceFailures(asVeda, NIYAM, verifyBundle), [
      `@veda-hq/sarathi@0.6.16: its provenance is not signed by veda-hq/veda's release of v0.6.16 (certificate identity error - expected ${REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.16, got ${NIYAM_REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.16)`,
      `@veda-hq/sarathi@0.6.16: built with workflow repository "${NIYAM_REPOSITORY}", not "${REPOSITORY}"`,
    ]);
  });

  test("veda's signed release offered as niyam fails on the certificate and the repository", () => {
    const asNiyam = { ...kavach, name: '@veda-hq/niyam' };
    assert.deepEqual(provenanceFailures(asNiyam, KAVACH, verifyBundle), [
      `@veda-hq/niyam@0.6.0: its provenance is not signed by veda-hq/niyam's release of v0.6.0 (certificate identity error - expected ${NIYAM_REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.0, got ${REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.0)`,
      `@veda-hq/niyam@0.6.0: built with workflow repository "${REPOSITORY}", not "${NIYAM_REPOSITORY}"`,
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
});
