import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { loadTypescript, typescriptLoaders } from './typescript.ts';

const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-ts-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

describe('loadTypescript', () => {
  const missing = () => {
    throw new Error('Cannot find module');
  };
  const real = loadTypescript();

  it('loads the API beside pariksha by default', () => {
    assert.equal(typeof real, 'object');
  });

  it('names the package when no loader has it', () => {
    assert.equal(loadTypescript([missing, missing]), 'needs the typescript package (>=5.4 <6) in the repository or beside pariksha');
  });

  it('takes the first loader that has it: the repository before pariksha', () => {
    assert.equal(loadTypescript([missing, () => real]), real);
    assert.match(String(loadTypescript([() => ({ version: '7.0.2' }), () => real])), /typescript 7\.0\.2 does not export/);
  });

  it('refuses a typescript with no compiler API, naming its version', () => {
    assert.match(String(loadTypescript([() => ({ version: '7.0.2' })])), /typescript 7\.0\.2 does not export; install typescript >=5\.4 <6/);
  });

  it('finds the repository’s own typescript from its root', () => {
    const root = tree({ 'package.json': '{}', 'node_modules/typescript/package.json': '{"name":"typescript","main":"index.js"}', 'node_modules/typescript/index.js': 'module.exports = { version: "9.9.9" };' });
    assert.match(String(loadTypescript(typescriptLoaders(root))), /typescript 9\.9\.9 does not export/);
  });
});
