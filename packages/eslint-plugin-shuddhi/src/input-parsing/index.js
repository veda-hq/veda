/**
 * Input and scalar parsing rules.
 *
 * Each rule closes a defect class from a catalogue of review findings and
 * points at the kind of helper that replaces the banned construct. Where a
 * project has its own helper, the rule's `hints` option names it in the
 * message (and strict-scalar-parse's `pageReaders` option names its page
 * readers):
 *
 *   no-hand-rolled-argv      VAL-08 (TS part)   a declared argv parser
 *   env-through-schema       VAL-06 (+ EDGE-03's process.env clause)
 *                                               a typed env schema
 *   strict-scalar-parse      VAL-05 = EDGE-03   strict number/date parsers,
 *                                               one page-parameter reader
 *   schema-parse-untrusted   VAL-09             zod schemas
 *   schema-satisfies-contract VAL-09 (`satisfies z.ZodType<Producer>`)
 *   prisma-json-through-schema VAL-09 (Prisma Json columns; typed only)
 *   no-regex-structured-parse VAL-11 (code part) js-yaml, new URL, JSON.stringify
 *
 * One module per rule in this folder, each with its colocated suite; readers
 * two or more rules share live in ./helpers.js. This entry registers the
 * rules; ./configs.js builds the config blocks a workspace imports.
 *
 * TYPE INFORMATION. Rules use types when the workspace provides them and
 * fall back to syntax elsewhere. Each rule's comment says what the syntactic
 * fallback does not claim.
 *
 * Legacy hits belong in the workspace's eslint-suppressions.json; the counts
 * there may only fall (ESLint fails on an unused suppression).
 */

import noHandRolledArgv from './no-hand-rolled-argv.js';
import envThroughSchema from './env-through-schema.js';
import strictScalarParse from './strict-scalar-parse.js';
import schemaParseUntrusted from './schema-parse-untrusted.js';
import schemaSatisfiesContract from './schema-satisfies-contract.js';
import prismaJsonThroughSchema from './prisma-json-through-schema.js';
import noRegexStructuredParse from './no-regex-structured-parse.js';

export const rules = {
  'no-hand-rolled-argv': noHandRolledArgv,
  'env-through-schema': envThroughSchema,
  'strict-scalar-parse': strictScalarParse,
  'schema-parse-untrusted': schemaParseUntrusted,
  'schema-satisfies-contract': schemaSatisfiesContract,
  'prisma-json-through-schema': prismaJsonThroughSchema,
  'no-regex-structured-parse': noRegexStructuredParse,
};

const plugin = { rules };
export default plugin;

export {
  TEST_FILE_GLOBS,
  inputParsingRules,
  inputParsingConfigs,
} from './configs.js';
