// own-provenance: what stands in for pnpm's release age on the repository's
// own scope. A repository that exempts its own packages from
// minimumReleaseAge (nobody else watches those releases, so the day's wait
// buys nothing) names that scope here, and every package of it the lockfile
// resolves must carry npm provenance saying the repository's release
// workflow built it from the tag of its own version, for the very tarball the
// lockfile installs. A release published any other way (a stolen token, a
// fork, another workflow) fails here before the push or the pull request
// goes on.
//
// Ported from the product repository's own-provenance.ts (itself from veda's
// own-provenance.mjs, veda-hq/veda#60, #64) with the same pass conditions; a
// statement in a shape it does not read fails with one reason rather than one
// per field. The scope, repository, workflow and lockfile are the
// repository's settings (checks.own-provenance), never pariksha's.
//
// The statement's workflow fields are written by whoever ran npm publish, so
// they alone prove nothing. What binds them is the Sigstore bundle around the
// statement, verified here offline with @sigstore/verify:
// - the DSSE signature over the statement;
// - the signing certificate's chain to Sigstore's public-good Fulcio;
// - its signed certificate timestamp, and the Rekor entry that times it (the
//   Verifier's defaults ask one of each);
// - the certificate's identity: its SAN must name the repository's release
//   workflow at the version's tag, and its issuer must be GitHub Actions.
//
// The trust anchors are baselines/sigstore-trusted-root.json, shipped with
// pariksha (a repository may name its own with trustedRoot): Sigstore's
// public-good trusted_root.json, whose sha256 (6494e21e…0b66) matched the
// trusted_root.json entry of Sigstore's TUF targets v14
// (tuf-repo-cdn.sigstore.dev) on 2026-11-14. When Sigstore rotates a key, new
// releases fail here until the file is refreshed: take
// targets/trusted_root.json from sigstore/root-signing and check its sha256
// against the latest targets.json on the TUF CDN. A root that cannot be read
// fails the check.
//
// It fails closed. An own key it cannot read fails: a prerelease, a tarball
// or git resolution, or a shape this does not know. So do a lockfile with no
// own package, a registry it cannot reach or that stalls past 30 s, an answer
// with no provenance, and an integrity that is not a 64-byte SHA-512. Keys
// are read plain, single- or double-quoted; in lockfile v9 only `packages:`
// keys carry a resolution, while importers name a version at deeper indent
// and a `link:` resolves nothing.
//
// The @sigstore packages are optional peers of pariksha, loaded only when this
// check runs, so a repository without them still runs every other check.
//
// Exit: 0 every own package is the repository's signed build, 1 one is not or
// could not be read, 2 the settings are not ones this reads.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRepoPath } from './registry-ratchet.ts';

export interface OwnProvenanceConfig {
  /** The repository's own npm scope, `@name/`. */
  readonly scope: string;
  /** The repository the release workflow runs in, `https://github.com/<owner>/<repo>`. */
  readonly repository: string;
  /** The release workflow's path in it. */
  readonly workflow: string;
  /** The lockfile, relative to the root. */
  readonly lockfile: string;
  /** The trusted root, relative to the root; undefined for the one pariksha ships. */
  readonly trustedRoot: string | undefined;
}

export interface OwnPackage {
  name: string;
  version: string;
  integrity: string;
}

export type FetchJson = (url: string) => Promise<unknown>;

/** Who must have signed a version's provenance. */
export interface SigningPolicy {
  subjectAlternativeName: string;
  extensions: { issuer: string };
}

/** Verifies a Sigstore bundle against a policy; throws when it does not verify. */
export type VerifyBundle = (bundle: unknown, policy: SigningPolicy) => void;

const SLSA = 'https://slsa.dev/provenance/v1';
/** The OIDC issuer Fulcio records for a GitHub Actions run. */
const ISSUER = 'https://token.actions.githubusercontent.com';
/** How long one registry answer may take before the check fails closed. */
const FETCH_TIMEOUT_MS = 30_000;
const KEYS = ['scope', 'repository', 'workflow', 'lockfile', 'trustedRoot'];

/** The trusted root pariksha ships, read when the settings name none. */
export const SHIPPED_TRUSTED_ROOT = fileURLToPath(new URL('../baselines/sigstore-trusted-root.json', import.meta.url));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A caught value as text, never throwing: an Error's message (or its name when the message is empty), anything else through `String`. */
export const errorDetail = (error: unknown): string => {
  try {
    if (error instanceof Error) {
      const { message, name } = error;
      if (typeof message === 'string' && message !== '') return message;
      return typeof name === 'string' && name !== '' ? name : 'Error';
    }
    return String(error);
  } catch {
    // fail-open: describing the error must not raise a second one.
    return '[unprintable error]';
  }
};

const ignore = (): undefined => undefined;

/** Calls a sink with a line, absorbing its throw or rejection: reporting must not become a second failure. */
export const safeLog = (sink: (line: string) => unknown, line: string): void => {
  try {
    Promise.resolve(sink(line)).then(ignore, ignore);
  } catch {
    // fail-open: a logging sink failed; the check's own outcome stands.
  }
};

/** `{ "scope": "@name/", "repository": "https://github.com/…", "workflow": "<path>", "lockfile"?: "<path>", "trustedRoot"?: "<path>" }`; anything else throws. */
export const parseOwnProvenanceConfig = (text: string): OwnProvenanceConfig => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  const unknown = Object.keys(raw).find((k) => !KEYS.includes(k));
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"; own-provenance reads ${KEYS.join(', ')}`);
  const { scope, repository, workflow } = raw;
  if (typeof scope !== 'string' || !/^@[^/\s]+\/$/.test(scope)) throw new Error('"scope" must be the npm scope of the repository\'s own packages, such as "@name/": starting with @ and ending in /');
  if (typeof repository !== 'string' || !repository.startsWith('https://github.com/') || repository.length === 'https://github.com/'.length) {
    throw new Error('"repository" must be the repository its release runs in, starting with https://github.com/');
  }
  if (typeof workflow !== 'string' || workflow.trim() === '') throw new Error('"workflow" must be the release workflow\'s path, such as ".github/workflows/release.yml"');
  const optional = (key: 'lockfile' | 'trustedRoot'): string | undefined => {
    if (!(key in raw)) return undefined;
    const value = raw[key];
    // Under the root, normalized: a lockfile or trust anchor read from
    // outside the repository is not the one it commits.
    if (typeof value !== 'string' || value.trim() === '' || !isRepoPath(value)) throw new Error(`"${key}" must be a normalized path under the root, such as "pnpm-lock.yaml"`);
    return value;
  };
  return { scope, repository, workflow, lockfile: optional('lockfile') ?? 'pnpm-lock.yaml', trustedRoot: optional('trustedRoot') };
};

/** Who signs a release, as the messages name it. */
const releaser = (config: OwnProvenanceConfig): string => `${config.repository.slice('https://github.com/'.length)}'s release`;

/** Who must have signed the provenance of `version`: the repository's release workflow at its tag. */
export const signingPolicy = (version: string, config: OwnProvenanceConfig): SigningPolicy => ({
  subjectAlternativeName: `${config.repository}/${config.workflow}@refs/tags/v${version}`,
  extensions: { issuer: ISSUER },
});

/** The @sigstore modules this reads, as far as it reads them. */
export interface Sigstore {
  readonly bundleFromJSON: (bundle: unknown) => unknown;
  readonly trustedRootFromJSON: (root: unknown) => unknown;
  readonly toTrustMaterial: (root: unknown) => unknown;
  readonly toSignedEntity: (bundle: unknown) => unknown;
  readonly Verifier: new (trustMaterial: unknown) => { verify: (entity: unknown, policy: SigningPolicy) => unknown };
}

/** The three modules, as `import()` gives them; each export is checked before it is used. */
export type SigstoreModules = readonly [{ bundleFromJSON?: unknown }, { TrustedRoot?: unknown }, { toSignedEntity?: unknown; toTrustMaterial?: unknown; Verifier?: unknown }];

const SIGSTORE_MISSING = 'needs @sigstore/bundle (>=5 <6), @sigstore/protobuf-specs (>=0.5 <0.6) and @sigstore/verify (>=4.1 <5) installed beside pariksha';

/** The @sigstore modules from pariksha's resolution of its optional peers; a message naming why not when they cannot be loaded. */
export const loadSigstore = async (
  load: () => Promise<SigstoreModules> = () => Promise.all([import('@sigstore/bundle'), import('@sigstore/protobuf-specs'), import('@sigstore/verify')]),
): Promise<Sigstore | string> => {
  let modules: SigstoreModules;
  try {
    modules = await load();
  } catch {
    // fail-open: not installed beside pariksha; the message returned fails the check
    return SIGSTORE_MISSING;
  }
  const [bundle, specs, verify] = modules;
  const fromJSON = isRecord(specs.TrustedRoot) ? specs.TrustedRoot['fromJSON'] : undefined;
  const loaded = [bundle.bundleFromJSON, fromJSON, verify.toTrustMaterial, verify.toSignedEntity, verify.Verifier];
  if (!loaded.every((fn) => typeof fn === 'function')) return SIGSTORE_MISSING;
  const [bundleFromJSON, trustedRootFromJSON, toTrustMaterial, toSignedEntity, Verifier] = loaded as [Sigstore['bundleFromJSON'], Sigstore['trustedRootFromJSON'], Sigstore['toTrustMaterial'], Sigstore['toSignedEntity'], Sigstore['Verifier']];
  return { bundleFromJSON, trustedRootFromJSON, toTrustMaterial, toSignedEntity, Verifier };
};

/**
 * A verifier that trusts only the trusted root in `rootText`; throws when the
 * text is not one. The Verifier's defaults ask one Rekor entry, one SCT and
 * one timestamp.
 */
export const bundleVerifier = (rootText: string, sigstore: Sigstore): VerifyBundle => {
  const root: unknown = JSON.parse(rootText);
  if (!isRecord(root)) throw new Error('the trusted root must be a JSON object');
  const verifier = new sigstore.Verifier(sigstore.toTrustMaterial(sigstore.trustedRootFromJSON(root)));
  return (bundle, policy) => {
    verifier.verify(sigstore.toSignedEntity(sigstore.bundleFromJSON(bundle)), policy);
  };
};

/** The registry's attestations answer, or null when it is not one. */
const attestationsOf = (document: unknown): { attestations: unknown[] } | null => (isRecord(document) && Array.isArray(document['attestations']) ? { attestations: document['attestations'] as unknown[] } : null);

/** An attestation's bundle when it is SLSA provenance carrying a DSSE payload; the bundle as served, every field kept for the verifier. */
const slsaBundle = (entry: unknown): { bundle: Record<string, unknown>; payload: string } | null => {
  if (!isRecord(entry) || entry['predicateType'] !== SLSA) return null;
  const bundle = entry['bundle'];
  if (!isRecord(bundle)) return null;
  const envelope = bundle['dsseEnvelope'];
  if (!isRecord(envelope) || typeof envelope['payload'] !== 'string') return null;
  return { bundle, payload: envelope['payload'] };
};

/** The SLSA statement's fields this checks: the workflow's fields and each subject's sha512. */
interface Statement {
  workflow: Record<string, unknown>;
  digests: unknown[];
}

/**
 * The fields this checks, or null when the statement is not one this reads.
 * Each field may be absent, so a missing one is named as a failure of its
 * own; present, it must have its shape (null is not absent).
 */
const statementOf = (value: unknown): Statement | null => {
  if (!isRecord(value)) return null;
  const digests: unknown[] = [];
  if ('subject' in value) {
    const subjects = value['subject'];
    if (!Array.isArray(subjects)) return null;
    for (const subject of subjects as unknown[]) {
      if (!isRecord(subject)) return null;
      if (!('digest' in subject)) continue;
      const digest = subject['digest'];
      if (!isRecord(digest)) return null;
      digests.push(digest['sha512']);
    }
  }
  // Each level is optional: an absent one leaves the workflow empty, a malformed one refuses the statement.
  let level: unknown = value;
  for (const key of ['predicate', 'buildDefinition', 'externalParameters', 'workflow']) {
    const record = level as Record<string, unknown>;
    if (!(key in record)) return { workflow: {}, digests };
    level = record[key];
    if (!isRecord(level)) return null;
  }
  return { workflow: level as Record<string, unknown>, digests };
};

/**
 * The SLSA bundle among a version's attestations and the statement it
 * carries, both from the same attestation, or why there is none.
 */
const provenanceOf = (document: unknown): { bundle: unknown; statement: Statement } | string => {
  const answer = attestationsOf(document);
  if (answer === null) return 'the registry served no attestations';
  const found = answer.attestations.map(slsaBundle).find((entry) => entry !== null);
  if (found === undefined) return 'it has no SLSA provenance';
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(found.payload, 'base64').toString('utf8'));
  } catch {
    // fail-open: the reason returned is a failure, so the check still fails
    return 'its SLSA provenance is not JSON';
  }
  const statement = statementOf(parsed);
  return statement === null ? 'its SLSA provenance is not a statement this reads' : { bundle: found.bundle, statement };
};

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The lines of every top-level `packages:` section, in every YAML document
 * of the lockfile (pnpm 12 writes two), each from its key to the next line
 * that is not indented.
 */
export const packagesSections = (lockText: string): string => {
  const kept: string[] = [];
  let inside = false;
  for (const line of lockText.split('\n')) {
    if (line !== '' && !line.startsWith(' ')) inside = line === 'packages:';
    if (inside) kept.push(line);
  }
  return kept.join('\n');
};

/**
 * The own packages a pnpm lockfile resolves, and every own key it names that
 * is not one of them. Those are failures, so nothing own goes unchecked.
 */
export const ownPackages = (lockText: string, config: OwnProvenanceConfig): { packages: OwnPackage[]; unread: string[] } => {
  const scope = escape(config.scope);
  // A key of the lockfile's `packages:` section that resolves by integrity,
  // plain, single- or double-quoted (pnpm writes single quotes; YAML allows all three).
  const readable = new RegExp(`^ {2}(['"]?)(${scope}[a-z0-9-]+)@([0-9]+\\.[0-9]+\\.[0-9]+)\\1:\\n {4}resolution: \\{integrity: (sha512-[A-Za-z0-9+/]+=*)\\}$`, 'gm');
  // Every own key at the top of a section, in whatever shape or quoting.
  const ownKey = new RegExp(`^ {2}['"]?(${scope}[^@'"\\s]+@[^'"\\s(]+)`, 'gm');
  const packages: OwnPackage[] = [];
  // Every group in both patterns is required, so each match holds them all.
  // Resolutions are read from the `packages:` sections alone: a look-alike
  // entry in another section must not stand in for a package's real one.
  for (const match of packagesSections(lockText).matchAll(readable)) {
    const [name, version, integrity] = match.slice(2, 5) as [string, string, string];
    packages.push({ name, version, integrity });
  }
  const read = new Set(packages.map((p) => `${p.name}@${p.version}`));
  const keys = new Set<string>();
  for (const match of lockText.matchAll(ownKey)) keys.add((match[1] as string).replace(/:$/, ''));
  return { packages, unread: [...keys].filter((key) => !read.has(key)) };
};

/** Where the registry serves a version's attestations. */
export const attestationsUrl = (name: string, version: string): string => `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace('/', '%2f')}@${version}`;

/** Why a package's provenance does not show the repository's release built and signed it; empty when it does. */
export const provenanceFailures = (pkg: OwnPackage, document: unknown, verifyBundle: VerifyBundle, config: OwnProvenanceConfig): string[] => {
  const at = `${pkg.name}@${pkg.version}`;
  const provenance = provenanceOf(document);
  if (typeof provenance === 'string') return [`${at}: ${provenance}`];
  const { bundle, statement } = provenance;
  const failures: string[] = [];
  try {
    verifyBundle(bundle, signingPolicy(pkg.version, config));
  } catch (error) {
    // fail-open: the error is recorded as a failure, so the check still fails
    failures.push(`${at}: its provenance is not signed by ${releaser(config)} of v${pkg.version} (${errorDetail(error)})`);
  }
  const expected = { repository: config.repository, path: config.workflow, ref: `refs/tags/v${pkg.version}` };
  for (const [key, value] of Object.entries(expected)) {
    const actual = statement.workflow[key];
    if (actual !== value) failures.push(`${at}: built with workflow ${key} ${JSON.stringify(actual ?? null)}, not ${JSON.stringify(value)}`);
  }
  const bytes = Buffer.from(pkg.integrity.slice('sha512-'.length), 'base64');
  // A SHA-512 digest is 64 bytes; anything else (an empty or cut-off hash)
  // could only match an attestation that is malformed the same way.
  if (bytes.length !== 64) {
    failures.push(`${at}: the lockfile's integrity is not a SHA-512 digest`);
    return failures;
  }
  const digest = bytes.toString('hex');
  if (!statement.digests.includes(digest)) failures.push(`${at}: the attested tarball is not the one the lockfile installs`);
  return failures;
};

/** One package's failures, a registry it cannot reach among them. */
const packageFailures = async (pkg: OwnPackage, fetchJson: FetchJson, verifyBundle: VerifyBundle, config: OwnProvenanceConfig): Promise<string[]> => {
  let document: unknown;
  try {
    document = await fetchJson(attestationsUrl(pkg.name, pkg.version));
  } catch (error) {
    // fail-open: the error is returned as a failure, so the check still fails
    return [`${pkg.name}@${pkg.version}: its attestations could not be read (${errorDetail(error)})`];
  }
  return provenanceFailures(pkg, document, verifyBundle, config);
};

/** Every own package's failures, in lockfile order. */
export const check = async (lockText: string, fetchJson: FetchJson, verifyBundle: VerifyBundle, config: OwnProvenanceConfig): Promise<{ packages: OwnPackage[]; failures: string[] }> => {
  const { packages, unread } = ownPackages(lockText, config);
  const failures = unread.map((key) => `${key}: the lockfile names it in a shape this check does not read, so it is not checked`);
  // A repository that names its scope resolves some of it, so a lockfile with no own package is one this did not read.
  if (packages.length === 0) failures.push(`the lockfile resolves no ${config.scope} package, so nothing was checked`);
  const each = await Promise.all(packages.map((pkg) => packageFailures(pkg, fetchJson, verifyBundle, config)));
  return { packages, failures: [...failures, ...each.flat()] };
};

/**
 * The registry's attestations answer, or null when it is not one; throws the
 * status of a bad response, and a timeout after FETCH_TIMEOUT_MS so a stalled
 * registry fails the check instead of holding a push.
 */
export const fetchRegistryJson = async (url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<unknown> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status.toString()}`);
  return attestationsOf(await response.json());
};

export interface OwnProvenanceDeps {
  readonly readFile: (path: string) => string;
  readonly loadSigstore: () => Promise<Sigstore | string>;
  readonly fetchJson: FetchJson;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const defaultDeps: OwnProvenanceDeps = {
  readFile: (path) => readFileSync(path, 'utf8'),
  loadSigstore: () => loadSigstore(),
  fetchJson: fetchRegistryJson,
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
};

/** Runs the check on the repository at `root` with its settings' text, and reports it; resolves to the exit code. */
export const ownProvenance = async (settings: string, root: string, deps: OwnProvenanceDeps): Promise<number> => {
  const report = (line: string): void => {
    safeLog(deps.err, `own-provenance: ${line}`);
  };
  let config: OwnProvenanceConfig;
  try {
    config = parseOwnProvenanceConfig(settings);
  } catch (error) {
    // fail-open: reported, and the exit code returned is 2
    report(errorDetail(error));
    return 2;
  }
  let lockText: string;
  try {
    lockText = deps.readFile(resolve(root, config.lockfile));
  } catch (error) {
    // fail-open: reported, and the exit code returned is 1
    report(`${config.lockfile} could not be read (${errorDetail(error)})`);
    return 1;
  }
  const sigstore = await deps.loadSigstore();
  if (typeof sigstore === 'string') {
    report(sigstore);
    return 1;
  }
  let verifyBundle: VerifyBundle;
  try {
    verifyBundle = bundleVerifier(deps.readFile(config.trustedRoot === undefined ? SHIPPED_TRUSTED_ROOT : resolve(root, config.trustedRoot)), sigstore);
  } catch (error) {
    // fail-open: reported, and the exit code returned is 1
    report(`the Sigstore trusted root could not be read or loaded (${errorDetail(error)})`);
    return 1;
  }
  const { packages, failures } = await check(lockText, deps.fetchJson, verifyBundle, config);
  for (const failure of failures) report(failure);
  if (failures.length > 0) {
    report(`${config.scope}* skips the release age only when ${releaser(config)} built and signed it.`);
    return 1;
  }
  const checked = packages.map((p) => `${p.name}@${p.version}`).join(', ');
  safeLog(deps.out, `✅ own-provenance: ${checked} built and signed by ${config.repository} ${config.workflow}`);
  return 0;
};
