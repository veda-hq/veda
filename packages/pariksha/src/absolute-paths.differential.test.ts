/**
 * absolute-paths.ts against the shell check it was ported from
 * (oracles/absolute-paths.sh), run by bash on the same files.
 *
 * Model: documents of one to eight lines, each line one to four pieces drawn
 * from local paths (bare and in backticks), drive paths of either case, web
 * URLs that contain a local form, example words, lone and paired backticks,
 * fences with and without an info string, and `~~~`, joined with or without
 * spaces; a last line with or without its newline. Out of model: bytes that
 * are not UTF-8, and NUL. The seed is fixed, so a failure names a
 * reproducible document.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkAbsolutePaths } from './absolute-paths.ts';
import { parseDocConfig } from './doc-files.ts';

const temps: string[] = [];
/** A fresh temporary directory, removed when this file's tests end. */
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const SEED = 20_089;
const RUNS = 120;
const ORACLE = join(import.meta.dirname, 'oracles', 'absolute-paths.sh');

/** The original's own closing lines, given to the port as its guidance. */
const GUIDANCE = ['Please use relative paths only:', '  - Code files: ../../src/screens/ScreenName.tsx', '  - Images: ./image.png', '  - Other docs: ../ARCHITECTURE.md', '', 'See docs/AGENT_GUIDELINES.md for documentation guidelines'];
const config = parseDocConfig(JSON.stringify({ guidance: GUIDANCE }), []);

const PIECES = [
  '/Users/me/x',
  '`/Users/me/x`',
  '/tmp/a',
  '`/tmp/a`',
  '`/tmp/a/b`',
  '/home/u/',
  '/home/u',
  'file://x',
  'C:\\x',
  'D:\\y',
  'c:\\x',
  '~/x',
  '/var/log',
  '/private/var',
  '/var/',
  'example',
  'Forbidden',
  'must not',
  'MUST NOT',
  'plain',
  '`',
  '``',
  'x`y',
  ' ',
  'http://h/Users/',
  '```',
  '~~~',
];

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

/** `RUNS` documents, named `d<i>.md`, and the pieces drawn. */
const sample = (): { docs: Record<string, string>; drawn: Set<string> } => {
  const next = random(SEED);
  const drawn = new Set<string>();
  const docs: Record<string, string> = {};
  for (let i = 0; i < RUNS; i++) {
    const lines = Array.from({ length: 1 + Math.floor(next() * 8) }, () => {
      if (next() < 0.1) return next() < 0.5 ? '```sh' : '```';
      const pieces = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(PIECES, next));
      for (const p of pieces) drawn.add(p);
      return pieces.join(next() < 0.5 ? ' ' : '');
    });
    docs[`docs/d${i}.md`] = lines.join('\n') + (next() < 0.7 ? '\n' : '');
  }
  return { docs, drawn };
};

const write = (docs: Record<string, string>): string => {
  const root = temp('pariksha-absdiff-');
  for (const [path, body] of Object.entries(docs)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

/** The oracle's exit code and stdout lines on `files`, run from `root`. */
const oracle = (root: string, files: readonly string[]): { code: number | null; out: string[] } => {
  const r = spawnSync('bash', [ORACLE, '--files', ...files], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, out: r.stdout.replace(/\n$/, '').split('\n') };
};

const ported = (root: string, files: readonly string[]) => {
  const outcome = checkAbsolutePaths(
    files.map((file) => ({ file, text: () => readText(root, file) })),
    config,
  );
  return { code: outcome.ok ? 0 : 1, out: outcome.out };
};

const readText = (root: string, file: string): string => readFileSync(join(root, file), 'utf8');

describe('absolute-paths refuses what its shell original refuses', () => {
  it('matches the original, document by document, on sampled documents', () => {
    const { docs } = sample();
    const root = write(docs);
    const wrong = Object.keys(docs)
      .map((file) => ({ file, text: docs[file], ours: ported(root, [file]), theirs: oracle(root, [file]) }))
      .filter((entry) => JSON.stringify(entry.ours) !== JSON.stringify(entry.theirs));
    assert.deepEqual(wrong, []);
  });

  it('matches the original on all of them at once', () => {
    const { docs } = sample();
    const root = write(docs);
    const files = Object.keys(docs);
    assert.deepEqual(ported(root, files), oracle(root, files));
  });

  it('draws every piece, the same documents on every run', () => {
    const { docs, drawn } = sample();
    assert.deepEqual([...drawn].sort(), [...PIECES].sort());
    assert.deepEqual(sample().docs, docs);
  });

  it('is not vacuous: the original refuses some documents and passes others', () => {
    const { docs } = sample();
    const root = write(docs);
    const codes = new Set(Object.keys(docs).map((file) => oracle(root, [file]).code));
    assert.deepEqual([...codes].sort(), [0, 1]);
  });

  // The plant the PR's evidence names: one absolute path in prose.
  it('refuses the planted path with the same lines', () => {
    const root = write({ 'apps/server/docs/setup.md': '# Setup\n\nClone into /Users/someone/code/app first.\n' });
    const theirs = oracle(root, ['apps/server/docs/setup.md']);
    assert.equal(theirs.code, 1);
    assert.ok(theirs.out.includes('apps/server/docs/setup.md:3:Clone into /Users/someone/code/app first.'));
    assert.deepEqual(ported(root, ['apps/server/docs/setup.md']), theirs);
  });
});
