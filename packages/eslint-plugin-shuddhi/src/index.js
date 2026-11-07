/**
 * @veda-hq/eslint-plugin-shuddhi: every rule, under one plugin.
 *
 * Each family is also importable on its own (`./error-handling`,
 * `./input-parsing`, `./server-boundary`, `./test-lint`), with config-block
 * helpers that bind the family under any namespace. Rule names are unique
 * across families, so one plugin can carry them all.
 */

import { readFileSync } from 'node:fs';

import { rules as errorHandling } from './error-handling/index.js';
import { rules as inputParsing } from './input-parsing/index.js';
import { rules as nestPrisma } from './nest-prisma/index.js';
import { rules as serverBoundary } from './server-boundary/index.js';
import { rules as testLint } from './test-lint/index.js';

const { name, version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

/** The families, by name, each a map of rule name to rule. */
export const families = {
  'error-handling': errorHandling,
  'input-parsing': inputParsing,
  'nest-prisma': nestPrisma,
  'server-boundary': serverBoundary,
  'test-lint': testLint,
};

/**
 * Every rule of every family. A rule name two families shared would make one
 * silently shadow the other, so that is refused at load.
 */
function mergeFamilies(all) {
  const merged = {};
  for (const [family, rules] of Object.entries(all)) {
    for (const [rule, implementation] of Object.entries(rules)) {
      if (Object.hasOwn(merged, rule)) {
        throw new Error(`shuddhi: rule ${rule} is defined twice (again in ${family})`);
      }
      merged[rule] = implementation;
    }
  }
  return merged;
}

export const rules = mergeFamilies(families);

export { mergeFamilies };

const plugin = { meta: { name, version }, rules };

export default plugin;
