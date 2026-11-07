import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Linter } from 'eslint';

import rule from './no-self-mock-sut.js';

/**
 * Drift check between the `no-self-mock-sut` rule and a second, independent
 * derivation of a suite's subject from the same qualifier list.
 *
 * A repository whose mutation gate strips qualifiers to find a suite's subject
 * passes the rule the gate's own list; the two builders must then agree on
 * every suite. `subjectOf` below is the gate's derivation written as segment
 * comparison (no RegExp), so a builder that strips differently — anchors,
 * joins or escapes the list wrongly — disagrees with it on some suite.
 *
 * It lints through `Linter` rather than `RuleTester`: one linter for the whole
 * corpus, no test registration inside a running test, and a plain answer per
 * suite (reported or not) instead of an exception to interpret.
 */

interface SuiteQualifiers {
  stateMatrix: string;
  stateMatrixArea: string;
  qualifiers: string[];
  notQualifiers: string[];
}

const suiteQualifiers = JSON.parse(
  readFileSync(new URL('./fixtures/suite-qualifiers.json', import.meta.url), 'utf8'),
) as SuiteQualifiers;

const RULE_ID = 'shuddhi/no-self-mock-sut';
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const linter = new Linter({ cwd: packageRoot });
const config: Linter.Config[] = [
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    plugins: { shuddhi: { rules: { 'no-self-mock-sut': rule } } as never },
    rules: { [RULE_ID]: ['error', suiteQualifiers] as never },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
];

/** The subject a gate derives: drop `.test.ts(x)`, then one qualifier. */
function subjectOf(suite: string): string {
  const segments = basename(suite).replace(/\.test\.tsx?$/, '').split('.');
  const last = segments.at(-1) ?? '';
  const area = new RegExp(`^(?:${suiteQualifiers.stateMatrixArea})$`);
  if (segments.length > 1 && suiteQualifiers.qualifiers.includes(last)) {
    segments.pop();
  } else if (segments.length > 1 && last === suiteQualifiers.stateMatrix) {
    segments.pop();
  } else if (
    segments.length > 2 &&
    segments.at(-2) === suiteQualifiers.stateMatrix &&
    area.test(last)
  ) {
    segments.splice(-2, 2);
  }
  return segments.join('.');
}

/**
 * Does the rule report `vi.mock('./<specifier>')` in this suite? Any message
 * from elsewhere (a parse error, a file no config matched) is a broken
 * harness, not drift, so it throws under its own cause.
 */
function reportsSelfMock(filename: string, specifier: string): boolean {
  const messages = linter.verify(`vi.mock('./${specifier}');`, config, filename);
  const foreign = messages.filter(message => message.ruleId !== RULE_ID);
  if (foreign.length > 0) {
    throw new Error(`${filename}: ${foreign.map(message => message.message).join('; ')}`);
  }
  return messages.length > 0;
}

describe('no-self-mock-sut against an independent subject derivation', () => {
  it('derives the same subject for every suite in the corpus', () => {
    // This package's own suites, plus every listed form and the near-misses
    // the list excludes.
    const tracked = readdirSync(join(packageRoot, 'src'), { recursive: true })
      .map(String)
      .filter(path => /\.test\.tsx?$/.test(path))
      .map(path => join('src', path));
    const synthetic = [
      ...suiteQualifiers.qualifiers.map(name => `foo.${name}.test.ts`),
      `Page.${suiteQualifiers.stateMatrix}.test.tsx`,
      `Page.${suiteQualifiers.stateMatrix}.loading.test.tsx`,
      ...suiteQualifiers.notQualifiers.map(name => `foo.${name}.test.ts`),
      'Page.states.Loading.test.tsx',
      'Page.states.loading.empty.test.tsx',
      'foo.integration.unit.test.ts',
    ];
    const suites = [...tracked, ...synthetic];

    // A corpus that lost the qualified suites would agree vacuously.
    assert.ok(tracked.some(path => path.endsWith('.integration.test.ts')));

    // Every suite is judged, so a failure names all that drifted. Where a
    // qualifier was stripped, the unstripped stem must NOT be reported: the
    // rule has to agree on which subject, not merely report something.
    const drifted = suites.filter(suite => {
      const subject = subjectOf(suite);
      const stem = basename(suite).replace(/\.test\.tsx?$/, '');
      const filename = join(packageRoot, suite);
      return (
        !reportsSelfMock(filename, subject) ||
        (stem !== subject && reportsSelfMock(filename, stem))
      );
    });

    assert.deepEqual(drifted, []);
  });

  it('reports a harness fault rather than reading it as agreement', () => {
    assert.throws(
      () => reportsSelfMock(join(packageRoot, 'foo.test.ts'), "x'); syntax error ("),
      /foo\.test\.ts: /,
    );
  });
});
