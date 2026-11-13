#!/usr/bin/env node
// veda's own guards are released packages (T-9: a repository is guarded by
// the last release of its guards, never by the copy being changed). Each
// @veda-hq/* devDependency in the root package.json is an exact version, and
// node_modules holds that version, installed from the registry: never a link
// into packages/, which is the source a change edits.
//
//   released-pins.mjs [--root <dir>] [package…]
//
// With no package, checks every @veda-hq/* devDependency; with some, only
// those, each of which must be pinned. Exit 0: all in place; 1: one is not,
// with what to do; 2: a usage error.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXACT = /^\d+\.\d+\.\d+$/;

/** @param {string} file @returns {any} */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * What is wrong with each pin, empty when nothing is.
 * @param {string} root the repository's root
 * @param {string[]} [only] the packages to check; every @veda-hq/* pin when empty
 * @returns {string[]}
 */
export function problems(root, only = []) {
  const manifest = readJson(join(root, 'package.json'));
  const pins = manifest.devDependencies ?? {};
  const names = only.length > 0 ? only : Object.keys(pins).filter(name => name.startsWith('@veda-hq/'));
  const realRoot = realpathSync(root);
  const packages = join(realRoot, 'packages') + sep;
  const found = [];
  for (const name of names) {
    const pin = pins[name];
    if (pin === undefined) {
      found.push(`${name} is not a devDependency of the root package.json`);
      continue;
    }
    if (!EXACT.test(pin)) {
      found.push(`${name} is pinned as "${pin}", not as an exact released version`);
      continue;
    }
    const dir = join(root, 'node_modules', ...name.split('/'));
    if (!existsSync(join(dir, 'package.json'))) {
      found.push(`${name} ${pin} is not installed in ${root}; run pnpm install there`);
      continue;
    }
    const real = realpathSync(dir);
    if ((real + sep).startsWith(packages)) {
      found.push(`${name} resolves to ${relative(realRoot, real)}, the workspace's own source, not the released ${pin}`);
      continue;
    }
    const version = readJson(join(dir, 'package.json')).version;
    if (version !== pin) {
      found.push(`${name} ${version} is installed, but package.json pins ${pin}; run pnpm install in ${root}`);
    }
  }
  return found;
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  let root = process.cwd();
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      if (argv[i + 1] === undefined) {
        console.error('usage: released-pins.mjs [--root <dir>] [package…]');
        return 2;
      }
      root = argv[++i];
    } else {
      only.push(argv[i]);
    }
  }
  const found = problems(root, only);
  for (const problem of found) console.error(`released-pins: ${problem}`);
  return found.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
