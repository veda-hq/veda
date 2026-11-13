#!/usr/bin/env node
// What stands in for pnpm's release age on veda's own packages.
//
// pnpm-workspace.yaml exempts @veda-hq/* from minimumReleaseAge (Alok,
// 2026-11-14): the day's wait is a bet that someone else catches a hijacked
// release, and nobody else watches these. Instead, every @veda-hq package the
// lockfile resolves must carry npm provenance saying veda-hq/veda's release
// workflow built it from the tag of its own version, for the very tarball the
// lockfile installs. A release published any other way (a stolen token, a fork,
// another workflow) fails here before anything runs it.
//
// This reads the statement the registry serves and checks who built what. It
// does not verify the bundle's Sigstore signature, nor compare the signing
// certificate's identity with the workflow fields: it trusts the registry to
// have checked the bundle at publish.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SCOPE = '@veda-hq/';
export const REPOSITORY = 'https://github.com/veda-hq/veda';
export const WORKFLOW = '.github/workflows/release.yml';
export const SLSA = 'https://slsa.dev/provenance/v1';

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

/** The SLSA statement among a version's attestations, or a reason there is none. @param {unknown} document */
function statementOf(document) {
  const list = /** @type {{ attestations?: unknown }} */ (document ?? {}).attestations;
  if (!Array.isArray(list)) return 'the registry served no attestations';
  const slsa = list.find(a => a?.predicateType === SLSA);
  const payload = slsa?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== 'string') return 'it has no SLSA provenance';
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return 'its SLSA provenance is not JSON';
  }
}

/**
 * Why a package's provenance does not show veda's release built it; empty when it does.
 * @param {{ name: string, version: string, integrity: string }} pkg
 * @param {unknown} document the registry's attestations response
 * @returns {string[]}
 */
export function provenanceFailures(pkg, document) {
  const at = `${pkg.name}@${pkg.version}`;
  const statement = statementOf(document);
  if (typeof statement === 'string') return [`${at}: ${statement}`];
  const failures = [];
  const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  const expected = { repository: REPOSITORY, path: WORKFLOW, ref: `refs/tags/v${pkg.version}` };
  for (const [key, value] of Object.entries(expected)) {
    if (workflow[key] !== value) failures.push(`${at}: built with workflow ${key} ${JSON.stringify(workflow[key] ?? null)}, not ${JSON.stringify(value)}`);
  }
  const digest = Buffer.from(pkg.integrity.slice('sha512-'.length), 'base64').toString('hex');
  const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
  if (!subjects.some(s => s?.digest?.sha512 === digest)) failures.push(`${at}: the attested tarball is not the one the lockfile installs`);
  return failures;
}

/**
 * Every own package's failures. @param {string} lockText
 * @param {(url: string) => Promise<unknown>} fetchJson
 */
export async function check(lockText, fetchJson) {
  const { packages, unread } = ownPackages(lockText);
  const failures = unread.map(key => `${key}: the lockfile names it in a shape this check does not read, so it is not checked`);
  // The root pins sarathi, so a lockfile with no own package is one this did not read.
  if (packages.length === 0) failures.push(`the lockfile resolves no ${SCOPE} package, so nothing was checked`);
  for (const pkg of packages) {
    let document;
    try {
      document = await fetchJson(attestationsUrl(pkg.name, pkg.version));
    } catch (error) {
      failures.push(`${pkg.name}@${pkg.version}: its attestations could not be read (${/** @type {Error} */ (error).message})`);
      continue;
    }
    failures.push(...provenanceFailures(pkg, document));
  }
  return { packages, failures };
}

/* node:coverage disable */
/** @param {string} url */
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { packages, failures } = await check(readFileSync('pnpm-lock.yaml', 'utf8'), fetchJson);
  for (const failure of failures) console.error(`own-provenance: ${failure}`);
  if (failures.length > 0) {
    console.error(`own-provenance: ${SCOPE}* skips the release age only when veda's release built it.`);
    process.exit(1);
  }
  console.log(`own-provenance: ${packages.map(p => `${p.name}@${p.version}`).join(', ')} built by ${REPOSITORY} ${WORKFLOW}`);
}
/* node:coverage enable */
