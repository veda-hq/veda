import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSchemaRoots, findRootCombinators, jsonFiles, parseJson, readDocuments, rootMessage } from './schema-roots.ts';

const OBJECT = { type: 'object', properties: { a: { type: 'string' } } };
const ONE_OF = { oneOf: [{ type: 'object' }, { type: 'string' }] };

/** The `path keyword` of each finding in `document`, read as the JSON of `file`. */
const found = (document: unknown, file = 'agent.json'): string[] => findRootCombinators(file, document).map((f) => `${f.path} ${f.keyword}`);

describe('findRootCombinators', () => {
  it('refuses a combinator at the root of a schema under each key', () => {
    for (const key of ['input_schema', 'inputSchema', 'output_schema', 'outputSchema', 'json_schema']) {
      assert.deepEqual(found({ [key]: ONE_OF }), [`$.${key} oneOf`], key);
      assert.deepEqual(found({ [key]: OBJECT }), [], key);
    }
  });

  it('names each of the three combinators, every one present', () => {
    assert.deepEqual(found({ input_schema: { allOf: [], anyOf: [], oneOf: [] } }), ['$.input_schema allOf', '$.input_schema anyOf', '$.input_schema oneOf']);
  });

  it('reads the schema inside a json_schema wrapper as well as the wrapper', () => {
    const wrapped = { response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: { anyOf: [] } } } };
    assert.deepEqual(found(wrapped), ['$.response_format.json_schema.schema anyOf']);
    assert.deepEqual(found({ json_schema: { name: 'verdict', schema: OBJECT } }), []);
  });

  it('reads the schema of a json_schema output format', () => {
    assert.deepEqual(found({ output_format: { type: 'json_schema', schema: { allOf: [] } } }), ['$.output_format.schema allOf']);
    assert.deepEqual(found({ outputFormat: { type: 'json_schema', schema: OBJECT } }), []);
    assert.deepEqual(found({ schema: { oneOf: [] } }), [], 'a schema key alone is not an output format');
    assert.deepEqual(found({ type: 'json_schema', schema: 'inline' }), [], 'a format whose schema is no object is walked like other objects');
  });

  it('finds every tool in an array, with its index in the path', () => {
    const request = { model: 'm', tools: [{ name: 'a', input_schema: OBJECT }, { name: 'b', input_schema: ONE_OF }], messages: [] };
    assert.deepEqual(found(request), ['$.tools[1].input_schema oneOf']);
    assert.deepEqual(found([{ inputSchema: ONE_OF }, { inputSchema: { anyOf: [] } }]), ['$[0].inputSchema oneOf', '$[1].inputSchema anyOf']);
  });

  it('quotes a key that is no identifier', () => {
    assert.deepEqual(found({ 'my tools': { 'tool-1': { input_schema: ONE_OF } } }), ['$["my tools"]["tool-1"].input_schema oneOf']);
  });

  it('allows a combinator below the root of a schema', () => {
    const nested = { type: 'object', properties: { verdict: { oneOf: [{ const: 'pass' }, { const: 'fail' }] } }, $defs: { x: { allOf: [] } } };
    assert.deepEqual(found({ input_schema: nested }), []);
  });

  it('does not read a schema further: a property named like a key is a property', () => {
    const tool = { input_schema: { type: 'object', properties: { input_schema: { anyOf: [{ type: 'object' }, { type: 'null' }] } } } };
    assert.deepEqual(found(tool), []);
  });

  it('skips a key whose value is no object, and plain values', () => {
    assert.deepEqual(found({ input_schema: 'see docs', outputSchema: null, json_schema: [ONE_OF] }), []);
    assert.deepEqual(found(null), []);
    assert.deepEqual(found('text'), []);
    assert.deepEqual(found({ oneOf: [] }), [], 'the root of a file not named *.schema.json is no schema');
  });

  it('reads the root of a *.schema.json file, and nothing below it', () => {
    assert.deepEqual(found(ONE_OF, 'schemas/verdict.schema.json'), ['$ oneOf']);
    assert.deepEqual(found({ type: 'object', properties: { input_schema: ONE_OF } }, 'verdict.schema.json'), []);
    assert.deepEqual(found([ONE_OF], 'list.schema.json'), []);
  });

  it('records the file in each finding', () => {
    assert.deepEqual(findRootCombinators('a/b.json', { input_schema: ONE_OF }), [{ file: 'a/b.json', path: '$.input_schema', keyword: 'oneOf' }]);
  });
});

describe('rootMessage', () => {
  it('names the file, the path and the keyword, then the fix', () => {
    assert.equal(
      rootMessage({ file: 'agent.json', path: '$.tools[0].input_schema', keyword: 'allOf' }),
      'pariksha schema-roots: agent.json: $.tools[0].input_schema: top-level allOf. The API rejects tool and output schemas with oneOf, allOf or anyOf at the root; express the condition in code after the call returns.',
    );
  });
});

describe('jsonFiles', () => {
  it('keeps .json paths, in any case, and drops the rest', () => {
    assert.deepEqual(jsonFiles(['a.json', 'B.JSON', 'c.yaml', 'd.json.bak', 'e.jsonc', 'x.schema.json']), ['a.json', 'B.JSON', 'x.schema.json']);
  });
});

describe('parseJson', () => {
  it('reads JSON, past a byte-order mark', () => {
    assert.deepEqual(parseJson('{"a": 1}'), { a: 1 });
    assert.deepEqual(parseJson('﻿[1]'), [1]);
  });

  it('refuses anything else', () => {
    assert.throws(() => parseJson('{ // a comment\n}'), /^Error: not JSON: /);
  });
});

describe('readDocuments', () => {
  it('parses each file, and throws on the first that fails, naming it', () => {
    const texts: Record<string, string> = { 'a.json': '{"a": 1}', 'b.json': 'nope' };
    const read = (file: string): string => {
      const text = texts[file];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    };
    assert.deepEqual(readDocuments(['a.json'], read), [{ file: 'a.json', json: { a: 1 } }]);
    assert.throws(() => readDocuments(['a.json', 'b.json', 'c.json'], read), /^Error: b\.json: not JSON: /);
    assert.throws(() => readDocuments(['c.json'], read), /^Error: c\.json: ENOENT$/);
  });
});

describe('checkSchemaRoots', () => {
  it('passes clean documents, counting them, and nothing at all', () => {
    assert.deepEqual(checkSchemaRoots([{ file: 'a.json', json: { input_schema: OBJECT } }]), {
      ok: true,
      out: ['pariksha schema-roots: 1 JSON file(s), no tool or output schema with oneOf, allOf or anyOf at its root'],
      err: [],
    });
    assert.equal(checkSchemaRoots([]).ok, true);
  });

  it('refuses each finding in each document, on stderr', () => {
    const result = checkSchemaRoots([
      { file: 'a.json', json: { input_schema: ONE_OF } },
      { file: 'b.schema.json', json: { anyOf: [] } },
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.out, []);
    assert.deepEqual(
      result.err.map((line) => line.split(': top-level')[0]),
      ['pariksha schema-roots: a.json: $.input_schema', 'pariksha schema-roots: b.schema.json: $'],
    );
  });
});
