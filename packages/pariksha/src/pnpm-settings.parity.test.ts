/**
 * pnpm-settings against the TypeScript check it was ported from, on three
 * plants. The original cannot run here (it lives in the product, and needs
 * `semver` and `yaml`), so each case holds what it printed on the same
 * files: its exit code and its stderr, line for line, its rule id replaced by
 * the config's `id`. The product-side run that recorded them also compares
 * pariksha's range matcher with `semver` itself.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from './cli.ts';

const PATCH = 'diff --git a/x b/x\n';
const HASH = createHash('sha256').update(PATCH).digest('hex');
const WORKSPACE = ['overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'patchedDependencies:', '  foo@1.0.0: patches/foo@1.0.0.patch', ''].join('\n');
const LOCK = ["lockfileVersion: '9.0'", 'overrides:', "  tar@<=7.5.20: '>=7.5.21 <8'", 'patchedDependencies:', `  foo@1.0.0: ${HASH}`, 'packages:', '  tar@7.5.21: {}', ''].join('\n');
const TAIL = 'A successful `pnpm install` is not evidence here — pnpm 11 drops these settings without warning.\n';

const ported = (files: { pkg?: unknown; workspace?: string; lock?: string }) => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-pnpm-parity-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(files.pkg ?? { name: 'fx' }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), files.workspace ?? WORKSPACE);
  writeFileSync(join(root, 'pnpm-lock.yaml'), files.lock ?? LOCK);
  mkdirSync(join(root, 'patches'));
  writeFileSync(join(root, 'patches', 'foo@1.0.0.patch'), PATCH);
  writeFileSync(join(root, 'cfg.json'), JSON.stringify({ id: 'CFG-005' }));
  const out: string[] = [];
  const err: string[] = [];
  const code = run(['pnpm-settings', '--root', root, '--config', 'cfg.json'], { out: (l) => out.push(l), err: (l) => err.push(l) }, '0');
  return { code, out, err };
};

const refused = (...failures: string[]) => ({ code: 1, out: [], err: [`\n❌ CFG-005: pnpm settings parity FAILED (${failures.length} problem(s))\n`, ...failures.map((f) => ` • ${f}\n`), TAIL] });

describe('pnpm-settings refuses what its original refuses', () => {
  it('passes the clean plant base', () => {
    assert.deepEqual(ported({}), { code: 0, out: ['✅ CFG-005: pnpm settings parity OK — 1 override(s), 1 patch(es), 1 resolved version(s) verified.'], err: [] });
  });

  it('a pnpm block planted in package.json', () => {
    assert.deepEqual(
      ported({ pkg: { name: 'fx', pnpm: { overrides: { 'tar@<=7.5.20': '>=7.5.21 <8' } } } }),
      refused('package.json#pnpm still declares `overrides`. pnpm 11 does not read these and will not warn. Move them to pnpm-workspace.yaml. See https://github.com/pnpm/pnpm/issues/11536'),
    );
  });

  it('an override declared but absent from the lockfile', () => {
    assert.deepEqual(
      ported({ workspace: WORKSPACE.replace('overrides:\n', "overrides:\n  left-pad@<1.3.0: '>=1.3.0'\n") }),
      refused('override `left-pad@<1.3.0` is declared in pnpm-workspace.yaml but absent from the lockfile.'),
    );
  });

  it('a resolved version inside an excluded range', () => {
    assert.deepEqual(
      ported({ lock: LOCK.replace('  tar@7.5.21: {}', '  tar@7.5.21: {}\n  tar@7.5.19: {}') }),
      refused('override `tar@<=7.5.20` did not take effect: tar@7.5.19 is still resolved, and it falls inside the excluded range `<=7.5.20`.'),
    );
  });
});
