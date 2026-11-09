// The rules `dvara records` runs: the one list a new rule joins.
import type { RecordsConfig } from "../config.ts";
import { durablePaths } from "./paths.ts";
import type { Rule } from "./types.ts";

/**
 * The rule set for these settings. EVIDENCE-01 (full commit ids where
 * `identityPaths` match, resolved in this repository) is not shipped yet; it
 * joins this list as one more `Rule`, reading `records.identityPaths`,
 * `records.repository` and the tree's `typesOf` and `baseText`.
 */
export const rulesFor = (records: RecordsConfig): Rule[] => [
  durablePaths(records),
];
