// own-provenance, offline, ported case for case from athya_mono's
// own-provenance.test.ts: the registry's answers are built here, or are real
// ones saved under fixtures/own-provenance/. The settings are veda's, so the
// real kavach 0.6.0 attestation verifies end to end against the shipped
// trusted root. The case that read athya's own lockfile stays there.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  attestationsUrl,
  bundleVerifier,
  check,
  defaultDeps,
  errorDetail,
  fetchRegistryJson,
  loadSigstore,
  type OwnProvenanceConfig,
  type OwnProvenanceDeps,
  ownPackages,
  ownProvenance,
  parseOwnProvenanceConfig,
  provenanceFailures,
  safeLog,
  SHIPPED_TRUSTED_ROOT,
  type Sigstore,
  type SigstoreModules,
  type SigningPolicy,
  signingPolicy,
  type VerifyBundle,
} from './own-provenance.ts';

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pariksha-own-provenance-'));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// Written out, not imported: a test built from the module's own constants
// would pass whatever the module expected.
const REPOSITORY = 'https://github.com/veda-hq/veda';
const WORKFLOW = '.github/workflows/release.yml';
const SLSA = 'https://slsa.dev/provenance/v1';
const SETTINGS = JSON.stringify({ scope: '@veda-hq/', repository: REPOSITORY, workflow: WORKFLOW });
const CONFIG: OwnProvenanceConfig = parseOwnProvenanceConfig(SETTINGS);

/** Signatures are tested on real bundles below; the statement tests accept any. */
const accept = (): void => undefined;

const rootText = (): string => readFileSync(SHIPPED_TRUSTED_ROOT, 'utf8');

type Bundle = Record<string, unknown>;
interface Answer {
  attestations: { predicateType: string; bundle: Bundle }[];
}

const fixture = (name: string): Answer => JSON.parse(readFileSync(new URL(`fixtures/own-provenance/${name}`, import.meta.url), 'utf8')) as Answer;

/** The SLSA bundle of an answer. */
const slsaBundle = (answer: Answer): Bundle => {
  const found = answer.attestations.find((a) => a.predicateType === SLSA);
  if (found === undefined) throw new Error('the fixture has no SLSA bundle');
  return found.bundle;
};

/** `answer` with its SLSA bundle changed by `edit`. */
const withBundle = (answer: Answer, edit: (bundle: Bundle) => void): Answer => {
  const copy = structuredClone(answer);
  edit(slsaBundle(copy));
  return copy;
};

/** kavach 0.6.0 as veda's release published it, and its lockfile entry. */
const kavachBundle = (): Bundle => slsaBundle(fixture('attestations-kavach-0.6.0.json'));
const KAVACH_PKG = {
  name: '@veda-hq/kavach',
  version: '0.6.0',
  integrity: 'sha512-Oc8MEAjnvKsmIYahAQ561gv4jTvktVLeMBo8otnDwqF0ywsK63H6cpVdkfrBGROqeuKO7v0slO5bl6tcWAFMdQ==',
};

const SHA512 = createHash('sha512').update('tarball').digest();
const INTEGRITY = `sha512-${SHA512.toString('base64')}`;
const DIGEST = SHA512.toString('hex');
const pkg = { name: '@veda-hq/sarathi', version: '0.6.0', integrity: INTEGRITY };

/** A registry attestations response whose SLSA statement is `statement`. */
const served = (statement: unknown): unknown => ({
  attestations: [
    { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: {} },
    { predicateType: SLSA, bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } },
  ],
});

/** veda's release of `version`, with workflow fields overridden. */
const release = (version: string, workflow: Record<string, string> = {}, digest = DIGEST): unknown =>
  served({
    subject: [{ name: `pkg:npm/%40veda-hq/sarathi@${version}`, digest: { sha512: digest } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { repository: REPOSITORY, path: WORKFLOW, ref: `refs/tags/v${version}`, ...workflow } } } },
  });

const LOCK = [
  'importers:',
  '',
  '  .:',
  '    devDependencies:',
  "      '@veda-hq/kavach':",
  '        specifier: 0.6.0',
  '        version: 0.6.0',
  "      '@veda-hq/local':",
  '        specifier: link:../local',
  '        version: link:../local',
  '',
  'packages:',
  '',
  "  '@athya-hq/rules@https://npm.pkg.github.com/download/@athya-hq/rules/0.4.1/bfd5(@veda-hq/eslint-plugin-shuddhi@0.2.0(typescript@5.9.3))':",
  '    resolution: {tarball: https://npm.pkg.github.com/download/@athya-hq/rules/0.4.1/bfd5}',
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
  "  '@veda-hq/sarathi@0.6.0(supports-color@8.1.1)':",
  '    dependencies:',
  "      '@veda-hq/kavach': 0.6.0",
  '',
].join('\n');

/** The real @sigstore modules, loaded once. */
const sigstore = async (): Promise<Sigstore> => {
  const loaded = await loadSigstore();
  if (typeof loaded === 'string') throw new Error(loaded);
  return loaded;
};

describe('parseOwnProvenanceConfig', () => {
  it('reads the scope, repository and workflow, defaulting the lockfile and the trusted root', () => {
    assert.deepEqual(CONFIG, { scope: '@veda-hq/', repository: REPOSITORY, workflow: WORKFLOW, lockfile: 'pnpm-lock.yaml', trustedRoot: undefined });
  });

  it('reads a lockfile and a trusted root when given', () => {
    const config = parseOwnProvenanceConfig(JSON.stringify({ scope: '@acme/', repository: 'https://github.com/acme/tools', workflow: '.github/workflows/publish.yml', lockfile: 'sub/pnpm-lock.yaml', trustedRoot: 'trust/root.json' }));
    assert.deepEqual(config, { scope: '@acme/', repository: 'https://github.com/acme/tools', workflow: '.github/workflows/publish.yml', lockfile: 'sub/pnpm-lock.yaml', trustedRoot: 'trust/root.json' });
  });

  const base = { scope: '@veda-hq/', repository: REPOSITORY, workflow: WORKFLOW };
  const refused: [string, unknown, RegExp][] = [
    ['text that is not JSON', '{', /^not JSON: /],
    ['a list', [], /^the config must be a JSON object$/],
    ['null', null, /^the config must be a JSON object$/],
    ['an unknown key', { ...base, scopes: '@veda-hq/' }, /^unknown key "scopes"; own-provenance reads scope, repository, workflow, lockfile, trustedRoot$/],
    ['no scope', { repository: REPOSITORY, workflow: WORKFLOW }, /^"scope" must be/],
    ['a scope with no @', { ...base, scope: 'veda-hq/' }, /^"scope" must be/],
    ['a scope with no trailing /', { ...base, scope: '@veda-hq' }, /^"scope" must be/],
    ['a scope of @/ alone', { ...base, scope: '@/' }, /^"scope" must be/],
    ['a scope that is not a string', { ...base, scope: 7 }, /^"scope" must be/],
    ['no repository', { scope: '@veda-hq/', workflow: WORKFLOW }, /^"repository" must be .* https:\/\/github\.com\/$/],
    ['a repository off GitHub', { ...base, repository: 'https://gitlab.com/veda-hq/veda' }, /^"repository" must be/],
    ['a repository of github.com alone', { ...base, repository: 'https://github.com/' }, /^"repository" must be/],
    ['no workflow', { scope: '@veda-hq/', repository: REPOSITORY }, /^"workflow" must be/],
    ['a blank workflow', { ...base, workflow: ' ' }, /^"workflow" must be/],
    ['a blank lockfile', { ...base, lockfile: '' }, /^"lockfile" must be a path relative to the root$/],
    ['a trusted root that is not a string', { ...base, trustedRoot: null }, /^"trustedRoot" must be a path relative to the root$/],
  ];
  for (const [what, value, reason] of refused) {
    it(`refuses ${what}`, () => {
      assert.throws(() => parseOwnProvenanceConfig(typeof value === 'string' ? value : JSON.stringify(value)), { message: reason });
    });
  }
});

describe('ownPackages', () => {
  it('reads each @veda-hq package once, from the packages section, past importers, a link: and an @athya-hq key that names one', () => {
    assert.deepEqual(ownPackages(LOCK, CONFIG), {
      packages: [
        { name: '@veda-hq/kavach', version: '0.6.0', integrity: INTEGRITY },
        { name: '@veda-hq/sarathi', version: '0.6.0', integrity: INTEGRITY },
      ],
      unread: [],
    });
  });

  it('reads an unquoted key and a multi-digit version', () => {
    const lock = `packages:\n  @veda-hq/dvara@0.5.16:\n    resolution: {integrity: ${INTEGRITY}}\n`;
    assert.deepEqual(ownPackages(lock, CONFIG), { packages: [{ name: '@veda-hq/dvara', version: '0.5.16', integrity: INTEGRITY }], unread: [] });
  });

  it('reads a double-quoted key, and names one whose quotes do not match', () => {
    const lock = ['packages:', '  "@veda-hq/kavach@0.6.0":', `    resolution: {integrity: ${INTEGRITY}}`, '  "@veda-hq/sarathi@0.6.1\':', `    resolution: {integrity: ${INTEGRITY}}`, ''].join('\n');
    assert.deepEqual(ownPackages(lock, CONFIG), { packages: [{ name: '@veda-hq/kavach', version: '0.6.0', integrity: INTEGRITY }], unread: ['@veda-hq/sarathi@0.6.1'] });
  });

  it('a lockfile with none has none', () => {
    assert.deepEqual(ownPackages('packages:\n', CONFIG), { packages: [], unread: [] });
  });

  it('names an own key in a shape it does not read, never skipping it', () => {
    const lock = [
      'packages:',
      "  '@veda-hq/dvara@0.7.0-rc.1':",
      `    resolution: {integrity: ${INTEGRITY}}`,
      '  @veda-hq/niyam@0.6.14:',
      '    resolution: {tarball: https://github.com/veda-hq/niyam/releases/download/v0.6.14/niyam.tgz}',
      "  '@veda-hq/niyam@https://github.com/veda-hq/niyam/releases/download/v0.6.14/niyam.tgz':",
      '    resolution: {tarball: https://github.com/veda-hq/niyam/releases/download/v0.6.14/niyam.tgz}',
      "  '@veda-hq/pariksha@0.5.20':",
      `    resolution: {integrity: ${INTEGRITY}, tarball: x}`,
      'snapshots:',
      "  '@veda-hq/pariksha@0.5.20(typescript@5.9.3)': {}",
      '',
    ].join('\n');
    assert.deepEqual(ownPackages(lock, CONFIG), {
      packages: [],
      unread: ['@veda-hq/dvara@0.7.0-rc.1', '@veda-hq/niyam@0.6.14', '@veda-hq/niyam@https://github.com/veda-hq/niyam/releases/download/v0.6.14/niyam.tgz', '@veda-hq/pariksha@0.5.20'],
    });
  });

  it('reads the scope the settings name, and only it', () => {
    const lock = ['packages:', "  '@acme/tool@1.2.3':", `    resolution: {integrity: ${INTEGRITY}}`, "  '@acme/odd@1.2.3-rc.1':", `    resolution: {integrity: ${INTEGRITY}}`, "  '@veda-hq/kavach@0.6.0':", `    resolution: {integrity: ${INTEGRITY}}`, ''].join('\n');
    assert.deepEqual(ownPackages(lock, { ...CONFIG, scope: '@acme/' }), { packages: [{ name: '@acme/tool', version: '1.2.3', integrity: INTEGRITY }], unread: ['@acme/odd@1.2.3-rc.1'] });
  });

  it('reads a scope holding regular-expression characters as text', () => {
    const lock = ['packages:', "  '@a.b/tool@1.2.3':", `    resolution: {integrity: ${INTEGRITY}}`, "  '@axb/tool@1.2.3':", `    resolution: {integrity: ${INTEGRITY}}`, ''].join('\n');
    assert.deepEqual(ownPackages(lock, { ...CONFIG, scope: '@a.b/' }), { packages: [{ name: '@a.b/tool', version: '1.2.3', integrity: INTEGRITY }], unread: [] });
  });
});

it('attestationsUrl escapes the scope', () => {
  assert.equal(attestationsUrl('@veda-hq/sarathi', '0.6.0'), 'https://registry.npmjs.org/-/npm/v1/attestations/@veda-hq%2fsarathi@0.6.0');
});

describe('provenanceFailures', () => {
  it("passes veda's release of the version", () => {
    assert.deepEqual(provenanceFailures(pkg, release('0.6.0'), accept, CONFIG), []);
  });

  const others: [Record<string, string>, RegExp][] = [
    [{ repository: 'https://github.com/someone/veda' }, /workflow repository "https:\/\/github.com\/someone\/veda"/],
    [{ path: '.github/workflows/other.yml' }, /workflow path/],
    [{ ref: 'refs/heads/main' }, /workflow ref "refs\/heads\/main", not "refs\/tags\/v0.6.0"/],
  ];
  for (const [workflow, reason] of others) {
    it(`fails another repository, workflow or tag (${JSON.stringify(workflow)})`, () => {
      const failures = provenanceFailures(pkg, release('0.6.0', workflow), accept, CONFIG);
      assert.equal(failures.length, 1);
      assert.match(failures[0] as string, reason);
    });
  }

  it('fails a release of another version on the tag', () => {
    assert.match(provenanceFailures(pkg, release('0.5.15'), accept, CONFIG).join('\n'), /refs\/tags\/v0.5.15/);
  });

  it('fails another tarball', () => {
    assert.deepEqual(provenanceFailures(pkg, release('0.6.0', {}, 'beef'), accept, CONFIG), ['@veda-hq/sarathi@0.6.0: the attested tarball is not the one the lockfile installs']);
  });

  const shortIntegrities: [string, string][] = [
    ['empty', 'sha512-'],
    ['cut short', `sha512-${SHA512.subarray(0, 32).toString('base64')}`],
  ];
  for (const [shape, integrity] of shortIntegrities) {
    it(`fails a lockfile integrity that is not a SHA-512 digest (${shape}), even when the attestation matches it`, () => {
      const short = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
      assert.deepEqual(provenanceFailures({ ...pkg, integrity }, release('0.6.0', {}, short), accept, CONFIG), ["@veda-hq/sarathi@0.6.0: the lockfile's integrity is not a SHA-512 digest"]);
    });
  }

  const missing: [unknown, string][] = [
    [null, 'the registry served no attestations'],
    [{}, 'the registry served no attestations'],
    [[], 'the registry served no attestations'],
    [{ attestations: {} }, 'the registry served no attestations'],
    [{ attestations: [{ predicateType: 'other' }] }, 'it has no SLSA provenance'],
    [{ attestations: [null, { predicateType: SLSA, bundle: {} }] }, 'it has no SLSA provenance'],
    [{ attestations: [{ predicateType: SLSA, bundle: [] }] }, 'it has no SLSA provenance'],
    [{ attestations: [{ predicateType: SLSA, bundle: { dsseEnvelope: { payload: 7 } } }] }, 'it has no SLSA provenance'],
    [{ attestations: [{ predicateType: SLSA, bundle: { dsseEnvelope: { payload: Buffer.from('{').toString('base64') } } }] }, 'its SLSA provenance is not JSON'],
  ];
  for (const [document, reason] of missing) {
    it(`fails missing provenance, whatever shape the answer has (${JSON.stringify(document)})`, () => {
      assert.deepEqual(provenanceFailures(pkg, document, accept, CONFIG), [`@veda-hq/sarathi@0.6.0: ${reason}`]);
    });
  }

  it('reads the first SLSA attestation it can read, past a malformed one', () => {
    const good = release('0.6.0') as { attestations: unknown[] };
    const document = { attestations: [{ predicateType: SLSA, bundle: { dsseEnvelope: {} } }, ...good.attestations] };
    assert.deepEqual(provenanceFailures(pkg, document, accept, CONFIG), []);
  });

  it("reads only the SLSA attestation, even when another one names veda's release", () => {
    const veda = release('0.6.0') as { attestations: { bundle: unknown }[] };
    const payload = veda.attestations[1]?.bundle;
    const other = { attestations: [{ predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: payload }] };
    assert.deepEqual(provenanceFailures(pkg, other, accept, CONFIG), ['@veda-hq/sarathi@0.6.0: it has no SLSA provenance']);
  });

  it('fails a statement with no workflow or subjects on each', () => {
    const failures = provenanceFailures(pkg, served({}), accept, CONFIG);
    assert.equal(failures.length, 4);
    assert.match(failures[0] as string, /repository null/);
  });

  it('fails a statement whose workflow stops at any level on each field', () => {
    for (const predicate of [{}, { buildDefinition: {} }, { buildDefinition: { externalParameters: {} } }]) {
      const failures = provenanceFailures(pkg, served({ subject: [{ digest: { sha512: DIGEST } }], predicate }), accept, CONFIG);
      assert.deepEqual(failures, [
        '@veda-hq/sarathi@0.6.0: built with workflow repository null, not "https://github.com/veda-hq/veda"',
        '@veda-hq/sarathi@0.6.0: built with workflow path null, not ".github/workflows/release.yml"',
        '@veda-hq/sarathi@0.6.0: built with workflow ref null, not "refs/tags/v0.6.0"',
      ]);
    }
  });

  const unreadable: unknown[] = [
    'a string',
    7,
    { subject: [null] },
    { predicate: 'x' },
    [],
    { subject: null },
    { subject: {} },
    { subject: [{ digest: null }] },
    { predicate: null },
    { predicate: { buildDefinition: null } },
    { predicate: { buildDefinition: { externalParameters: [] } } },
    { predicate: { buildDefinition: { externalParameters: { workflow: [] } } } },
  ];
  for (const statement of unreadable) {
    it(`fails a statement in a shape it does not read (${JSON.stringify(statement)})`, () => {
      assert.deepEqual(provenanceFailures(pkg, served(statement), accept, CONFIG), ['@veda-hq/sarathi@0.6.0: its SLSA provenance is not a statement this reads']);
    });
  }

  it('fails subjects with no digest on the tarball alone', () => {
    const statement = { subject: [{}, { digest: {} }], predicate: { buildDefinition: { externalParameters: { workflow: { repository: REPOSITORY, path: WORKFLOW, ref: 'refs/tags/v0.6.0' } } } } };
    assert.deepEqual(provenanceFailures(pkg, served(statement), accept, CONFIG), ['@veda-hq/sarathi@0.6.0: the attested tarball is not the one the lockfile installs']);
  });

  it('judges the workflow against the repository and workflow the settings name', () => {
    const acme = { ...CONFIG, scope: '@acme/', repository: 'https://github.com/acme/tools', workflow: '.github/workflows/publish.yml' };
    const failures = provenanceFailures({ ...pkg, name: '@acme/tool' }, release('0.6.0'), () => {
      throw new Error('no signature');
    }, acme);
    assert.deepEqual(failures, [
      "@acme/tool@0.6.0: its provenance is not signed by acme/tools's release of v0.6.0 (no signature)",
      '@acme/tool@0.6.0: built with workflow repository "https://github.com/veda-hq/veda", not "https://github.com/acme/tools"',
      '@acme/tool@0.6.0: built with workflow path ".github/workflows/release.yml", not ".github/workflows/publish.yml"',
    ]);
  });
});

describe('check', () => {
  it('asks the registry for each own package, and gathers the failures', async () => {
    const asked: string[] = [];
    const policies: SigningPolicy[] = [];
    const kavach = attestationsUrl('@veda-hq/kavach', '0.6.0');
    const { packages, failures } = await check(
      LOCK,
      (url) => {
        asked.push(url);
        if (url === kavach) return Promise.reject(new Error('HTTP 404'));
        return Promise.resolve(release('0.6.0'));
      },
      (_bundle, policy) => {
        policies.push(policy);
        throw new Error('no signature');
      },
      CONFIG,
    );
    assert.equal(packages.length, 2);
    assert.deepEqual(asked, [attestationsUrl('@veda-hq/kavach', '0.6.0'), attestationsUrl('@veda-hq/sarathi', '0.6.0')]);
    assert.deepEqual(policies, [signingPolicy('0.6.0', CONFIG)]);
    assert.deepEqual(failures, ['@veda-hq/kavach@0.6.0: its attestations could not be read (HTTP 404)', "@veda-hq/sarathi@0.6.0: its provenance is not signed by veda-hq/veda's release of v0.6.0 (no signature)"]);
  });

  it('fails every package when the registry cannot be reached', async () => {
    const { failures } = await check(LOCK, () => Promise.reject(new Error('offline')), accept, CONFIG);
    assert.deepEqual(failures, ['@veda-hq/kavach@0.6.0: its attestations could not be read (offline)', '@veda-hq/sarathi@0.6.0: its attestations could not be read (offline)']);
  });

  it('fails on what it cannot read, and on a lockfile with no own package', async () => {
    const never = (): Promise<unknown> => Promise.reject(new Error('nothing to fetch'));
    const unread = await check("packages:\n  '@veda-hq/dvara@1.0.0-rc.1':\n    resolution: {tarball: x}\n", never, accept, CONFIG);
    assert.deepEqual(unread.failures, ['@veda-hq/dvara@1.0.0-rc.1: the lockfile names it in a shape this check does not read, so it is not checked', 'the lockfile resolves no @veda-hq/ package, so nothing was checked']);
    assert.deepEqual((await check('packages:\n', never, accept, CONFIG)).failures, ['the lockfile resolves no @veda-hq/ package, so nothing was checked']);
  });

  it('names the scope the settings give when the lockfile resolves none of it', async () => {
    const { failures } = await check(LOCK, () => Promise.reject(new Error('nothing to fetch')), accept, { ...CONFIG, scope: '@acme/' });
    assert.deepEqual(failures, ['the lockfile resolves no @acme/ package, so nothing was checked']);
  });
});

describe('fetchRegistryJson', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns an attestations answer, null for any other JSON, and throws the status of a bad response', async () => {
    const answers = new Map([
      ['https://registry.example/ok', () => new Response('{"attestations":[]}', { status: 200 })],
      ['https://registry.example/extra', () => new Response('{"attestations":[1],"other":"x"}', { status: 200 })],
      ['https://registry.example/odd', () => new Response('{"error":"x"}', { status: 200 })],
      ['https://registry.example/missing', () => new Response('gone', { status: 404 })],
    ]);
    globalThis.fetch = ((url: string) => {
      const answer = answers.get(url);
      return answer === undefined ? Promise.reject(new Error(`unexpected request ${url}`)) : Promise.resolve(answer());
    }) as typeof fetch;
    assert.deepEqual(await fetchRegistryJson('https://registry.example/ok'), { attestations: [] });
    assert.deepEqual(await fetchRegistryJson('https://registry.example/extra'), { attestations: [1] });
    assert.equal(await fetchRegistryJson('https://registry.example/odd'), null);
    await assert.rejects(fetchRegistryJson('https://registry.example/missing'), { message: 'HTTP 404' });
  });

  it('bounds each request with a timeout, so a stalled registry fails the check', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return Promise.resolve(new Response('{"attestations":[]}', { status: 200 }));
    }) as typeof fetch;
    await fetchRegistryJson('https://registry.example/ok');
    assert.equal(seen.length, 1);
    assert.ok(seen[0] instanceof AbortSignal);
    assert.equal(seen[0].aborted, false);
  });
});

describe('defaultDeps', () => {
  it('reads a file as text and writes to the console', (t) => {
    const dir = temp();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), LOCK);
    assert.equal(defaultDeps.readFile(join(dir, 'pnpm-lock.yaml')), LOCK);
    const log = t.mock.method(console, 'log', () => undefined);
    const error = t.mock.method(console, 'error', () => undefined);
    defaultDeps.out('out');
    defaultDeps.err('err');
    assert.deepEqual(
      log.mock.calls.map((c) => c.arguments),
      [['out']],
    );
    assert.deepEqual(
      error.mock.calls.map((c) => c.arguments),
      [['err']],
    );
  });

  it('fetches from the registry', () => {
    assert.equal(defaultDeps.fetchJson, fetchRegistryJson);
  });

  it("reads the shipped trusted root as text, byte for byte Sigstore's TUF targets v14 file", () => {
    const text = defaultDeps.readFile(SHIPPED_TRUSTED_ROOT);
    assert.equal(typeof text, 'string');
    assert.equal(createHash('sha256').update(text).digest('hex'), '6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66');
  });

  it('loads a verifier from the shipped trusted root', async () => {
    const loaded = await defaultDeps.loadSigstore();
    assert.notEqual(typeof loaded, 'string');
    const verify = bundleVerifier(rootText(), loaded as Sigstore);
    assert.doesNotThrow(() => {
      verify(kavachBundle(), signingPolicy('0.6.0', CONFIG));
    });
  });
});

describe('loadSigstore', () => {
  const MISSING = 'needs @sigstore/bundle (>=5 <6), @sigstore/protobuf-specs (>=0.5 <0.6) and @sigstore/verify (>=4.1 <5) installed beside pariksha';
  const fn = (): undefined => undefined;
  class Verifier {}
  const whole: SigstoreModules = [{ bundleFromJSON: fn }, { TrustedRoot: { fromJSON: fn } }, { toSignedEntity: fn, toTrustMaterial: fn, Verifier }];

  it('loads the three peers', async () => {
    assert.deepEqual(await loadSigstore(() => Promise.resolve(whole)), { bundleFromJSON: fn, trustedRootFromJSON: fn, toTrustMaterial: fn, toSignedEntity: fn, Verifier });
  });

  it('names the peers when one is not installed', async () => {
    assert.equal(await loadSigstore(() => Promise.reject(new Error("Cannot find package '@sigstore/verify'"))), MISSING);
  });

  const partial: [string, SigstoreModules][] = [
    ['bundleFromJSON', [{}, whole[1], whole[2]]],
    ['TrustedRoot', [whole[0], {}, whole[2]]],
    ['TrustedRoot.fromJSON', [whole[0], { TrustedRoot: {} }, whole[2]]],
    ['toTrustMaterial', [whole[0], whole[1], { toSignedEntity: fn, Verifier }]],
    ['toSignedEntity', [whole[0], whole[1], { toTrustMaterial: fn, Verifier }]],
    ['Verifier', [whole[0], whole[1], { toSignedEntity: fn, toTrustMaterial: fn }]],
  ];
  for (const [what, modules] of partial) {
    it(`names the peers when one does not export ${what}`, async () => {
      assert.equal(await loadSigstore(() => Promise.resolve(modules)), MISSING);
    });
  }
});

it('signingPolicy names the release workflow at the tag, issued by GitHub Actions', () => {
  assert.deepEqual(signingPolicy('0.6.0', CONFIG), {
    subjectAlternativeName: 'https://github.com/veda-hq/veda/.github/workflows/release.yml@refs/tags/v0.6.0',
    extensions: { issuer: 'https://token.actions.githubusercontent.com' },
  });
});

describe('errorDetail', () => {
  it("names an Error's message, else its name, else Error; anything else as text", () => {
    assert.equal(errorDetail(new Error('boom')), 'boom');
    assert.equal(errorDetail(new TypeError('')), 'TypeError');
    const nameless = new Error('');
    nameless.name = '';
    assert.equal(errorDetail(nameless), 'Error');
    assert.equal(errorDetail('plain'), 'plain');
    assert.equal(errorDetail(7), '7');
  });

  it('never throws on a value that cannot be described', () => {
    const hostile = {
      toString: () => {
        throw new Error('no');
      },
    };
    assert.equal(errorDetail(hostile), '[unprintable error]');
  });
});

describe('safeLog', () => {
  it('writes the line, and absorbs a sink that throws or rejects', async () => {
    const lines: string[] = [];
    safeLog((line) => lines.push(line), 'one');
    assert.deepEqual(lines, ['one']);
    assert.doesNotThrow(() => {
      safeLog(() => {
        throw new Error('sink');
      }, 'two');
    });
    safeLog(() => Promise.reject(new Error('sink')), 'three');
    // An unabsorbed rejection would fail the run once the microtasks drain.
    await new Promise((done) => setImmediate(done));
  });
});

// Real registry answers, verified against the shipped trusted root with no network.
describe('the Sigstore bundle, on real attestations', () => {
  let modules: Sigstore;
  let verifyBundle: VerifyBundle;
  let KAVACH: Answer;
  before(async () => {
    modules = await sigstore();
    verifyBundle = bundleVerifier(rootText(), modules);
    KAVACH = fixture('attestations-kavach-0.6.0.json');
  });
  const notSigned = (version: string, reason: string): string => `@veda-hq/kavach@${version}: its provenance is not signed by veda-hq/veda's release of v${version} (${reason})`;
  const unsigned = /^@veda-hq\/kavach@0\.6\.0: its provenance is not signed by veda-hq\/veda's release of v0\.6\.0 \(.+\)$/;

  it("passes kavach 0.6.0, as veda's release published it", () => {
    assert.deepEqual(provenanceFailures(KAVACH_PKG, KAVACH, verifyBundle, CONFIG), []);
  });

  it('fails the same bundle offered for another version on the certificate and on the tag', () => {
    const other = { ...KAVACH_PKG, version: '0.6.1' };
    assert.deepEqual(provenanceFailures(other, KAVACH, verifyBundle, CONFIG), [
      notSigned('0.6.1', `certificate identity error - expected ${REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.1, got ${REPOSITORY}/${WORKFLOW}@refs/tags/v0.6.0`),
      '@veda-hq/kavach@0.6.1: built with workflow ref "refs/tags/v0.6.0", not "refs/tags/v0.6.1"',
    ]);
  });

  it("fails another project's validly signed provenance on the certificate", () => {
    const foreign = { ...KAVACH_PKG, version: '4.1.3', integrity: 'sha512-V2ik+fLz2YTZOV4USVnjvLJWDjmBMWi7XhFR8CNp1tj7y09OrogDxPZZdbSWXIA7IpenJTyGukIgF2CFtH/8rA==' };
    const document = fixture('attestations-sigstore-verify-4.1.3.json');
    assert.deepEqual(provenanceFailures(foreign, document, verifyBundle, CONFIG), [
      notSigned('4.1.3', `certificate identity error - expected ${REPOSITORY}/${WORKFLOW}@refs/tags/v4.1.3, got https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main`),
      '@veda-hq/kavach@4.1.3: built with workflow repository "https://github.com/sigstore/sigstore-js", not "https://github.com/veda-hq/veda"',
      '@veda-hq/kavach@4.1.3: built with workflow ref "refs/heads/main", not "refs/tags/v4.1.3"',
    ]);
  });

  it('fails a statement changed after signing on the signature alone', () => {
    // The workflow fields and subject still name veda's release; only the signature can tell.
    const tampered = withBundle(KAVACH, (bundle) => {
      const envelope = bundle['dsseEnvelope'] as { payload: string };
      const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString()) as { predicate: Record<string, unknown> };
      statement.predicate['runDetails'] = { builder: { id: 'https://example.com/elsewhere' } };
      bundle['dsseEnvelope'] = { ...envelope, payload: Buffer.from(JSON.stringify(statement)).toString('base64') };
    });
    assert.deepEqual(provenanceFailures(KAVACH_PKG, tampered, verifyBundle, CONFIG), [notSigned('0.6.0', 'DSSE payload hash mismatch')]);
  });

  for (const [what, field] of [
    ['its certificate', 'certificate'],
    ['its Rekor entries', 'tlogEntries'],
  ] as const) {
    it(`fails a bundle without ${what}`, () => {
      const bare = withBundle(KAVACH, (bundle) => {
        const material = bundle['verificationMaterial'] as Record<string, unknown>;
        assert.ok(field in material);
        Reflect.deleteProperty(material, field);
      });
      const failures = provenanceFailures(KAVACH_PKG, bare, verifyBundle, CONFIG);
      assert.equal(failures.length, 1);
      assert.match(failures[0] as string, unsigned);
    });
  }

  it('trusts nothing with a trusted root that lists no signing authority', () => {
    const root = JSON.parse(rootText()) as Record<string, unknown>;
    const empty = bundleVerifier(JSON.stringify({ ...root, certificateAuthorities: [] }), modules);
    const failures = provenanceFailures(KAVACH_PKG, KAVACH, empty, CONFIG);
    assert.equal(failures.length, 1);
    assert.match(failures[0] as string, unsigned);
  });

  it('refuses a trusted root that is not JSON', () => {
    assert.throws(() => bundleVerifier('{', modules), SyntaxError);
  });

  for (const text of ['[]', '"root"', 'null']) {
    it(`refuses a trusted root that is not an object (${text})`, () => {
      assert.throws(() => bundleVerifier(text, modules), { message: 'the trusted root must be a JSON object' });
    });
  }
});

describe('ownProvenance', () => {
  const ROOT = '/repo';
  const LOCK_PATH = resolve(ROOT, 'pnpm-lock.yaml');
  const run = async (overrides: Partial<OwnProvenanceDeps>, settings = SETTINGS): Promise<{ code: number; out: string[]; err: string[] }> => {
    const out: string[] = [];
    const err: string[] = [];
    const fake: Sigstore = {
      bundleFromJSON: (b) => b,
      trustedRootFromJSON: (r) => r,
      toTrustMaterial: (r) => r,
      toSignedEntity: (b) => b,
      Verifier: class {
        verify = accept;
      },
    };
    const code = await ownProvenance(settings, ROOT, {
      readFile: (path) => (path === LOCK_PATH ? LOCK : '{}'),
      loadSigstore: () => Promise.resolve(fake),
      fetchJson: () => Promise.resolve(release('0.6.0')),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      ...overrides,
    });
    return { code, out, err };
  };
  /** Reads the lockfile `lock` at the root, and every other path from disk. */
  const readingLock =
    (lock: string, read: string[] = []) =>
    (path: string): string => {
      read.push(path);
      return path === LOCK_PATH ? lock : readFileSync(path, 'utf8');
    };
  const KAVACH_LOCK = `packages:\n  '@veda-hq/kavach@0.6.0':\n    resolution: {integrity: ${KAVACH_PKG.integrity}}\n`;

  it('passes and names what it checked', async () => {
    const { code, out, err } = await run({});
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.deepEqual(out, [`✅ own-provenance: @veda-hq/kavach@0.6.0, @veda-hq/sarathi@0.6.0 built and signed by ${REPOSITORY} ${WORKFLOW}`]);
  });

  it("passes kavach's real release end to end, with the shipped trusted root", async () => {
    const read: string[] = [];
    const { code, out, err } = await run({ readFile: readingLock(KAVACH_LOCK, read), loadSigstore: defaultDeps.loadSigstore, fetchJson: () => Promise.resolve(fixture('attestations-kavach-0.6.0.json')) });
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.deepEqual(out, [`✅ own-provenance: @veda-hq/kavach@0.6.0 built and signed by ${REPOSITORY} ${WORKFLOW}`]);
    assert.deepEqual(read, [LOCK_PATH, SHIPPED_TRUSTED_ROOT]);
  });

  it('reads the lockfile and the trusted root the settings name, under the root', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'other-lock.yaml'), KAVACH_LOCK);
    copyFileSync(SHIPPED_TRUSTED_ROOT, join(dir, 'root.json'));
    const out: string[] = [];
    const err: string[] = [];
    const settings = JSON.stringify({ scope: '@veda-hq/', repository: REPOSITORY, workflow: WORKFLOW, lockfile: 'other-lock.yaml', trustedRoot: 'root.json' });
    const code = await ownProvenance(settings, dir, { ...defaultDeps, fetchJson: () => Promise.resolve(fixture('attestations-kavach-0.6.0.json')), out: (line) => out.push(line), err: (line) => err.push(line) });
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.deepEqual(out, [`✅ own-provenance: @veda-hq/kavach@0.6.0 built and signed by ${REPOSITORY} ${WORKFLOW}`]);
  });

  it('verifies against the trusted root the settings name, not the shipped one', async () => {
    const dir = temp();
    const root = JSON.parse(rootText()) as Record<string, unknown>;
    writeFileSync(join(dir, 'root.json'), JSON.stringify({ ...root, certificateAuthorities: [] }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), KAVACH_LOCK);
    const settings = JSON.stringify({ scope: '@veda-hq/', repository: REPOSITORY, workflow: WORKFLOW, trustedRoot: 'root.json' });
    const out: string[] = [];
    const err: string[] = [];
    const code = await ownProvenance(settings, dir, { ...defaultDeps, fetchJson: () => Promise.resolve(fixture('attestations-kavach-0.6.0.json')), out: (line) => out.push(line), err: (line) => err.push(line) });
    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.equal(err.length, 2);
    assert.match(err[0] as string, /^own-provenance: @veda-hq\/kavach@0\.6\.0: its provenance is not signed by veda-hq\/veda's release of v0\.6\.0 \(.+\)$/);
  });

  it('fails when the trusted root cannot be read', async () => {
    const { code, out, err } = await run({
      readFile: (path) => {
        if (path === LOCK_PATH) return LOCK;
        throw new Error('ENOENT');
      },
    });
    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.deepEqual(err, ['own-provenance: the Sigstore trusted root could not be read or loaded (ENOENT)']);
  });

  it('fails when the trusted root is read but is not one, naming why', async () => {
    const { code, err } = await run({ readFile: (path) => (path === LOCK_PATH ? LOCK : '{') });
    assert.equal(code, 1);
    assert.equal(err.length, 1);
    assert.match(err[0] as string, /^own-provenance: the Sigstore trusted root could not be read or loaded \(.*JSON.*\)$/);
  });

  it('fails with each reason, then why the scope must pass', async () => {
    const { code, out, err } = await run({ fetchJson: () => Promise.resolve(release('0.6.0', { ref: 'refs/heads/main' })) });
    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.equal(err.length, 3);
    assert.equal(err[2], "own-provenance: @veda-hq/* skips the release age only when veda-hq/veda's release built and signed it.");
  });

  it('fails when the lockfile cannot be read', async () => {
    const { code, err } = await run({
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    assert.equal(code, 1);
    assert.deepEqual(err, ['own-provenance: pnpm-lock.yaml could not be read (ENOENT)']);
  });

  it('fails, naming the peers, when @sigstore is not installed', async () => {
    const { code, out, err } = await run({ loadSigstore: () => loadSigstore(() => Promise.reject(new Error('Cannot find package'))) });
    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.deepEqual(err, ['own-provenance: needs @sigstore/bundle (>=5 <6), @sigstore/protobuf-specs (>=0.5 <0.6) and @sigstore/verify (>=4.1 <5) installed beside pariksha']);
  });

  it('exits 2 on settings it does not read, before reading anything', async () => {
    const read: string[] = [];
    const { code, out, err } = await run({ readFile: readingLock(LOCK, read) }, JSON.stringify({ scope: '@veda-hq/', repository: REPOSITORY }));
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.deepEqual(read, []);
    assert.equal(err.length, 1);
    assert.match(err[0] as string, /^own-provenance: "workflow" must be/);
  });

  it('honours the scope the settings name', async () => {
    const settings = JSON.stringify({ scope: '@acme/', repository: 'https://github.com/acme/tools', workflow: '.github/workflows/publish.yml' });
    const { code, err } = await run({}, settings);
    assert.equal(code, 1);
    assert.deepEqual(err, ['own-provenance: the lockfile resolves no @acme/ package, so nothing was checked', "own-provenance: @acme/* skips the release age only when acme/tools's release built and signed it."]);
  });

  it('still exits on its verdict when the sinks throw', async () => {
    const throwing = (): void => {
      throw new Error('closed pipe');
    };
    assert.equal((await run({ out: throwing })).code, 0);
    assert.equal((await run({ err: throwing, fetchJson: () => Promise.reject(new Error('offline')) })).code, 1);
  });
});
