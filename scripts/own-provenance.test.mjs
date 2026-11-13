// scripts/own-provenance.mjs, offline: the registry's answers are built here.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { attestationsUrl, check, ownPackages, provenanceFailures, REPOSITORY, SLSA, WORKFLOW } from './own-provenance.mjs';

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
  test("veda's release of the version passes", () => assert.deepEqual(provenanceFailures(pkg, release('0.6.0')), []));

  test('another repository, workflow or tag fails', () => {
    const cases = [
      [{ repository: 'https://github.com/someone/veda' }, /workflow repository "https:\/\/github.com\/someone\/veda"/],
      [{ path: '.github/workflows/other.yml' }, /workflow path/],
      [{ ref: 'refs/heads/main' }, /workflow ref "refs\/heads\/main", not "refs\/tags\/v0.6.0"/],
    ];
    for (const [workflow, reason] of cases) {
      const failures = provenanceFailures(pkg, release('0.6.0', workflow));
      assert.equal(failures.length, 1);
      assert.match(failures[0], reason);
    }
  });

  test('a release of another version fails on the tag', () => {
    assert.match(provenanceFailures(pkg, release('0.5.15')).join('\n'), /refs\/tags\/v0.5.15/);
  });

  test('another tarball fails', () => {
    assert.deepEqual(provenanceFailures(pkg, release('0.6.0', {}, 'beef')), ['@veda-hq/sarathi@0.6.0: the attested tarball is not the one the lockfile installs']);
  });

  test('missing provenance fails, whatever shape the answer has', () => {
    for (const [document, reason] of [
      [null, 'the registry served no attestations'],
      [{}, 'the registry served no attestations'],
      [{ attestations: [{ predicateType: 'other' }] }, 'it has no SLSA provenance'],
      [{ attestations: [{ predicateType: SLSA, bundle: { dsseEnvelope: { payload: Buffer.from('{').toString('base64') } } }] }, 'its SLSA provenance is not JSON'],
    ]) {
      assert.deepEqual(provenanceFailures(pkg, document), [`@veda-hq/sarathi@0.6.0: ${reason}`]);
    }
  });

  test('a statement with no workflow or subjects fails on each', () => {
    const failures = provenanceFailures(pkg, served({}));
    assert.equal(failures.length, 4);
    assert.match(failures[0], /repository null/);
  });
});

describe('check', () => {
  test('asks the registry for each own package, and gathers the failures', async () => {
    const asked = [];
    const { packages, failures } = await check(LOCK, async url => {
      asked.push(url);
      if (url.includes('kavach')) throw new Error('HTTP 404');
      return release('0.6.0');
    });
    assert.equal(packages.length, 2);
    assert.deepEqual(asked, [attestationsUrl('@veda-hq/kavach', '0.6.0'), attestationsUrl('@veda-hq/sarathi', '0.6.0')]);
    assert.deepEqual(failures, ['@veda-hq/kavach@0.6.0: its attestations could not be read (HTTP 404)']);
  });

  test('fails on what it cannot read, and on a lockfile with no own package', async () => {
    const never = async () => assert.fail('nothing to fetch');
    const unread = await check("packages:\n  '@veda-hq/dvara@1.0.0-rc.1':\n    resolution: {tarball: x}\n", never);
    assert.deepEqual(unread.failures, [
      '@veda-hq/dvara@1.0.0-rc.1: the lockfile names it in a shape this check does not read, so it is not checked',
      'the lockfile resolves no @veda-hq/ package, so nothing was checked',
    ]);
    assert.deepEqual((await check('packages:\n', never)).failures, ['the lockfile resolves no @veda-hq/ package, so nothing was checked']);
  });
});
