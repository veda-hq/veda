#!/usr/bin/env node
// The version rule for every release: README.md, "Releasing".
//
//   x.y.0 → x.y.1 → … → x.y.20 by patch; the release after x.y.20 is x.(y+1).0.
//   A major bump happens only with Alok's yes.
//
// Each release is compared with the previous v* tag, the highest one by
// version. Three commands:
//
//   version-rule.mjs tag vX.Y.Z [manifest…]  a tag push: the tag is the next legal version,
//                                            and every manifest is at a released version or at it
//   version-rule.mjs pending [manifest…]     a change: every manifest is at a released version
//                                            or at one shared next version, which is legal
//   version-rule.mjs approval                a major bump: the run carries Alok's own approval
//
// Manifests default to packages/*/package.json, else package.json. `tag` and
// `pending` write bump=none|first|patch|minor|major to $GITHUB_OUTPUT. A major
// bump of the right shape exits 0 with bump=major: the shared workflow then
// runs `approval`, which is what refuses it.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Who decides a major version: the GitHub login whose approval, or whose own push, counts. */
export const MAJOR_DECIDER = 'AlokBansal8';
/** The environment a major release waits in; its required reviewer is the decider. */
export const MAJOR_ENVIRONMENT = 'major-release';
/** The last patch of a minor line. */
export const PATCH_CEILING = 20;

const RULE_DOC = 'https://github.com/veda-hq/veda#releasing';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** @typedef {{ major: number, minor: number, patch: number }} Version */
/** @typedef {'none' | 'first' | 'patch' | 'minor' | 'major'} Bump */

/** @param {string} text a version, X.Y.Z or vX.Y.Z @returns {Version | undefined} */
export function parse(text) {
  const m = SEMVER.exec(text.startsWith('v') ? text.slice(1) : text);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** @param {Version} v */
export function format(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** @param {Version} a @param {Version} b */
export function compare(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The one legal release after `prev`, short of a major bump. @param {Version} prev @returns {Version} */
export function nextLegal(prev) {
  return prev.patch < PATCH_CEILING
    ? { major: prev.major, minor: prev.minor, patch: prev.patch + 1 }
    : { major: prev.major, minor: prev.minor + 1, patch: 0 };
}

/**
 * @param {Version | undefined} prev the previous release, if any
 * @param {Version} next
 * @returns {{ bump: Exclude<Bump, 'none'>, error?: string }}
 */
export function classify(prev, next) {
  if (!prev) return next.major > 0 ? majorOf(undefined, next) : { bump: 'first' };
  if (next.major > prev.major) return majorOf(prev, next);
  const legal = nextLegal(prev);
  const bump = next.patch === 0 && next.minor > prev.minor ? 'minor' : 'patch';
  if (compare(next, legal) === 0) return { bump };
  let why;
  if (compare(next, prev) <= 0) why = `it is not above the previous release ${format(prev)}`;
  else if (next.minor > prev.minor && prev.patch < PATCH_CEILING)
    why = `the minor number goes up only after ${prev.major}.${prev.minor}.${PATCH_CEILING}`;
  else if (next.minor === prev.minor && prev.patch >= PATCH_CEILING)
    why = `${prev.major}.${prev.minor}.${PATCH_CEILING} is the last patch of its line`;
  else why = 'it skips a version';
  return {
    bump,
    error: `${format(next)} breaks the version rule: ${why}. The next release after ${format(prev)} is ${format(legal)} (${RULE_DOC}).`,
  };
}

/** @param {Version | undefined} prev @param {Version} next @returns {{ bump: 'major', error?: string }} */
function majorOf(prev, next) {
  const shape = { major: prev ? prev.major + 1 : next.major, minor: 0, patch: 0 };
  if (compare(next, shape) === 0) return { bump: 'major' };
  return {
    bump: 'major',
    error: `${format(next)} is a major bump of the wrong shape: a major release is ${format(shape)}, and only with Alok's yes (${RULE_DOC}).`,
  };
}

/** The message every refused major bump carries. @param {string} version */
export function askAlok(version) {
  return (
    `${version} is a major bump. Only Alok decides a major version: ask him, and do not release it until he says yes. ` +
    `If he agrees, he approves this run's "${MAJOR_ENVIRONMENT}" deployment on GitHub himself, or pushes it himself; ` +
    `no one else's approval counts (${RULE_DOC}).`
  );
}

/** @param {readonly string[]} tagNames @returns {Version[]} the vX.Y.Z tags, highest first */
export function releaseTags(tagNames) {
  /** @type {Version[]} */
  const out = [];
  for (const name of tagNames) {
    const v = name.startsWith('v') ? parse(name) : undefined;
    if (v) out.push(v);
  }
  return out.sort((a, b) => compare(b, a));
}

/**
 * The rule over a repository's state.
 * @param {{ tags: readonly string[], manifests: readonly { path: string, version: string }[], tag?: string }} input
 * @returns {{ bump: Bump, version?: string, previous?: string, errors: string[] }}
 */
export function check(input) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Version | undefined} */
  let tag;
  if (input.tag !== undefined) {
    tag = input.tag.startsWith('v') ? parse(input.tag) : undefined;
    if (!tag) return { bump: 'none', errors: [`tag ${input.tag} is not of the form vX.Y.Z (${RULE_DOC}).`] };
  }
  const released = releaseTags(input.tags).filter((v) => !tag || compare(v, tag) !== 0);
  const prev = released[0];
  const previous = prev && format(prev);

  /** @type {Map<string, string[]>} each unreleased version → the manifests at it */
  const pending = new Map();
  for (const m of input.manifests) {
    const v = parse(m.version);
    if (!v || m.version.startsWith('v')) {
      errors.push(`${m.path}: version ${m.version} is not of the form X.Y.Z.`);
      continue;
    }
    if (released.some((r) => compare(r, v) === 0)) continue;
    const key = format(v);
    pending.set(key, [...(pending.get(key) ?? []), m.path]);
  }

  let candidate = tag;
  if (tag) {
    for (const [version, paths] of pending) {
      if (version !== format(tag)) {
        errors.push(`${paths.join(', ')}: version ${version} is neither released nor this tag's ${format(tag)}.`);
      }
    }
  } else if (pending.size > 1) {
    const list = [...pending].map(([v, paths]) => `${v} (${paths.join(', ')})`).join('; ');
    errors.push(`the unreleased versions differ: ${list}. One tag releases them all, so they share one version.`);
    return { bump: 'none', previous, errors };
  } else {
    const only = [...pending.keys()][0];
    candidate = only === undefined ? undefined : parse(only);
  }

  if (!candidate) return { bump: 'none', previous, errors };
  const verdict = classify(prev, candidate);
  if (verdict.error) errors.push(verdict.error);
  return { bump: verdict.bump, version: format(candidate), previous, errors };
}

/**
 * Whether this run may release a major version: Alok approved its deployment to the
 * major-release environment, or he triggered it himself. Both are facts GitHub
 * records server-side; nothing a workflow, a label or an input sets.
 * @param {{ actor?: string, approvals: readonly { state?: string, user?: { login?: string } | null, environments?: readonly { name?: string }[] }[] }} input
 */
export function majorApproved(input) {
  if (input.actor === MAJOR_DECIDER) return true;
  return input.approvals.some(
    (a) =>
      a.state === 'approved' &&
      a.user?.login === MAJOR_DECIDER &&
      (a.environments ?? []).some((e) => e.name === MAJOR_ENVIRONMENT),
  );
}

/** @param {string} root @returns {string[]} packages/*\/package.json, else package.json */
export function defaultManifests(root) {
  const dir = join(root, 'packages');
  if (existsSync(dir)) {
    const found = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'package.json')))
      .map((d) => join('packages', d.name, 'package.json'))
      .sort();
    if (found.length > 0) return found;
  }
  return existsSync(join(root, 'package.json')) ? ['package.json'] : [];
}

/**
 * @typedef {{
 *   cwd: string,
 *   env: Record<string, string | undefined>,
 *   gitTags: (cwd: string) => string[],
 *   fetchJson: (url: string, token: string) => Promise<unknown>,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 * }} Io
 */

/** @param {readonly string[]} argv @param {Io} io @returns {Promise<number>} the exit code */
export async function main(argv, io) {
  const [command, ...rest] = argv;
  if (command === 'approval') return approval(io);
  const tag = command === 'tag' ? rest.shift() : undefined;
  if ((command !== 'tag' && command !== 'pending') || (command === 'tag' && tag === undefined)) {
    io.err('usage: version-rule.mjs tag vX.Y.Z [manifest…] | pending [manifest…] | approval');
    return 2;
  }
  const paths = rest.length > 0 ? rest : defaultManifests(io.cwd);
  const manifests = paths.map((path) => ({
    path,
    version: String(JSON.parse(readFileSync(join(io.cwd, path), 'utf8')).version),
  }));
  const result = check({ tags: io.gitTags(io.cwd), manifests, ...(tag === undefined ? {} : { tag }) });
  const output = io.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `bump=${result.bump}\nversion=${result.version ?? ''}\n`);
  for (const e of result.errors) io.err(`::error::${e}`);
  if (result.errors.length > 0) return 1;
  if (result.bump === 'major') {
    io.err(`::warning::${askAlok(result.version ?? '')} The release waits on that.`);
  } else if (result.version) {
    io.out(`version rule: ${result.version} is the ${result.bump} release after ${result.previous ?? 'none'}.`);
  } else {
    io.out(`version rule: nothing unreleased; the next release after ${result.previous ?? 'none'} is ${result.previous ? format(nextLegal(/** @type {Version} */ (parse(result.previous)))) : 'any 0.y.z'}.`);
  }
  return 0;
}

/** @param {Io} io */
async function approval(io) {
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN, GITHUB_ACTOR } = io.env;
  const version = io.env.VERSION || 'this';
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GITHUB_TOKEN) {
    io.err(`::error::approval needs GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_TOKEN. ${askAlok(version)}`);
    return 1;
  }
  const api = GITHUB_API_URL || 'https://api.github.com';
  const approvals = await io.fetchJson(`${api}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/approvals`, GITHUB_TOKEN);
  if (!Array.isArray(approvals)) {
    io.err(`::error::could not read this run's approvals. ${askAlok(version)}`);
    return 1;
  }
  if (!majorApproved({ actor: GITHUB_ACTOR, approvals })) {
    io.err(`::error::${askAlok(version)}`);
    return 1;
  }
  io.out(`version rule: major release ${version} approved by ${MAJOR_DECIDER}.`);
  return 0;
}

// The process entry, exercised by the spawned tests rather than in-process.
/* node:coverage disable */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    gitTags: (cwd) => execFileSync('git', ['tag', '--list', 'v*'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean),
    fetchJson: async (url, token) => {
      const res = await fetch(url, {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      });
      return res.ok ? res.json() : undefined;
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
/* node:coverage enable */
