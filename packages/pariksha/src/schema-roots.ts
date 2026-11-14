// schema-roots: no tool or output schema with a combinator at its root.
//
// The Anthropic API refuses a tool's `input_schema`, or a structured output's
// schema, whose root holds `allOf`, `anyOf` or `oneOf` (a 400, "input_schema
// does not support oneOf, allOf, or anyOf at the top level"). The request
// fails before the model's first tool call, so an agent built on that schema
// dies at its start, every time, with nothing wrong in its own code. This
// reads JSON documents and refuses each such schema it finds:
//
// - the value under `input_schema`, `inputSchema`, `output_schema`,
//   `outputSchema` or `json_schema`, and the `schema` inside a `json_schema`;
// - the `schema` of an object whose `type` is `json_schema` (a structured
//   output format: `{ "type": "json_schema", "schema": {…} }`);
// - the root of a file named `*.schema.json`.
//
// A schema found is not read further: a combinator below its root is allowed,
// and a property inside it that happens to be called `input_schema` is a
// property, not a tool.
import { basename } from 'node:path';

export const COMBINATORS = ['allOf', 'anyOf', 'oneOf'] as const;
export type Combinator = (typeof COMBINATORS)[number];

/** The keys whose value is a tool's or an output's schema. */
export const SCHEMA_KEYS: readonly string[] = ['input_schema', 'inputSchema', 'output_schema', 'outputSchema', 'json_schema'];

export interface RootCombinator {
  readonly file: string;
  /** Where the schema is in the document: `$`, `$.tools[0].input_schema`. */
  readonly path: string;
  readonly keyword: Combinator;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `path` one step further: `[0]`, `.name`, or `["a key"]` for a key that is no identifier. */
const step = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

/** Each tool or output schema in `document`, the JSON of `file`, whose root holds a combinator. */
export const findRootCombinators = (file: string, document: unknown): RootCombinator[] => {
  const found: RootCombinator[] = [];
  const atRoot = (schema: unknown, path: string): void => {
    if (!isRecord(schema)) return;
    for (const keyword of COMBINATORS) if (Object.hasOwn(schema, keyword)) found.push({ file, path, keyword });
  };
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, step(path, i)));
      return;
    }
    if (!isRecord(value)) return;
    const format = value['type'] === 'json_schema' && isRecord(value['schema']);
    for (const [key, child] of Object.entries(value)) {
      const at = step(path, key);
      if (format && key === 'schema') atRoot(child, at);
      else if (SCHEMA_KEYS.includes(key)) {
        atRoot(child, at);
        if (key === 'json_schema' && isRecord(child)) atRoot(child['schema'], step(at, 'schema'));
      } else walk(child, at);
    }
  };
  if (basename(file).endsWith('.schema.json')) atRoot(document, '$');
  else walk(document, '$');
  return found;
};

/** The refusal of one schema, one line. */
export const rootMessage = (found: RootCombinator): string =>
  `pariksha schema-roots: ${found.file}: ${found.path}: top-level ${found.keyword}. ` +
  'The API rejects tool and output schemas with oneOf, allOf or anyOf at the root; express the condition in code after the call returns.';

/** The JSON files among `paths`: the ones this check reads. */
export const jsonFiles = (paths: readonly string[]): string[] => paths.filter((p) => /\.json$/i.test(p));

/** A file's text as JSON, a leading byte-order mark dropped; throws `not JSON: …`. */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text) as unknown;
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
};

/** Each of `files`, read by `read` and parsed; throws on the first that cannot be, naming it. */
export const readDocuments = (files: readonly string[], read: (file: string) => string): Array<{ file: string; json: unknown }> =>
  files.map((file) => {
    try {
      return { file, json: parseJson(read(file)) };
    } catch (e) {
      throw new Error(`${file}: ${(e as Error).message}`);
    }
  });

/** The verdict on `documents`, each a file's path and its parsed JSON. */
export const checkSchemaRoots = (documents: ReadonlyArray<{ readonly file: string; readonly json: unknown }>): { ok: boolean; out: string[]; err: string[] } => {
  const found = documents.flatMap((d) => findRootCombinators(d.file, d.json));
  if (found.length > 0) return { ok: false, out: [], err: found.map(rootMessage) };
  return { ok: true, out: [`pariksha schema-roots: ${documents.length} JSON file(s), no tool or output schema with oneOf, allOf or anyOf at its root`], err: [] };
};
