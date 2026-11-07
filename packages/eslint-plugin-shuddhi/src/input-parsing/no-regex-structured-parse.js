/**
 * VAL-11 (code part) `no-regex-structured-parse`. Replaces the
 * banned construct with: js-yaml, new URL, JSON.stringify.
 * Registered by ./index.js.
 */

import { isIdentifier, readsOf } from './helpers.js';

/** `^---`: a YAML frontmatter fence. */
const FRONTMATTER = /\^-{3}/;
/** `^(\w+):`, `^\s{2,}([\w-]+)\s*:` — a YAML key line taken apart by regex. */
const YAML_KEY_LINE =
  /^\^(?:\\s(?:[*+]|\{\d*,?\d*\}))?\((?:\?<\w+>)?(?:\\w|\[\\w)[^)]*\)(?:\\s[*+])?:/;
/**
 * `href="…"`, `(\w+)="…"`, `id=["']` — an attribute value taken apart by
 * regex. The name before `=` must read as an attribute (lowercase, or a
 * captured/classed name): `REVIEW_RUN="..."` is a shell assignment, not markup.
 */
const MARKUP_ATTRIBUTE =
  /(?:\b[a-z][a-z-]*|\\w[+*]|\)|\][+*])=(?:\\?["']|\[(?:\\?["'])+\])/;
/** `<tag\s` / `<tag[^>]` — a tag taken apart by regex. */
const MARKUP_TAG = /<\/?[A-Za-z][\w-]*(?:\\s|\[\^>\])/;
/** A capturing group (not `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`). */
const CAPTURE = /(?:^|[^\\])\((?!\?)|\(\?<\w+>/;
/** A URL scheme or a query-string separator in a pattern. */
const URL_SCHEME = /https\\?\??:|https\?:/;
const QUERY_PART = /\[\?&\]|\[&\?\]|\\\?/;
/** An HTML-comment marker spanned greedily. */
const GREEDY_SPAN = /\[\\s\\S\]\*(?!\?)|\[\\S\\s\]\*(?!\?)|\.\*(?!\?)/;
/** A bare character class with a quantifier: validates nothing unanchored. */
const BARE_CLASS = /^\[[^\]]+\](?:[+*]|\{\d+,?\d*\})$/;

/** The reason marker that allows a reviewed markup regex. */
const REGEX_PARSE_OK = /regex-parse-ok:\s*\S/;

function regexPattern(node) {
  if (node.type === 'Literal' && node.regex) return node.regex.pattern;
  if (
    (node.type === 'NewExpression' || node.type === 'CallExpression') &&
    isIdentifier(node.callee, 'RegExp') &&
    node.arguments[0]?.type === 'Literal' &&
    typeof node.arguments[0].value === 'string'
  ) {
    return node.arguments[0].value;
  }
  return null;
}

const noRegexStructuredParse = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Parse YAML, markup, URLs and JSON with a parser, not a regex or a template',
    },
    schema: [],
    messages: {
      yaml: 'This regex takes YAML apart by hand: inline arrays, quoting, multi-line values and comments all mis-parse (`related: [a, b]` once read as one string). Use `js-yaml` (`load`) and validate the result with a schema.',
      markup:
        'This regex takes markup apart by hand: attribute order, quoting and nesting defeat it. Use a parser, or justify it with a `// regex-parse-ok: <reason>` comment on the line above.',
      url: 'This regex takes a URL apart by hand: encoding, ports, fragments and parameter order defeat it. Use `new URL(text)` and `url.searchParams`.',
      marker:
        'A greedy span between comment markers swallows everything up to the LAST end marker when a document holds two blocks. Use a lazy span (`[\\s\\S]*?`) anchored to its own line.',
      unanchored:
        'This bare character class is not anchored, so `.test()` passes any text containing one matching character. Anchor it (`^[...]+$`).',
      jsonTemplate:
        'JSON built from a template literal breaks on any quote, backslash or newline in an interpolated value. Build the object and `JSON.stringify` it.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    const justified = node => {
      const line = node.loc.start.line;
      return sourceCode
        .getAllComments()
        .some(
          comment =>
            (comment.loc.end.line === line - 1 ||
              comment.loc.start.line === line) &&
            REGEX_PARSE_OK.test(comment.value),
        );
    };

    /** Is `node` the receiver of a `.test(…)` call? */
    const isTested = node =>
      node.parent.type === 'MemberExpression' &&
      node.parent.object === node &&
      !node.parent.computed &&
      node.parent.property.name === 'test';

    /**
     * A regex bound to a name (`const word = /[a-z]+/`) and `.test`ed through
     * it: the binding's reads stand in for the literal.
     */
    const testedThroughBinding = node => {
      // A regex is never a declarator's id, so here it is the initialiser.
      const parent = node.parent;
      if (parent.type !== 'VariableDeclarator') return false;
      return context.sourceCode
        .getDeclaredVariables(parent)
        .some(variable =>
          readsOf(variable).some(reference => isTested(reference.identifier)),
        );
    };

    const judgePattern = (node, pattern) => {
      // `/re/.test(x)` answers yes/no; it cannot take anything apart.
      const testOnly = isTested(node);
      if (FRONTMATTER.test(pattern) || YAML_KEY_LINE.test(pattern)) {
        context.report({ node, messageId: 'yaml' });
        return;
      }
      if (MARKUP_ATTRIBUTE.test(pattern) || MARKUP_TAG.test(pattern)) {
        if (!justified(node)) context.report({ node, messageId: 'markup' });
        return;
      }
      if (
        !testOnly &&
        CAPTURE.test(pattern) &&
        (URL_SCHEME.test(pattern) ||
          (QUERY_PART.test(pattern) && pattern.includes('=')))
      ) {
        context.report({ node, messageId: 'url' });
        return;
      }
      if (pattern.includes('<!--') && GREEDY_SPAN.test(pattern)) {
        context.report({ node, messageId: 'marker' });
        return;
      }
      if (
        (testOnly || testedThroughBinding(node)) &&
        BARE_CLASS.test(pattern)
      ) {
        context.report({ node, messageId: 'unanchored' });
      }
    };

    return {
      Literal(node) {
        const pattern = regexPattern(node);
        if (pattern !== null) judgePattern(node, pattern);
      },
      'NewExpression, CallExpression'(node) {
        const pattern = regexPattern(node);
        if (pattern !== null) judgePattern(node, pattern);
      },
      TemplateLiteral(node) {
        if (node.parent.type === 'TaggedTemplateExpression') return;
        if (node.expressions.length === 0) return;
        // A JSON document: opens AND closes as an object or array, with a
        // quoted key. An error message that merely starts with `[table]` and
        // quotes a column name is not one.
        // `cooked` is null only in a tagged template, returned above.
        const text = node.quasis.map(quasi => quasi.value.cooked).join('0');
        if (
          /^\s*[[{][\s\S]*[\]}]\s*$/.test(text) &&
          /"[^"\n]*"\s*:/.test(text)
        ) {
          context.report({ node, messageId: 'jsonTemplate' });
        }
      },
    };
  },
};

export default noRegexStructuredParse;
