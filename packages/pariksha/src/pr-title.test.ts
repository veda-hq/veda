// pr-title against a real commitlint, loaded from a fixture config written
// the way athya_mono's .commitlintrc.js reads (its parser preset, its type
// enum, and the config-conventional rules its titles meet), with athya's
// shape as the settings.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  checkPrTitle,
  type Commitlint,
  commitlintProblems,
  DEFAULT_PR_TITLE_CONFIG,
  formatHint,
  loadCommitlint,
  NO_COMMITLINT,
  NUMBER_STAND_IN,
  parsePrTitleConfig,
  type PrTitleConfig,
  runPrTitle,
  type Shape,
  squashSubject,
  titleProblems,
} from './pr-title.ts';

const GITMOJI = ['✨', '🐛', '♻', '♻️', '⚡', '⚡️', '🧪', '📝', '🎨', '🔧', '💚', '↩', '↩️', '🧹', '🔥'];
const TYPES = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'style', 'chore', 'ci', 'revert', 'cleanup', 'remove'];
const SUMMARY_MAX = 70;
const SHAPE: Shape = { gitmoji: GITMOJI, types: TYPES, summaryMax: SUMMARY_MAX };
const QUEUE = 'mergify/merge-queue/';
const GUIDE = 'node_modules/@athya-hq/rules/docs/COMMIT_GUIDE.md';
const CONFIG: PrTitleConfig = { shape: SHAPE, skipHeadPrefixes: [QUEUE], guide: GUIDE };
const FORMAT_HINT = formatHint(SHAPE);

/** athya_mono's commitlint config, with config-conventional's rules that its titles meet written out. */
const COMMITLINT_CONFIG = `export default {
  parserPreset: { parserOpts: { headerPattern: /^(?:.*? )?(\\w+)(?:\\((.*)\\))?: (.*)$/, headerCorrespondence: ['type', 'scope', 'subject'] } },
  ignores: [(message) => /^(?:Merge(?:d| of) #\\d+(?:, ?#\\d+)*(?:\\s+Merged by Mergify Merge Queue)?|Merge of PR \\d+)$/.test(message.trim())],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert', 'cleanup', 'remove']],
    'type-empty': [2, 'never'],
    'type-case': [2, 'always', 'lower-case'],
    'subject-empty': [2, 'never'],
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100],
    'header-trim': [2, 'always'],
  },
};
`;

let root = '';
let commitlint: Commitlint;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pariksha-pr-title-'));
  writeFileSync(join(root, 'commitlint.config.mjs'), COMMITLINT_CONFIG);
  const loaded = await loadCommitlint(root);
  assert.notEqual(typeof loaded, 'string', String(loaded));
  commitlint = loaded as Commitlint;
});

after(() => rmSync(root, { recursive: true, force: true }));

const GOOD = [
  '🐛 fix(invoice): keep the synced flag in step with the push',
  '✨ feat: squash-merge pull requests into main',
  '♻️ refactor(ci): fold the title check into Detect Changes',
  '♻ refactor(ci): accept the emoji without its variation selector',
  '⚡️ perf(sync): batch the delta reads',
  '↩️ revert(web): undo the dashboard filter',
  `🔧 chore(ci): ${'a'.repeat(SUMMARY_MAX)}`,
  // One character: a `.*` in a queue's title pattern matches empty, so `[^.]` takes it.
  '🐛 fix(ci): x',
];

const TOO_LONG = `summary is ${SUMMARY_MAX + 1} characters, at most ${SUMMARY_MAX}`;
const PERIOD = 'summary ends with a period';

/** [why, title, the one problem titleProblems must name]. */
const BAD: readonly (readonly [string, string, string])[] = [
  ['no gitmoji', 'fix(invoice): keep the synced flag', FORMAT_HINT],
  ['no type', '🐛 keep the synced flag', FORMAT_HINT],
  ['unknown type', '🐛 wibble(ci): keep the synced flag', FORMAT_HINT],
  ['emoji not in the list', '🚀 feat(ci): ship it', FORMAT_HINT],
  ['no space after the emoji', '🐛fix(ci): keep the synced flag', FORMAT_HINT],
  ['empty summary', '🐛 fix(ci): ', FORMAT_HINT],
  ['trailing period', '🐛 fix(ci): keep the synced flag.', PERIOD],
  ['summary too long', `🐛 fix(ci): ${'a'.repeat(SUMMARY_MAX + 1)}`, TOO_LONG],
  ['GitHub default title', 'Claude/interesting meitner 3ea457', FORMAT_HINT],
  ['GitHub revert title', 'Revert "🐛 fix(ci): keep the synced flag"', FORMAT_HINT],
  ['Mergify queue subject', 'Merge of #452', FORMAT_HINT],
];

describe('titleProblems, the commit-msg shape', () => {
  for (const title of GOOD) {
    it(`accepts ${title}`, () => assert.deepEqual(titleProblems(title, SHAPE), []));
  }

  for (const [why, title, problem] of BAD) {
    it(`refuses a title with ${why}`, () => assert.deepEqual(titleProblems(title, SHAPE), [problem]));
  }

  it('names the format when the shape is wrong', () => {
    assert.deepEqual(titleProblems('drop the gate', SHAPE), [FORMAT_HINT]);
    assert.equal(FORMAT_HINT, 'expected "<gitmoji> <type>(scope): <summary>", e.g. "✨ feat(scope): keep the summary short"');
  });

  it('counts the summary in characters, not UTF-16 units, and names the limit', () => {
    const summary = '✅'.repeat(SUMMARY_MAX);
    assert.deepEqual(titleProblems(`🔧 chore(ci): ${summary}`, SHAPE), []);
    assert.deepEqual(titleProblems(`🔧 chore(ci): ${summary}x`, SHAPE), [TOO_LONG]);
  });

  it('reports a long summary and a trailing period together', () => {
    assert.deepEqual(titleProblems(`🔧 chore(ci): ${'a'.repeat(SUMMARY_MAX)}.`, SHAPE), [TOO_LONG, PERIOD]);
  });

  it('anchors both ends, so nothing may precede the emoji', () => {
    assert.deepEqual(titleProblems('x 🐛 fix(ci): keep the synced flag', SHAPE), [FORMAT_HINT]);
  });

  it('holds the shape the settings give, not athya_mono’s', () => {
    const other: Shape = { gitmoji: ['🚀', '+'], types: ['ship'], summaryMax: 5 };
    assert.deepEqual(titleProblems('🚀 ship: go', other), []);
    // A listed emoji that is a pattern character matches only itself.
    assert.deepEqual(titleProblems('+ ship: go', other), []);
    assert.deepEqual(titleProblems('++ ship: go', other), [formatHint(other)]);
    assert.deepEqual(titleProblems('🐛 fix(ci): go', other), [formatHint(other)]);
    assert.deepEqual(titleProblems('🚀 ship: go far', other), ['summary is 6 characters, at most 5']);
  });
});

describe('commitlintProblems, a real commitlint config', () => {
  it('passes a conventional gitmoji title', async () => {
    assert.deepEqual(await commitlintProblems(GOOD[0] as string, commitlint), []);
  });

  it('refuses a type outside the project enum, naming the rule', async () => {
    const problems = await commitlintProblems('🐛 wibble(ci): keep it', commitlint);
    assert.ok(problems.some((problem) => problem.endsWith('[type-enum]')), problems.join('\n'));
  });

  it('refuses what only commitlint knows, a sentence-case subject', async () => {
    const title = '🐛 fix(ci): Keep the synced flag';
    assert.deepEqual(titleProblems(title, SHAPE), []);
    const problems = await commitlintProblems(title, commitlint);
    assert.ok(problems.some((problem) => problem.endsWith('[subject-case]')), problems.join('\n'));
  });

  it('reads the parser preset the config gives, and none when it gives none', async () => {
    const bare = { ...commitlint, config: { rules: commitlint.config.rules } };
    // With no preset, the default parser reads no type from a gitmoji title.
    assert.ok((await commitlintProblems(GOOD[0] as string, bare)).some((problem) => problem.endsWith('[type-empty]')));
  });
});

describe('checkPrTitle', () => {
  it('skips a head branch a prefix names, such as a merge-queue draft', async () => {
    assert.deepEqual(await checkPrTitle('merge queue: embarking #1', `${QUEUE}main/abc`, CONFIG, commitlint), { skipped: QUEUE, problems: [] });
  });

  it('checks every other head branch with both rule sets', async () => {
    const outcome = await checkPrTitle('drop the gate', 'claude/x', CONFIG, commitlint);
    assert.equal(outcome.skipped, undefined);
    assert.ok(outcome.problems.includes(FORMAT_HINT));
    assert.ok(outcome.problems.some((problem) => problem.endsWith('[type-empty]')));
  });

  it('checks commitlint alone when the settings give no shape', async () => {
    const outcome = await checkPrTitle('fix: keep it', undefined, DEFAULT_PR_TITLE_CONFIG, commitlint);
    assert.deepEqual(outcome, { skipped: undefined, problems: [] });
  });

  // A squash writes `<title> (#N)`. A 94-unit header passes
  // header-max-length (100) bare and fails once the suffix is on.
  const LONG_HEADER = `🔧 chore(${'s'.repeat(12)}): ${'b'.repeat(SUMMARY_MAX)}`;

  it('lints the subject the branch gets, so the suffix cannot push it past header-max-length', async () => {
    assert.equal(LONG_HEADER.length, 94);
    assert.deepEqual(await commitlintProblems(LONG_HEADER, commitlint), []);
    for (const number of ['2786', undefined]) {
      const outcome = await checkPrTitle(LONG_HEADER, 'claude/x', CONFIG, commitlint, number);
      assert.ok(outcome.problems.some((problem) => problem.endsWith('[header-max-length]')), String(number));
    }
  });

  it('builds that subject from the number, or a five-digit stand-in', () => {
    assert.equal(squashSubject('t', '2786'), 't (#2786)');
    assert.equal(squashSubject('t'), `t (#${NUMBER_STAND_IN})`);
    assert.equal(squashSubject('t', ''), `t (#${NUMBER_STAND_IN})`);
    assert.equal(squashSubject('t', '12a'), `t (#${NUMBER_STAND_IN})`);
    assert.equal(NUMBER_STAND_IN.length, 5);
  });

  it('passes a good title', async () => {
    assert.deepEqual(await checkPrTitle(GOOD[1] as string, 'claude/x', CONFIG, commitlint), { skipped: undefined, problems: [] });
  });
});

describe('runPrTitle', () => {
  const loaded = async (): Promise<Commitlint> => commitlint;

  it('exits 2 when PR_TITLE is unset', async () => {
    assert.deepEqual(await runPrTitle({}, CONFIG, root, loaded), { code: 2, stdout: [], stderr: ['pariksha pr-title: PR_TITLE is empty or unset; nothing was checked, so this is not a pass'] });
  });

  it('exits 2 when PR_TITLE is empty', async () => {
    assert.equal((await runPrTitle({ PR_TITLE: '' }, CONFIG, root, loaded)).code, 2);
  });

  it('exits 0 on a good title, saying so', async () => {
    assert.deepEqual(await runPrTitle({ PR_TITLE: GOOD[0], HEAD_REF: 'claude/x' }, CONFIG, root, loaded), { code: 0, stdout: [`pariksha pr-title: ok: ${GOOD[0] as string}`], stderr: [] });
  });

  it('exits 0 on a queue draft without checking it, and without commitlint', async () => {
    const report = await runPrTitle({ PR_TITLE: 'bad', HEAD_REF: `${QUEUE}main/1` }, CONFIG, root, async () => NO_COMMITLINT);
    assert.deepEqual(report, { code: 0, stdout: [`pariksha pr-title: head branch ${QUEUE}main/1 starts with ${QUEUE}, so its title is not checked`], stderr: [] });
  });

  it('exits 1 on a bad title, listing each problem, then the guide', async () => {
    const report = await runPrTitle({ PR_TITLE: '🐛 fix(ci): keep it.' }, CONFIG, root, loaded);
    assert.equal(report.code, 1);
    assert.deepEqual(report.stdout, []);
    assert.ok((report.stderr[0] as string).includes('commit subject when this pull request squash-merges'));
    assert.ok((report.stderr[0] as string).endsWith(': 🐛 fix(ci): keep it.'));
    assert.ok(report.stderr.includes(`  - ${PERIOD}`));
    assert.equal(report.stderr.at(-1), `Edit the title: the edit re-runs this check (re-running this run reuses the old title). See ${GUIDE}.`);
  });

  it('names no guide when the settings give none', async () => {
    const report = await runPrTitle({ PR_TITLE: 'drop the gate' }, DEFAULT_PR_TITLE_CONFIG, root, loaded);
    assert.equal(report.code, 1);
    assert.equal(report.stderr.at(-1), 'Edit the title: the edit re-runs this check (re-running this run reuses the old title).');
  });

  it("loads the root's commitlint config itself when no loader is passed", async () => {
    const report = await runPrTitle({ PR_TITLE: 'drop the gate' }, CONFIG, root);
    assert.equal(report.code, 1);
    assert.ok(report.stderr.some((line) => line.endsWith('[type-empty]')));
  });

  it('exits 2 when commitlint is not installed', async () => {
    assert.deepEqual(await runPrTitle({ PR_TITLE: GOOD[0] }, CONFIG, root, async () => NO_COMMITLINT), { code: 2, stdout: [], stderr: [`pariksha pr-title: ${NO_COMMITLINT}`] });
  });

  it('exits 2 when the commitlint config does not load, with its reason', async () => {
    const broken = mkdtempSync(join(tmpdir(), 'pariksha-pr-title-broken-'));
    try {
      writeFileSync(join(broken, 'commitlint.config.mjs'), "export default { extends: ['no-such-commitlint-config'] };\n");
      const report = await runPrTitle({ PR_TITLE: GOOD[0] }, CONFIG, broken);
      assert.equal(report.code, 2);
      assert.match(report.stderr[0] as string, /^pariksha pr-title: the commitlint config at .* did not load: .*no-such-commitlint-config.*; nothing was checked, so this is not a pass$/);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe('loadCommitlint', () => {
  it('names the peers when they cannot be imported or are not what they should be', async () => {
    assert.equal(
      await loadCommitlint(root, async () => {
        throw new Error('Cannot find package');
      }),
      NO_COMMITLINT,
    );
    assert.equal(await loadCommitlint(root, async () => ({ load: {}, lint: () => undefined })), NO_COMMITLINT);
    assert.equal(await loadCommitlint(root, async () => ({ load: () => undefined, lint: 'x' })), NO_COMMITLINT);
  });
});

describe('parsePrTitleConfig', () => {
  it('reads every key', () => {
    assert.deepEqual(parsePrTitleConfig(JSON.stringify({ shape: SHAPE, skipHeadPrefixes: [QUEUE], guide: GUIDE })), CONFIG);
  });

  it('defaults to commitlint alone: no shape, no skip, no guide', () => {
    assert.deepEqual(parsePrTitleConfig('{}'), DEFAULT_PR_TITLE_CONFIG);
  });

  const refused: readonly (readonly [string, string, RegExp])[] = [
    ['not JSON', '{', /^Error: not JSON: /],
    ['not an object', '[]', /must be a JSON object/],
    ['an unknown key', '{"title":1}', /unknown key "title"; pr-title reads shape, skipHeadPrefixes, guide/],
    ['skipHeadPrefixes not a list', '{"skipHeadPrefixes":"m/"}', /"skipHeadPrefixes" must be a list/],
    ['an empty prefix, which would skip every branch', '{"skipHeadPrefixes":[""]}', /none empty/],
    ['a guide that is not a string', '{"guide":1}', /"guide" must be a path or URL/],
    ['a blank guide', '{"guide":" "}', /"guide" must be a path or URL/],
    ['a shape that is not an object', '{"shape":[]}', /"shape" must be an object/],
    ['an unknown shape key', '{"shape":{"gitmoji":["✨"],"types":["feat"],"summaryMax":1,"emoji":[]}}', /unknown key "shape.emoji"/],
    ['no gitmoji', '{"shape":{"gitmoji":[],"types":["feat"],"summaryMax":1}}', /"shape.gitmoji" must be a non-empty list/],
    ['a blank emoji', '{"shape":{"gitmoji":[" ✨"],"types":["feat"],"summaryMax":1}}', /"shape.gitmoji" must be a non-empty list/],
    ['no types', '{"shape":{"gitmoji":["✨"],"summaryMax":1}}', /"shape.types" must be a non-empty list/],
    ['a type that is not lower case', '{"shape":{"gitmoji":["✨"],"types":["Feat"],"summaryMax":1}}', /lower-case types/],
    ['no summaryMax', '{"shape":{"gitmoji":["✨"],"types":["feat"]}}', /"shape.summaryMax" must be a whole number/],
    ['a summaryMax of 0', '{"shape":{"gitmoji":["✨"],"types":["feat"],"summaryMax":0}}', /at least 1/],
    ['a fractional summaryMax', '{"shape":{"gitmoji":["✨"],"types":["feat"],"summaryMax":1.5}}', /whole number/],
  ];
  for (const [why, text, pattern] of refused) {
    it(`refuses ${why}`, () => assert.throws(() => parsePrTitleConfig(text), pattern));
  }
});
