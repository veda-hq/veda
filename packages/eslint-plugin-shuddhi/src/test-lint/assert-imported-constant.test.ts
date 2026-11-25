import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { sourceName, subjectNames } from './assert-imported-constant.js';
import plugin, { rules } from './index.js';

/**
 * The cases for `assert-imported-constant.js`, the module this suite owns.
 *
 * Each `invalid` case is the lesson's shape, reduced: an expected value, a
 * CONSTANT_CASE binding imported from the module under test, which a mutant
 * of that constant moves along with it. Each `valid` case is the corrected code (the literal, typed
 * in the test) or a near miss. The `guard removal` block puts the import back
 * in place of the literal and proves the rule fires again.
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

const TEST_FILE = 'src/widget.test.ts';
const SUBJECT = `import { MAX, MAX_RETRIES, MIN, PREFIX, DEFAULTS, LIST, V2, WidgetError } from './widget.js';\n`;

const imported = (name: string) => ({ messageId: 'imported', data: { name } });

ruleTester.run('assert-imported-constant', rules['assert-imported-constant']!, {
  valid: [
    // Corrected: the literal typed in the test; the constant pinned as the subject.
    {
      filename: TEST_FILE,
      code: `${SUBJECT}expect(retries()).toBe(3);
      expect(MAX_RETRIES).toBe(3);
      expect(clamp(MAX + 1)).toBe(10);`,
    },
    // Not read: an import that is not named in CONSTANT_CASE (a function, an
    // object or a fake compared by identity), a member of an import (an enum),
    // and a constant inside a template literal.
    {
      filename: TEST_FILE,
      code: `import { spawnRunner, defaultConfig, Status, Max, MAX_, _MAX, A__B } from './widget.js';
      import * as widget from './widget.js';
      ${SUBJECT}expect(deps().run).toBe(spawnRunner);
      expect(config()).toEqual(defaultConfig);
      expect(order().status).toBe(Status.PAID);
      expect(a).toBe(widget.MAX);
      expect(b).toEqual({ limits: widget.limits.min });
      expect(c).toBe(Max); expect(d).toBe(MAX_); expect(e).toBe(_MAX); expect(f).toBe(A__B);
      expect(error.message).toBe(\`\${PREFIX} is not a widget\`);
      expect(g).toBe(WidgetError);`,
    },
    // The same names from another module, a package, or a local.
    {
      filename: TEST_FILE,
      code: `import { MAX } from './other.js';
      import { MIN } from 'widget';
      import { PREFIX } from '@acme/widget';
      const LIMIT = 3;
      function check(expected: number) { expect(size()).toBe(expected); }
      expect(a).toBe(MAX); expect(b).toBe(MIN); expect(c).toBe(PREFIX); expect(d).toBe(LIMIT);`,
    },
    // Type-only imports, either form.
    {
      filename: TEST_FILE,
      code: `import type { SHAPE } from './widget.js';
      import { type KIND } from './widget.js';
      expect(a).toEqual(SHAPE); expect(b).toEqual(KIND);`,
    },
    // Matchers that take a class or an error.
    {
      filename: TEST_FILE,
      code: `${SUBJECT}expect(() => run()).toThrow(WidgetError);
      expect(error).toBeInstanceOf(WidgetError);
      expect(() => run()).toThrowError(PREFIX);`,
    },
    // A call that is not an asymmetric matcher, a tagged template, and a
    // matcher with no argument are not descended into.
    {
      filename: TEST_FILE,
      code: `${SUBJECT}expect(a).toBe(compute(MAX));
      expect(b).toBe(tag\`\${PREFIX}\`);
      expect(c).toBeDefined();
      expect(d).toEqual({ run() { return MAX; } });`,
    },
    // A file that is not a test, and an expect that is not the runner's.
    {
      filename: 'src/widget.ts',
      code: `${SUBJECT}expect(a).toBe(MAX);`,
    },
    {
      filename: TEST_FILE,
      code: `${SUBJECT}const expect = (value: unknown) => ({ toBe: (_: unknown) => value });
      expect(a).toBe(MAX);`,
    },
    // The module under test is named by the test file: './widgets.js' is not it.
    {
      filename: TEST_FILE,
      code: `import { MAX } from './widgets.js';
      import { MIN } from '.';
      expect(a).toBe(MAX); expect(b).toBe(MIN);`,
    },
  ],
  invalid: [
    // The lesson: the expected count is the subject's own constant.
    {
      filename: TEST_FILE,
      code: `${SUBJECT}expect(retries()).toBe(MAX_RETRIES);`,
      errors: [imported('MAX_RETRIES')],
    },
    // A default import, from a sibling path; negated, resolved and soft.
    {
      filename: TEST_FILE,
      code: `import LIMITS from './widget';
      import { V2 } from '../src/widget.ts';
      expect(a).not.toBe(LIMITS);
      await expect(load()).resolves.toEqual(V2);
      expect.soft(b).toBe(LIMITS);`,
      errors: [imported('LIMITS'), imported('V2'), imported('LIMITS')],
    },
    // Object values, spreads, array elements past a hole, behind casts.
    {
      filename: TEST_FILE,
      code: `${SUBJECT}expect(config).toEqual({ max: MAX as number, ...DEFAULTS, range: [, MIN!, ...LIST] });`,
      errors: [imported('MAX'), imported('DEFAULTS'), imported('MIN'), imported('LIST')],
    },
    // The arguments of asymmetric matchers, negated or nested.
    {
      filename: TEST_FILE,
      code: `${SUBJECT}expect(s).toEqual(expect.stringContaining(PREFIX));
      expect(s).toEqual(expect.not.stringContaining(PREFIX));
      expect(o).toEqual(expect.objectContaining({ max: expect.any(Number), min: MIN }));`,
      errors: [imported('PREFIX'), imported('PREFIX'), imported('MIN')],
    },
    // An integration test, and the subject as a folder's index.
    {
      filename: 'src/widget.integration.test.ts',
      code: `${SUBJECT}expect(a).toBe(MAX);`,
      errors: [imported('MAX')],
    },
    {
      filename: TEST_FILE,
      code: `import { MAX } from './widget/index.js';
      expect(a).toBe(MAX);`,
      errors: [imported('MAX')],
    },
  ],
});

// ---------------------------------------------------------------------------
// The module under test, from the test file's path and an import's source
// ---------------------------------------------------------------------------

describe('subjectNames', () => {
  it('strips .test or .spec and the extension, and one more suffix', () => {
    assert.deepEqual(subjectNames('src/widget.test.ts'), new Set(['widget']));
    assert.deepEqual(subjectNames('widget.spec.tsx'), new Set(['widget']));
    assert.deepEqual(subjectNames('lib/widget.test.mjs'), new Set(['widget']));
    assert.deepEqual(
      subjectNames('src/widget.integration.test.ts'),
      new Set(['widget.integration', 'widget']),
    );
    assert.deepEqual(subjectNames('C:\\repo\\src\\widget.test.cjs'), new Set(['widget']));
  });

  it('keeps a stem that starts with a dot whole', () => {
    assert.deepEqual(subjectNames('src/.widget.test.ts'), new Set(['.widget']));
  });

  it('names nothing for a file that is not a test', () => {
    assert.deepEqual(subjectNames('src/widget.test.tsv'), new Set());
    // The stem runs from the start of the name, and stops at a line break.
    assert.deepEqual(subjectNames('src/a\nwidget.test.ts'), new Set());
    assert.deepEqual(subjectNames('src/widget.ts'), new Set());
    assert.deepEqual(subjectNames('src/widget.test.md'), new Set());
    assert.deepEqual(subjectNames(''), new Set());
  });
});

describe('sourceName', () => {
  it('reads a relative source less its extension, or the folder of an index', () => {
    assert.equal(sourceName('./widget.js'), 'widget');
    assert.equal(sourceName('./widget'), 'widget');
    assert.equal(sourceName('../lib/widget.tsx'), 'widget');
    assert.equal(sourceName('./widget/index.js'), 'widget');
    assert.equal(sourceName('./widget/'), 'widget');
    assert.equal(sourceName('./widget.integration.ts'), 'widget.integration');
    assert.equal(sourceName('./widget.mjs'), 'widget');
    assert.equal(sourceName('./widget.cts'), 'widget');
  });

  it('strips only a script extension that ends the name', () => {
    assert.equal(sourceName('./widget.json'), 'widget.json');
    assert.equal(sourceName('./widget.js.map'), 'widget.js.map');
  });

  it('names nothing for a package, the folder itself or its index', () => {
    assert.equal(sourceName('widget'), null);
    assert.equal(sourceName('@acme/widget'), null);
    assert.equal(sourceName('.'), null);
    assert.equal(sourceName('..'), null);
    assert.equal(sourceName('./'), null);
    assert.equal(sourceName('./index.js'), null);
  });
});

// ---------------------------------------------------------------------------
// Deleting the guard from a corrected case brings the rule back
// ---------------------------------------------------------------------------

function messageIds(code: string): string[] {
  return new Linter({ configType: 'flat' })
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          plugins: { shuddhi: plugin },
          rules: { 'shuddhi/assert-imported-constant': 'error' },
        },
      ],
      TEST_FILE,
    )
    .map(message => message.messageId ?? message.message);
}

/** The names each finding reports, linting `code` as `filename`. */
function reported(
  code: string,
  filename: string,
  globals: Record<string, 'readonly'> = {},
): string[] {
  return new Linter({ configType: 'flat' })
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser, globals },
          plugins: { shuddhi: plugin },
          rules: { 'shuddhi/assert-imported-constant': 'error' },
        },
      ],
      filename,
    )
    .map(message => message.message.split('`')[1] ?? message.message);
}

describe('assert-imported-constant edges', () => {
  it('reads no matcher that takes a class or an error, and reads the rest', () => {
    const code = `import { MAX, PREFIX } from './widget.js';
      expect(f).toBeInstanceOf(MAX);
      expect(f).toThrow(PREFIX);
      expect(f).toThrowErrorMatchingSnapshot(PREFIX);
      expect(f).toThrowErrorMatchingInlineSnapshot(PREFIX);
      expect(f).toEqual(MAX);`;
    assert.deepEqual(reported(code, 'src/widget.test.ts'), ['MAX']);
  });

  it('leaves a constant with no import alone: a declared global or none at all', () => {
    const code = `expect(a).toBe(UNDECLARED); expect(b).toBe(MAX_GLOBAL);`;
    assert.deepEqual(
      reported(code, 'src/widget.test.ts', { MAX_GLOBAL: 'readonly' }),
      [],
    );
  });

  it('reads only matchers on expect itself, or on expect.not', () => {
    const code = `import { MAX, MIN } from './widget.js';
      expect(a).toEqual(other.stringContaining(MAX));
      expect(b).toEqual(expect.foo.stringContaining(MAX));
      expect(c).toEqual(make().stringContaining(MAX));
      expect(d).toEqual(expect.not.arrayContaining([MIN]));`;
    assert.deepEqual(reported(code, 'src/widget.test.ts'), ['MIN']);
  });

  it('names no subject outside a test file, whatever it imports', () => {
    const code = `import { MAX } from './widget.js'; expect(a).toBe(MAX);`;
    assert.deepEqual(reported(code, 'src/widget.ts'), []);
    assert.deepEqual(reported(code, 'src/widget.test.ts'), ['MAX']);
  });
});

describe('guard removal flips each corrected case', () => {
  it('assert-imported-constant/imported', () => {
    const corrected = `${SUBJECT}expect(retries()).toBe(3);`;
    assert.deepEqual(messageIds(corrected), []);
    const broken = corrected.replace('toBe(3)', 'toBe(MAX_RETRIES)');
    assert.notEqual(broken, corrected);
    assert.deepEqual(messageIds(broken), ['imported']);
  });
});

describe('assert-imported-constant rule metadata', () => {
  it('states the rule and its message verbatim', () => {
    assert.deepEqual(rules['assert-imported-constant']?.meta, {
      type: 'suggestion',
      docs: {
        description:
          'An expected value is typed in the test, not imported from the module under test',
      },
      schema: [],
      messages: {
        imported:
          '`{{name}}` comes from the module under test, so this assertion moves with any change to it: a mutant of the constant passes, and kills nothing. Assert the literal value, typed in the test.',
      },
    });
  });
});
