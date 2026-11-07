import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';

import rule from './no-regex-structured-parse.js';

/**
 * VAL-11 (code part) `no-regex-structured-parse`. The first
 * invalid case is the catalogue example (the code a reviewer reported, reduced to
 * the smallest shape that still reproduces it), followed by the corrected code
 * and near-misses that must stay valid.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

// ---------------------------------------------------------------------------
// VAL-11: frontmatter taken apart by regex (`related: [a, b]` read as one string).

ruleTester.run('no-regex-structured-parse', rule as never, {
  valid: [
    // The fix: a YAML parser, then a schema.
    {
      code: "import { load } from 'js-yaml'; const doc = Schema.parse(load(block));",
    },
    {
      code: 'const url = new URL(text); const page = url.searchParams.get("page");',
    },
    { code: 'const body = JSON.stringify({ name, count });' },
    // Near-miss: a justified markup regex.
    {
      code: `
        // regex-parse-ok: one fixed attribute in our own generated SVG
        const id = /<svg[^>]*id="([^"]*)"/.exec(svg);`,
    },
    // Near-miss: anchored validation, lazy marker span, scheme check without
    // capture, a plain `key: value` template that is not JSON.
    { code: 'const ok = /^[a-z0-9-]+$/.test(slug);' },
    // Near-miss: a bound bare class never `.test`ed (split, replace,
    // exec), an anchored bound one, and one the binding never reads.
    {
      code: "const word = /[a-z]+/; const parts = text.split(word); word.exec(a); word['test'](b); word.lastIndex;",
    },
    { code: 'const word = /^[a-z]+$/; const ok = word.test(text);' },
    { code: 'const word = /[a-z]+/;' },
    { code: 'const { source } = /[a-z]+/;' },
    {
      code: 'const block = /<!-- BEGIN -->([\\s\\S]*?)<!-- END -->/.exec(text);',
    },
    { code: 'const secure = /^https:\\/\\//.test(url);' },
    { code: 'const line = `${key}: ${value}`;' },
    { code: 'const sql = sql`SELECT {"a": ${x}}`;' },
    { code: 'const label = `{${count}}`;' },
    // Near-misses from the legacy sweep: a shell assignment is not markup,
    // a yes/no path check takes nothing apart, an error message is not JSON.
    {
      code: 'const wired = /^\\s*REVIEW_RUN="\\$SCRIPT_DIR\\/x"\\s*$/.test(line);',
    },
    {
      code: 'const ok = /\\/git\\/(blobs|trees)\\/[a-f0-9]{40}(?:\\?recursive=1)?$/.test(path);',
    },
    {
      code: 'throw new Error(`[${table}] column "${column}": expected ${expected}`);',
    },
    // Near-miss: the reason marker on the flagged line itself.
    {
      code: 'const id = /id="([^"]*)"/.exec(svg); // regex-parse-ok: our own SVG',
    },
    // Near-miss: a string argument of a call that is not RegExp.
    { code: "const parts = text.split('^---');" },
    // Near-miss: `=` without a query separator, a separator without `=`, a
    // greedy span without a comment marker.
    { code: 'const pair = /(\\w+)=(\\d+)/.exec(line);' },
    { code: 'const key = /[?&](\\w+)/.exec(search);' },
    { code: 'const middle = /a(.*)b/.exec(text);' },
    // Near-miss: a tagged template owns its own escaping, and text before
    // the first interpolation means the template is not a JSON document.
    { code: 'const body = json`{"a": ${x}}`;' },
    { code: 'const line = `${prefix}{"k": 1}`;' },
    // Near-miss: a regex that is a `with` object, not a member's object.
    {
      code: 'with (/[a-z]+/) { use(lastIndex); }',
      languageOptions: { parserOptions: { sourceType: 'script' } },
    },
  ],
  invalid: [
    {
      code: "const re = RegExp('^---\\\\n');",
      errors: [{ messageId: 'yaml' }],
    },
    // A marker two lines up does not justify this line.
    {
      code: `
        // regex-parse-ok: one fixed attribute in our own generated SVG
        const unrelated = 1;
        const id = /id="([^"]*)"/.exec(svg);`,
      errors: [{ messageId: 'markup' }],
    },
    // The catalogue example: frontmatter fence and key lines taken apart by regex.
    {
      code: `
        const match = content.match(/^---\\n([\\s\\S]*?)\\n---/);
        const kvMatch = line.match(/^(\\w[\\w_]*):\\s*(.*)/);
        const nested = line.match(/^\\s{2,}(\\w[\\w_]*):\\s*(.*)/);`,
      errors: [
        { messageId: 'yaml' },
        { messageId: 'yaml' },
        { messageId: 'yaml' },
      ],
    },
    {
      code: 'const re = new RegExp("^---\\\\n");',
      errors: [{ messageId: 'yaml' }],
    },
    {
      code: 'const href = /<a\\s+[^>]*href="([^"]*)"/.exec(html);',
      errors: [{ messageId: 'markup' }],
    },
    {
      code: 'const attrs = text.matchAll(/(\\w+)="([^"]*)"/g);',
      errors: [{ messageId: 'markup' }],
    },
    {
      code: `
        // regex-parse-ok:
        const id = /id=["']([^"']*)["']/.exec(xml);`,
      errors: [{ messageId: 'markup' }],
    },
    {
      code: 'const page = /[?&]page=(\\d+)/.exec(location.search);',
      errors: [{ messageId: 'url' }],
    },
    {
      code: 'const host = /^https?:\\/\\/([^/]+)/.exec(url);',
      errors: [{ messageId: 'url' }],
    },
    {
      code: 'const block = /<!-- BEGIN -->([\\s\\S]*)<!-- END -->/.exec(text);',
      errors: [{ messageId: 'marker' }],
    },
    {
      code: 'const ok = /[a-z0-9-]+/.test(slug);',
      errors: [{ messageId: 'unanchored' }],
    },
    // The same regex bound to a name, then `.test`ed.
    {
      code: 'const word = /[a-z]+/; if (word.test(text)) use(text);',
      errors: [{ messageId: 'unanchored' }],
    },
    {
      code: "const word = new RegExp('[a-z]+'); const ok = word.exec(a) || word.test(b);",
      errors: [{ messageId: 'unanchored' }],
    },
    {
      code: 'const body = `{"name": "${name}", "count": ${count}}`;',
      errors: [{ messageId: 'jsonTemplate' }],
    },
    {
      code: 'const body = `[{"id": ${id}}]`;',
      errors: [{ messageId: 'jsonTemplate' }],
    },
  ],
});

interface RuleMeta {
  meta: {
    type: string;
    docs: { description: string };
    messages: Record<string, string>;
  };
}

/** The remedy each message names; the message ids are the complete set. */
const MESSAGES: Record<string, string> = {
  yaml: 'js-yaml',
  markup: 'regex-parse-ok',
  url: 'new URL(text)',
  marker: '[\\s\\S]*?',
  unanchored: '^[...]+$',
  jsonTemplate: 'JSON.stringify',
};

describe('no-regex-structured-parse meta', () => {
  const { meta } = rule as RuleMeta;

  it('is a problem rule whose texts name the fix', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(meta.docs.description.includes('with a parser'));
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [id, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[id]?.includes(remedy), id);
    }
  });
});
