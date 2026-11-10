// The rules `dvara records` runs: the one list a new rule joins.
import type { RecordsConfig } from "../config.ts";
import { commitIdentity } from "./identity.ts";
import { durablePaths } from "./paths.ts";
import type { Rule } from "./types.ts";

/**
 * The rule set for these settings: EVIDENCE-02 everywhere text is read, and
 * EVIDENCE-01 where `records.identityPaths` match (none by default).
 */
export const rulesFor = (records: RecordsConfig): Rule[] => [
  durablePaths(records),
  commitIdentity(records),
];
