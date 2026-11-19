#!/usr/bin/env node
// What stands in for pnpm's release age on veda's own packages.
//
// pnpm-workspace.yaml exempts @veda-hq/* from minimumReleaseAge (Alok,
// 2026-11-14): the day's wait is a bet that someone else catches a hijacked
// release, and nobody else watches these. Instead, every @veda-hq package the
// lockfile resolves must carry npm provenance saying its own repository's
// release workflow (veda-hq/veda's, or the one OTHER_REPOSITORIES names) built
// it from the tag of its own version, for the very tarball the
// lockfile installs. A release published any other way (a stolen token, a fork,
// another workflow) fails here before anything runs it.
//
// niyam is the exception (RELEASED_FROM_MAIN). Since 0.6.18 its release runs on
// a push to main and makes the tag itself (niyam's P-61), so its certificate
// names refs/heads/main, which says nothing of the version. For niyam the
// certificate's source commit must be the commit niyam's v<version> tag names,
// and that tag is read from GitHub (veda-hq/niyam, Alok's option A on
// veda-hq/veda#220). So for niyam this check is not offline: a GitHub answer
// that fails, or that names no commit, refuses the package, never passes it.
//
// The statement's workflow fields are written by whoever ran npm publish, so
// they alone prove nothing. What binds them is the Sigstore bundle around the
// statement. This verifies it offline with @sigstore/verify:
// - the signature over the statement;
// - the signing certificate's chain to Sigstore's public-good Fulcio;
// - its signed certificate timestamp, and the Rekor entry that times it;
// - the certificate's identity. Its SAN must name that repository's release
//   workflow at the version's tag (for niyam, at refs/heads/main, with the
//   tag's commit as its source repository digest), and its issuer must be
//   GitHub Actions.
//
// The trust anchors are sigstore-trusted-root.json beside this script: the
// public-good trusted_root.json, whose sha256 matched Sigstore's TUF targets
// (tuf-repo-cdn.sigstore.dev, targets v14) on 2026-11-14. When Sigstore rotates
// a key, new releases fail here until the file is refreshed: take
// targets/trusted_root.json from sigstore/root-signing, and check its sha256
// against the trusted_root.json entry of the latest targets.json on the TUF CDN.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';

export const SCOPE = '@veda-hq/';
export const REPOSITORY = 'https://github.com/veda-hq/veda';
/**
 * The own packages another veda-hq repository releases, each by name: its
 * release workflow, at the same path, must have built it. Every other
 * @veda-hq package comes from REPOSITORY.
 */
export const OTHER_REPOSITORIES = Object.freeze({ '@veda-hq/niyam': 'https://github.com/veda-hq/niyam' });
export const WORKFLOW = '.github/workflows/release.yml';

/** The repository whose release must have built package `name`. @param {string} name */
export const repositoryOf = name => (Object.hasOwn(OTHER_REPOSITORIES, name) ? OTHER_REPOSITORIES[name] : REPOSITORY);
/**
 * The own packages whose release runs on a push to main and tags the commit it
 * built: each must be built from main, at the commit its version's tag names.
 */
export const RELEASED_FROM_MAIN = Object.freeze(['@veda-hq/niyam']);
/** The branch RELEASED_FROM_MAIN packages are released from. */
export const MAIN = 'refs/heads/main';
export const SLSA = 'https://slsa.dev/provenance/v1';
/** The OIDC issuer Fulcio records for a GitHub Actions run. */
export const ISSUER = 'https://token.actions.githubusercontent.com';
/** Fulcio's Source Repository Digest extension: the commit the run built. */
export const SOURCE_COMMIT_OID = Object.freeze([1, 3, 6, 1, 4, 1, 57264, 1, 13]);
/**
 * Fulcio's Source Repository Ref extension: the ref the run built. The SAN
 * alone does not pin it, since @sigstore/verify matches the SAN as an
 * unanchored pattern (refs/heads/main-other would pass).
 */
export const SOURCE_REF_OID = Object.freeze([1, 3, 6, 1, 4, 1, 57264, 1, 14]);
export const GITHUB_API = 'https://api.github.com';
export const TRUSTED_ROOT = fileURLToPath(new URL('sigstore-trusted-root.json', import.meta.url));

/** `owner/name` of a https://github.com/ repository. @param {string} repository */
const slugOf = repository => repository.replace('https://github.com/', '');

/** A full git commit id. */
const COMMIT = /^[0-9a-f]{40}$/;

/** The DER UTF8String of a short ASCII `text`, as Fulcio writes its v2 extensions. @param {string} text */
const utf8String = text => Buffer.concat([Buffer.from([0x0c, text.length]), Buffer.from(text, 'ascii')]);

/**
 * Who must have signed the provenance of `version`: the release workflow of
 * `repository` at its tag, or, given `commit`, the same workflow on main with
 * `commit` (the one the version's tag names) as the certificate's source
 * commit and exactly main as its source ref. Fulcio writes those extensions
 * as DER UTF8Strings.
 * @param {string} version
 * @param {string} [repository]
 * @param {string} [commit]
 */
export const signingPolicy = (version, repository = REPOSITORY, commit = undefined) =>
  commit === undefined
    ? { subjectAlternativeName: `${repository}/${WORKFLOW}@refs/tags/v${version}`, extensions: { issuer: ISSUER } }
    : {
        subjectAlternativeName: `${repository}/${WORKFLOW}@${MAIN}`,
        extensions: { issuer: ISSUER },
        oids: [
          { oid: { id: [...SOURCE_COMMIT_OID] }, value: utf8String(commit) },
          { oid: { id: [...SOURCE_REF_OID] }, value: utf8String(MAIN) },
        ],
      };

/** Where GitHub serves `repository`'s tag v`version`. @param {string} repository @param {string} version */
export const tagUrl = (repository, version) => `${GITHUB_API}/repos/${slugOf(repository)}/git/ref/tags/v${version}`;

/**
 * The commit `repository`'s tag v`version` names, read from GitHub (an
 * annotated tag is followed to its commit), or why there is none. Every
 * failure is a reason, so a GitHub that cannot be asked refuses the package.
 * @param {string} repository
 * @param {string} version
 * @param {(url: string) => Promise<unknown>} fetchJson
 * @returns {Promise<{ commit: string } | { problem: string }>}
 */
export async function tagCommit(repository, version, fetchJson) {
  const tag = `${slugOf(repository)}'s tag v${version}`;
  let object;
  try {
    object = /** @type {any} */ (await fetchJson(tagUrl(repository, version)))?.object;
    if (object?.type === 'tag' && COMMIT.test(object.sha)) {
      object = /** @type {any} */ (await fetchJson(`${GITHUB_API}/repos/${slugOf(repository)}/git/tags/${object.sha}`))?.object;
    }
  } catch (error) {
    // fail-open: the error is returned as a problem, so the check still fails
    return { problem: `${tag} could not be read from GitHub (${/** @type {Error} */ (error).message}), so nothing binds its build from main to v${version}` };
  }
  if (object?.type === 'commit' && typeof object.sha === 'string' && COMMIT.test(object.sha)) return { commit: object.sha };
  return { problem: `${tag} names no commit on GitHub (its object is ${JSON.stringify(object ?? null)}), so nothing binds its build from main to v${version}` };
}

/**
 * A function that verifies a Sigstore bundle against a policy and throws when
 * it does not verify, trusting only the trusted root in `rootText`.
 * @param {string} rootText a trusted_root.json
 * @returns {(bundle: unknown, policy: ReturnType<typeof signingPolicy>) => void}
 */
export function bundleVerifier(rootText) {
  const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(JSON.parse(rootText))), {
    tlogThreshold: 1,
    ctlogThreshold: 1,
    timestampThreshold: 1,
  });
  return (bundle, policy) => {
    verifier.verify(toSignedEntity(bundleFromJSON(bundle)), policy);
  };
}

/**
 * The @veda-hq packages a pnpm lockfile resolves, and every @veda-hq key it
 * names that is not one of them: a prerelease, a tarball resolution, a shape
 * this does not read. Those fail, so nothing own goes unchecked.
 * @param {string} lockText
 * @returns {{ packages: { name: string, version: string, integrity: string }[], unread: string[] }}
 */
export function ownPackages(lockText) {
  const packages = [];
  const entry = /^ {2}'?(@veda-hq\/[a-z0-9-]+)@([0-9]+\.[0-9]+\.[0-9]+)'?:\n {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/]+=*)\}$/gm;
  for (const match of lockText.matchAll(entry)) packages.push({ name: match[1], version: match[2], integrity: match[3] });
  const read = new Set(packages.map(p => `${p.name}@${p.version}`));
  const keys = new Set();
  for (const match of lockText.matchAll(/^ {2}'?(@veda-hq\/[^@'\s]+@[^'\s(]+)/gm)) keys.add(match[1].replace(/:$/, ''));
  return { packages, unread: [...keys].filter(key => !read.has(key)) };
}

/** Where the registry serves a version's attestations. @param {string} name @param {string} version */
export const attestationsUrl = (name, version) =>
  `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace('/', '%2f')}@${version}`;

/**
 * The SLSA bundle among a version's attestations and the statement it carries,
 * or a reason there is none.
 * @param {unknown} document
 * @returns {string | { bundle: unknown, statement: any }}
 */
function provenanceOf(document) {
  const list = /** @type {{ attestations?: unknown }} */ (document ?? {}).attestations;
  if (!Array.isArray(list)) return 'the registry served no attestations';
  const bundle = list.find(a => a?.predicateType === SLSA)?.bundle;
  const payload = bundle?.dsseEnvelope?.payload;
  if (typeof payload !== 'string') return 'it has no SLSA provenance';
  try {
    return { bundle, statement: JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) };
  } catch {
    // fail-open: the reason returned is a failure, so the check still fails
    return 'its SLSA provenance is not JSON';
  }
}

/**
 * Why a package's provenance does not show its own repository's release built it; empty when it does.
 * @param {{ name: string, version: string, integrity: string }} pkg
 * @param {unknown} document the registry's attestations response
 * @param {ReturnType<typeof bundleVerifier>} verifyBundle
 * @param {string} [commit] for a RELEASED_FROM_MAIN package, the commit its version's tag names
 * @returns {string[]}
 */
export function provenanceFailures(pkg, document, verifyBundle, commit = undefined) {
  const at = `${pkg.name}@${pkg.version}`;
  const fromMain = RELEASED_FROM_MAIN.includes(pkg.name);
  const repository = repositoryOf(pkg.name);
  if (fromMain && (typeof commit !== 'string' || !COMMIT.test(commit))) {
    return [`${at}: no commit of ${slugOf(repository)}'s tag v${pkg.version} was given, so nothing binds its build from main to its version`];
  }
  const provenance = provenanceOf(document);
  if (typeof provenance === 'string') return [`${at}: ${provenance}`];
  const { bundle, statement } = provenance;
  const failures = [];
  const release = fromMain ? `release of ${commit}, the commit its tag v${pkg.version} names` : `release of v${pkg.version}`;
  try {
    verifyBundle(bundle, signingPolicy(pkg.version, repository, fromMain ? commit : undefined));
  } catch (error) {
    // fail-open: the error is recorded as a failure, so the check still fails
    failures.push(`${at}: its provenance is not signed by ${slugOf(repository)}'s ${release} (${/** @type {Error} */ (error).message})`);
  }
  const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  const ref = fromMain ? MAIN : `refs/tags/v${pkg.version}`;
  const expected = { repository, path: WORKFLOW, ref };
  for (const [key, value] of Object.entries(expected)) {
    if (workflow[key] !== value) failures.push(`${at}: built with workflow ${key} ${JSON.stringify(workflow[key] ?? null)}, not ${JSON.stringify(value)}`);
  }
  if (fromMain) {
    const dependencies = statement?.predicate?.buildDefinition?.resolvedDependencies;
    const source = (Array.isArray(dependencies) ? dependencies : []).find(d => d?.uri === `git+${repository}@${ref}`);
    const built = source?.digest?.gitCommit ?? null;
    if (built !== commit) failures.push(`${at}: built from commit ${JSON.stringify(built)}, not ${commit}, the commit ${slugOf(repository)}'s tag v${pkg.version} names`);
  }
  const digest = Buffer.from(pkg.integrity.slice('sha512-'.length), 'base64').toString('hex');
  const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
  if (!subjects.some(s => s?.digest?.sha512 === digest)) failures.push(`${at}: the attested tarball is not the one the lockfile installs`);
  return failures;
}

/**
 * Every own package's failures. @param {string} lockText
 * @param {(url: string) => Promise<unknown>} fetchJson
 * @param {ReturnType<typeof bundleVerifier>} verifyBundle
 */
export async function check(lockText, fetchJson, verifyBundle) {
  const { packages, unread } = ownPackages(lockText);
  const failures = unread.map(key => `${key}: the lockfile names it in a shape this check does not read, so it is not checked`);
  // The root pins sarathi, so a lockfile with no own package is one this did not read.
  if (packages.length === 0) failures.push(`the lockfile resolves no ${SCOPE} package, so nothing was checked`);
  for (const pkg of packages) {
    let commit;
    if (RELEASED_FROM_MAIN.includes(pkg.name)) {
      const tag = await tagCommit(repositoryOf(pkg.name), pkg.version, fetchJson);
      if ('problem' in tag) {
        failures.push(`${pkg.name}@${pkg.version}: ${tag.problem}`);
        continue;
      }
      commit = tag.commit;
    }
    let document;
    try {
      document = await fetchJson(attestationsUrl(pkg.name, pkg.version));
    } catch (error) {
      // fail-open: the error is recorded as a failure, so the check still fails
      failures.push(`${pkg.name}@${pkg.version}: its attestations could not be read (${/** @type {Error} */ (error).message})`);
      continue;
    }
    failures.push(...provenanceFailures(pkg, document, verifyBundle, commit));
  }
  return { packages, failures };
}

/* node:coverage disable */
/**
 * The JSON at `url`. GitHub is asked with the session's token when there is
 * one, so a busy address does not hit the anonymous rate limit.
 * @param {string} url
 */
async function fetchJson(url) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const github = url.startsWith(`${GITHUB_API}/`);
  /** @type {Record<string, string>} */
  const headers = github ? { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { packages, failures } = await check(readFileSync('pnpm-lock.yaml', 'utf8'), fetchJson, bundleVerifier(readFileSync(TRUSTED_ROOT, 'utf8')));
  for (const failure of failures) console.error(`own-provenance: ${failure}`);
  if (failures.length > 0) {
    console.error(`own-provenance: ${SCOPE}* skips the release age only when its own repository's release built it.`);
    process.exit(1);
  }
  console.log(`own-provenance: ${packages.map(p => `${p.name}@${p.version} (${repositoryOf(p.name)})`).join(', ')} built and signed by ${WORKFLOW}`);
}
/* node:coverage enable */
