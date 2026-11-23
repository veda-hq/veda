#!/usr/bin/env node
// Which agnipariksha lanes a pull request gives work, as a matrix for CI's
// mutation jobs (veda#273).
//
//   mutation-lanes.mjs --base <ref>
//
// Prints two GITHUB_OUTPUT lines: `matrix={"include":[{"lane":"<name>"},…]}`
// and `any=true` or `any=false`. A lane is in the matrix when the released
// agnipariksha, run with the same --base and --tracked-only, would judge a
// file in it. The plan is agnipariksha's own (its config loader, changed
// files and lane planner, from the version the root pins), never a copy of
// its matching, so CI skips a lane only where the gate would judge nothing:
// a skipped lane is a pass only when it has no work.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { changedFiles, commentOnly } from '@veda-hq/agnipariksha/dist/changed-files.js';
import { lanesOf, loadConfig } from '@veda-hq/agnipariksha/dist/config.js';
import { planLane } from '@veda-hq/agnipariksha/dist/lanes.js';

/** A file's text, or undefined when it does not exist. @param {string} path */
export function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** git in `root`, as agnipariksha runs it. @param {string} root @param {NodeJS.ProcessEnv} [env] */
export function gitIn(root, env = process.env) {
  /** @param {string[]} args */
  // stderr is captured, not printed as well: a failed command's own message
  // is in the error, and main prints that once.
  return args => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 1 << 28, stdio: 'pipe' });
}

/**
 * The names of the lanes with a file to judge, in the config's order.
 * @param {string} root the repository root, where agnipariksha.json is
 * @param {string} base the ref whose merge-base with HEAD the diff starts at
 * @param {(args: string[]) => string} [git]
 * @returns {string[]}
 */
export function lanesToJudge(root, base, git = gitIn(root)) {
  const config = loadConfig(root, readText);
  if (typeof config === 'string') throw new Error(config);
  const changes = changedFiles(git, config.upstream, base, true);
  /** @param {string} file */
  const isCommentOnly = file => commentOnly(git(['diff', '-U0', '--no-color', changes.base, '--', file]));
  /** @param {string} path */
  const exists = path => existsSync(join(root, path));
  return lanesOf(config)
    .filter(lane => planLane(lane, changes.files, exists, isCommentOnly).targets.length > 0)
    .map(lane => lane.name);
}

/** The GITHUB_OUTPUT lines for `names`. @param {readonly string[]} names */
export function outputs(names) {
  return `matrix=${JSON.stringify({ include: names.map(lane => ({ lane })) })}\nany=${names.length > 0}\n`;
}

/**
 * The command line's exit code: 0 with the outputs on stdout, 2 on a bad
 * argument or a plan that cannot be made.
 * @param {readonly string[]} argv
 * @param {{ root?: string, git?: (args: string[]) => string, stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown } }} [options]
 */
export function main(argv, { root = process.cwd(), git, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length !== 2 || argv[0] !== '--base' || !argv[1]) {
    stderr.write('usage: mutation-lanes.mjs --base <ref>\n');
    return 2;
  }
  let names;
  try {
    names = lanesToJudge(root, argv[1], git);
  } catch (error) {
    // fail-open: the error is printed and the run exits 2, which fails the plan job and so the gate.
    stderr.write(`mutation-lanes: ${/** @type {Error} */ (error).message}\n`);
    return 2;
  }
  stderr.write(names.length > 0 ? `mutation-lanes: lanes to judge: ${names.join(', ')}\n` : 'mutation-lanes: no lane has a file to judge\n');
  stdout.write(outputs(names));
  return 0;
}

/**
 * The exit code of `node <argv[1]> …` when `argv[1]` is the module at `url`,
 * or undefined when it is not (the module was imported). A suite calls it
 * in-process, so a mutant that would run main on import, or never, dies there.
 * @param {readonly string[]} argv
 * @param {string} url
 * @param {Parameters<typeof main>[1]} [options]
 */
export function entry(argv, url, options) {
  return argv[1] && url === pathToFileURL(argv[1]).href ? main(argv.slice(2), options) : undefined;
}

// Imported, entry gives undefined, and the importer's exit code stands.
process.exitCode = entry(process.argv, import.meta.url) ?? process.exitCode;
