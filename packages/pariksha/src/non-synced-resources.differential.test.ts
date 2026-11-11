/**
 * non-synced-resources.ts against the shell check it was ported from
 * (oracles/non-synced-resources.sh), run by bash on the same repository.
 *
 * Model: one repository holding files, folders, a name that differs only in
 * case, a name with a space, symlinks to a file and a folder, and an image
 * over 1 MiB. Documents at the top, one level and two levels down each hold
 * one to six links (or images), on one line or several, inside a fence or
 * not. A destination is a prefix (`./`, `../`, `../../`, `/`, `<./`, none), a
 * name (present, missing, wrongly cased, a folder, `.`, `..`, beyond a
 * missing folder, through a symlink) and a suffix (fragment, query, title,
 * `>`, `/`). Documents are listed by repository-relative and by absolute
 * path. Out of model: names with glob characters (the shell strips its root
 * prefix as a pattern), and bytes that are not UTF-8. The seed is fixed.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parseDocConfig } from './doc-files.ts';
import { checkNonSyncedResources } from './non-synced-resources.ts';

const SEED = 20_089;
const RUNS = 90;
const ORACLE = join(import.meta.dirname, 'oracles', 'non-synced-resources.sh');
const config = parseDocConfig(JSON.stringify({ guidance: ['Please ensure all referenced files exist in the repository.', 'See docs/AGENT_GUIDELINES.md for documentation guidelines'] }), []);

const PREFIXES = ['./', '../', '../../', '/', '/docs/', '<./', ''];
const NAMES = ['b.md', 'B.md', 'ghost.md', 'sub', 'sub/c.md', 'sub/../b.md', 'nodir/x.md', 'with space.md', 'link.md', 'linkdir/t.md', 'linkdir/../b.md', 'big.png', 'small.png', '.', '..', ''];
const SUFFIXES = ['', '#x', '?q=1', ' "t"', '>', '> "t"', '/', '#a?b'];

/** mulberry32: a small seeded PRNG, uniform on [0, 1). */
const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const pick = <T>(items: readonly T[], next: () => number): T => items[Math.floor(next() * items.length)] as T;

const FOLDERS = ['', 'docs/', 'docs/sub/'];

/** `RUNS` documents, and the prefixes, names and suffixes drawn. */
const sample = (): { docs: Record<string, string>; drawn: Set<string> } => {
  const next = random(SEED);
  const drawn = new Set<string>();
  const docs: Record<string, string> = {};
  for (let i = 0; i < RUNS; i++) {
    const links = Array.from({ length: 1 + Math.floor(next() * 6) }, () => {
      const [prefix, name, suffix] = [pick(PREFIXES, next), pick(NAMES, next), pick(SUFFIXES, next)];
      drawn.add(`p:${prefix}`).add(`n:${name}`).add(`s:${suffix}`);
      return `${next() < 0.3 ? '!' : ''}[l${i}](${prefix}${name}${suffix})`;
    });
    const body = next() < 0.5 ? links.join(' ') : links.join('\n');
    docs[`${pick(FOLDERS, next)}n${i}.md`] = next() < 0.2 ? `\`\`\`\n${body}\n\`\`\`\n` : `${body}\n`;
  }
  return { docs, drawn };
};

/** The repository: its fixed files, then `docs`; its real path. */
const write = (docs: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-nsrdiff-')));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const files: Record<string, string> = { 'docs/b.md': '', 'docs/with space.md': '', 'docs/sub/c.md': '', 'docs/small.png': 'x', 'docs/big.png': 'x'.repeat(1_100_000), 'other/t.md': '', 'b.md': '', ...docs };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  symlinkSync('b.md', join(root, 'docs/link.md'));
  symlinkSync('../other', join(root, 'docs/linkdir'));
  return root;
};

// The oracle resolves a link as `$(cd "$(dirname "$T")" && pwd)/$(basename
// "$T")`, so its answer depends on the platform's `basename` and `dirname`.
// macOS and GNU follow POSIX: `basename repo/docs/./` is `.`, the folder
// itself. uutils, the coreutils of ubuntu-26.04, answers `docs`, so there the
// original refuses `./`, `.//` and `/./` as the missing `docs/docs`: the
// original itself refuses differently by platform. The port keeps the POSIX
// answer, so the oracle runs with POSIX tools: GNU's when the machine has them
// beside uutils, else the two small POSIX shims below, first on its PATH.
const POSIX_BASENAME = [
  '#!/usr/bin/env bash',
  's=$1',
  'while [ "${#s}" -gt 1 ] && [ "${s%/}" != "$s" ]; do s=${s%/}; done',
  'if [ "$s" = / ]; then echo /; exit 0; fi',
  "printf '%s\\n' \"${s##*/}\"",
  '',
].join('\n');
const POSIX_DIRNAME = [
  '#!/usr/bin/env bash',
  's=$1',
  'while [ "${#s}" -gt 1 ] && [ "${s%/}" != "$s" ]; do s=${s%/}; done',
  'case $s in */*) ;; *) echo .; exit 0 ;; esac',
  's=${s%/*}',
  'while [ "${#s}" -gt 1 ] && [ "${s%/}" != "$s" ]; do s=${s%/}; done',
  "printf '%s\\n' \"${s:-/}\"",
  '',
].join('\n');

const run = (command: string, args: readonly string[]): string | undefined => {
  const r = spawnSync(command, args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

/** The PATH the oracle runs with: the machine's own when its `basename` is POSIX. */
const oraclePath = ((): string => {
  const path = process.env['PATH'] ?? '';
  if (run('basename', ['a/./']) === '.' && run('dirname', ['a/./']) === 'a') return path;
  const tools = mkdtempSync(join(tmpdir(), 'pariksha-posix-tools-'));
  for (const [name, shim] of [
    ['basename', POSIX_BASENAME],
    ['dirname', POSIX_DIRNAME],
  ] as const) {
    const gnu = ['gnu', 'g'].map((prefix) => run('bash', ['-c', `command -v ${prefix}${name}`])).find((found) => found !== undefined && found !== '');
    if (gnu !== undefined) symlinkSync(gnu, join(tools, name));
    else writeFileSync(join(tools, name), shim, { mode: 0o755 });
  }
  return `${tools}:${path}`;
})();

describe('the POSIX tools the oracle runs with', () => {
  it('answer as POSIX does', () => {
    const env = { ...process.env, PATH: oraclePath };
    const ask = (name: string, arg: string) => spawnSync(name, [arg], { encoding: 'utf8', env }).stdout.trim();
    const cases: [string, string, string][] = [
      ['basename', 'repo/docs/./', '.'],
      ['basename', 'repo/docs/.//', '.'],
      ['basename', 'repo/b.md', 'b.md'],
      ['basename', '/', '/'],
      ['dirname', 'repo/docs/.//', 'repo/docs'],
      ['dirname', 'b.md', '.'],
      ['dirname', '/b.md', '/'],
      ['dirname', 'repo//b.md/', 'repo'],
    ];
    for (const [name, arg, expected] of cases) assert.equal(ask(name, arg), expected, `${name} ${arg}`);
  });
});

/** The oracle's exit code and stdout lines on `files`, run from `root`. */
const oracle = (root: string, files: readonly string[]): { code: number | null; out: string[] } => {
  const r = spawnSync('bash', [ORACLE, '--files', ...files], { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PATH: oraclePath } });
  return { code: r.status, out: r.stdout.replace(/\n$/, '').split('\n') };
};

const ported = (root: string, files: readonly string[]) => {
  const outcome = checkNonSyncedResources(
    files.map((file) => ({ file, text: () => readFileSync(resolve(root, file), 'utf8') })),
    () => root,
    config,
  );
  return { code: outcome.ok ? 0 : 1, out: outcome.out };
};

describe('non-synced-resources refuses what its shell original refuses', () => {
  it('matches the original, document by document, by relative and absolute path', () => {
    const { docs } = sample();
    const root = write(docs);
    const wrong = Object.keys(docs)
      .flatMap((file) => [file, join(root, file)])
      .map((file) => ({ file, ours: ported(root, [file]), theirs: oracle(root, [file]) }))
      .filter((entry) => JSON.stringify(entry.ours) !== JSON.stringify(entry.theirs));
    assert.deepEqual(wrong, []);
  });

  it('matches the original on all of them at once', () => {
    const { docs } = sample();
    const root = write(docs);
    const files = Object.keys(docs);
    assert.deepEqual(ported(root, files), oracle(root, files));
  });

  it('draws every prefix, name and suffix, the same documents on every run', () => {
    const { docs, drawn } = sample();
    const all = [...PREFIXES.map((p) => `p:${p}`), ...NAMES.map((n) => `n:${n}`), ...SUFFIXES.map((s) => `s:${s}`)];
    assert.deepEqual([...drawn].sort(), all.sort());
    assert.deepEqual(sample().docs, docs);
  });

  it('is not vacuous: the original refuses some documents, passes others, and warns', () => {
    const { docs } = sample();
    const root = write(docs);
    const runs = Object.keys(docs).map((file) => oracle(root, [file]));
    assert.deepEqual([...new Set(runs.map((r) => r.code))].sort(), [0, 1]);
    for (const kind of ['non-existent directory', 'outside repository', 'non-existent file', 'Large image']) {
      assert.ok(
        runs.some((r) => r.out.some((line) => line.includes(kind))),
        kind,
      );
    }
  });

  // The plant the PR's evidence names: a link to a file never committed.
  it('refuses the planted link with the same lines', () => {
    const root = write({ 'apps/server/docs/links.md': '# Links\n\nSee [a ghost](./ghost.md).\n' });
    const theirs = oracle(root, ['apps/server/docs/links.md']);
    assert.equal(theirs.code, 1);
    assert.ok(theirs.out.includes('❌ Error: Reference to non-existent file in apps/server/docs/links.md:'));
    assert.deepEqual(ported(root, ['apps/server/docs/links.md']), theirs);
  });
});
