import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  fires,
  gitPlaces,
  globToRegExp,
  kindOf,
  loadLessons,
  logDir,
  packagedLessons,
  parseLessons,
  respond,
  shownIn,
  slug,
  subjectOf,
  triggerProblems,
  type Deps,
  type Trigger,
} from './lessons.ts';

const HOOK = fileURLToPath(new URL('./lessons.ts', import.meta.url));
const REPO_LESSONS = fileURLToPath(new URL('../../../../docs/lessons', import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-lessons-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
function scratch(): string {
  counter += 1;
  const dir = join(TMP, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const DOC = `# Testing

Intro text.

## Docker

- **Relabelling a Compose volume.** Labels are part of the hash.
- **Address pools exhausted.** "all predefined address pools have been fully
  subnetted" means leaked networks. Remove only empty ones you own.
<!-- when: error "all predefined address pools have been fully subnetted" -->
<!-- when: command "docker network create" -->
- **No trigger here.** Plain bullet.

### Push by refspec

A push by refspec records no upstream.

\`\`\`sh
# not a heading
<!-- when: command "inside a fence" -->
\`\`\`

Run \`git branch -u\` after it.

<!-- when: command "git push \\S+ \\S+:refs/heads/" -->

## Schema

- **Prisma schema.** Run generate after editing.
<!-- when: path "apps/*/prisma/**" -->
`;

test('a when line belongs to the bullet it follows, or else to its section', () => {
  const lessons = parseLessons(DOC, 'testing.md');
  assert.deepEqual(
    lessons.map(lesson => [lesson.id, lesson.title, lesson.triggers.map(trigger => `${trigger.kind}:${trigger.pattern}`)]),
    [
      [
        'testing.md#address-pools-exhausted',
        'Address pools exhausted',
        ['error:all predefined address pools have been fully subnetted', 'command:docker network create'],
      ],
      ['testing.md#push-by-refspec', 'Push by refspec', ['command:git push \\S+ \\S+:refs/heads/']],
      ['testing.md#prisma-schema', 'Prisma schema', ['path:apps/*/prisma/**']],
    ],
  );
  const pools = lessons[0]?.text ?? '';
  assert.ok(pools.startsWith('- **Address pools exhausted.**'));
  assert.ok(pools.endsWith('Remove only empty ones you own.'));
  assert.ok(!pools.includes('<!--'));
  const push = lessons[1]?.text ?? '';
  assert.ok(push.startsWith('### Push by refspec'));
  assert.ok(push.includes('# not a heading'));
  assert.ok(push.includes('inside a fence'), 'a when line in a fence is text, not a trigger');
  assert.equal(lessons[1]?.triggers[0]?.line, 25);
});

test('a doc without when lines, or one with a bare when line, has the expected lessons', () => {
  assert.deepEqual(parseLessons('# Title\n\n- **A.** text\n', 'a.md'), []);
  const bare = parseLessons('<!-- when: error "boom" -->\n', 'b.md');
  assert.equal(bare[0]?.id, 'b.md#bmd');
  assert.equal(bare[0]?.title, 'b.md');
  const unled = parseLessons('## Section\n\n- plain bullet with no bold lead\n<!-- when: error "x" -->\n', 'c.md');
  assert.equal(unled[0]?.title, 'c.md');
  const long = parseLessons(`- **Long.** ${'word '.repeat(600)}\n<!-- when: error "x" -->\n`, 'd.md');
  assert.equal(long[0]?.text.length, 2000);
  assert.ok(long[0]?.text.endsWith('…'));
});

test('slug follows GitHub anchors', () => {
  assert.equal(slug('Search peer work by file'), 'search-peer-work-by-file');
  assert.equal(slug('`git push`: by refspec!'), 'git-push-by-refspec');
});

test('lessons load from every folder that exists, .md files only', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'b.md'), '- **B.** b\n<!-- when: error "b" -->\n');
  writeFileSync(join(dir, 'a.md'), '- **A.** a\n<!-- when: error "a" -->\n');
  writeFileSync(join(dir, 'notes.txt'), '- **T.** t\n<!-- when: error "t" -->\n');
  mkdirSync(join(dir, 'dir.md'));
  assert.deepEqual(
    loadLessons([join(dir, 'missing'), dir]).map(lesson => lesson.id),
    ['a.md#a', 'b.md#b'],
  );
});

test('globs match within a segment, across segments with **', () => {
  assert.ok(globToRegExp('apps/*/prisma/schema.prisma').test('apps/server/prisma/schema.prisma'));
  assert.ok(!globToRegExp('apps/*/schema.prisma').test('apps/server/prisma/schema.prisma'));
  assert.ok(globToRegExp('**/schema.prisma').test('schema.prisma'));
  assert.ok(globToRegExp('**/schema.prisma').test('a/b/schema.prisma'));
  assert.ok(globToRegExp('scripts/**').test('scripts/a/b.ts'));
  assert.ok(globToRegExp('a?.md').test('ab.md'));
  assert.ok(!globToRegExp('a?.md').test('a/.md'));
  assert.ok(!globToRegExp('a.md').test('abmd'));
});

test('each kind fires on its own subject; a broken pattern never fires', () => {
  const t = (kind: Trigger['kind'], pattern: string): Trigger => ({ kind, pattern, line: 1 });
  assert.ok(fires(t('error', 'All predefined   address pools'), 'Exit code 1\nall predefined\naddress pools have been'));
  assert.ok(!fires(t('error', 'other text'), 'Exit code 1'));
  assert.ok(fires(t('command', 'git push \\S+ \\S+:refs/heads/'), 'git push origin abc123:refs/heads/x'));
  assert.ok(!fires(t('command', 'git push \\S+ \\S+:refs/heads/'), 'git push origin HEAD'));
  assert.ok(!fires(t('command', '(unclosed'), 'anything (unclosed'));
  assert.ok(fires(t('path', 'docs/*.md'), 'docs/a.md'));
  assert.ok(!fires(t('error', ''), 'anything'));
});

test('trigger problems name empty and uncompilable patterns', () => {
  const lessons = parseLessons(
    '- **A.** a\n<!-- when: command "(bad" -->\n<!-- when: error "" -->\n<!-- when: error "fine" -->\n<!-- when: path "ok/*" -->\n<!-- when: command "ok" -->\n',
    'x.md',
  );
  const problems = triggerProblems(lessons);
  assert.equal(problems.length, 2);
  assert.match(problems[0] ?? '', /^x\.md:2: "\(bad" is not a regular expression/);
  assert.equal(problems[1], 'x.md:3: an empty error pattern never fires');
});

test('the git checkout and common dir come from disk: a repository, a worktree, outside git', () => {
  const repo = scratch();
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'sub', 'deep'), { recursive: true });
  assert.deepEqual(gitPlaces(join(repo, 'sub', 'deep')), { root: repo, common: join(repo, '.git') });

  const worktree = scratch();
  const gitDir = join(repo, '.git', 'worktrees', 'w');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  assert.deepEqual(gitPlaces(worktree), { root: worktree, common: join(repo, '.git') });

  const noCommon = scratch();
  const bareDir = join(noCommon, 'gitdir');
  mkdirSync(bareDir);
  writeFileSync(join(noCommon, '.git'), 'gitdir: gitdir\n');
  assert.deepEqual(gitPlaces(noCommon), { root: noCommon, common: bareDir });

  const broken = scratch();
  writeFileSync(join(broken, '.git'), 'not a pointer\n');
  assert.equal(gitPlaces(broken), undefined);
  assert.equal(gitPlaces('/'), undefined);
});

test('an event offers its kind and subject', () => {
  assert.equal(kindOf({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }), 'error');
  assert.equal(kindOf({ hook_event_name: 'PostToolUseFailure', is_interrupt: true }), undefined);
  assert.equal(kindOf({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), 'command');
  assert.equal(kindOf({ hook_event_name: 'PreToolUse', tool_name: 'Edit' }), 'path');
  assert.equal(kindOf({ hook_event_name: 'PreToolUse', tool_name: 'Write' }), 'path');
  assert.equal(kindOf({ hook_event_name: 'PreToolUse', tool_name: 'Grep' }), undefined);
  assert.equal(kindOf({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }), undefined);

  assert.equal(subjectOf({ error: 'Exit code 1\nboom' }, 'error'), 'Exit code 1\nboom');
  assert.equal(subjectOf({}, 'error'), undefined);
  assert.equal(subjectOf({ tool_input: { command: 'ls' } }, 'command'), 'ls');
  assert.equal(subjectOf({ tool_input: 'odd' }, 'command'), undefined);

  const repo = scratch();
  mkdirSync(join(repo, '.git'));
  assert.equal(subjectOf({ cwd: repo, tool_input: { file_path: join(repo, 'a', 'b.ts') } }, 'path'), 'a/b.ts');
  assert.equal(subjectOf({ cwd: join(repo, 'a'), tool_input: { file_path: 'c.ts' } }, 'path'), 'a/c.ts');
  assert.equal(subjectOf({ cwd: repo, tool_input: { file_path: '/elsewhere/x.ts' } }, 'path'), undefined);
  assert.equal(subjectOf({ cwd: repo, tool_input: { file_path: repo } }, 'path'), undefined);
  assert.equal(subjectOf({ cwd: repo, tool_input: { file_path: '' } }, 'path'), undefined);
  const outside = scratch();
  assert.equal(subjectOf({ cwd: outside, tool_input: { file_path: join(outside, 'x.ts') } }, 'path'), 'x.ts');
  assert.equal(typeof subjectOf({ tool_input: { file_path: join(process.cwd(), 'x.ts') } }, 'path'), 'string');
});

test('the log folder: the override, the git common dir, then the state folder', () => {
  const repo = scratch();
  mkdirSync(join(repo, '.git'));
  assert.equal(logDir({ cwd: repo }, { SARATHI_LESSONS_DIR: '/x' }), '/x');
  assert.equal(logDir({ cwd: repo }, {}), join(repo, '.git', 'sarathi', 'lessons'));
  const outside = scratch();
  assert.equal(logDir({ cwd: outside }, { XDG_STATE_HOME: '/state' }), join('/state', 'sarathi', 'lessons'));
  assert.equal(logDir({ cwd: outside }, {}), join(homedir(), '.local', 'state', 'sarathi', 'lessons'));
  assert.equal(typeof logDir({}, {}), 'string');
});

test('shownIn reads shown rows and skips partial lines', () => {
  const dir = scratch();
  const file = join(dir, 's.jsonl');
  assert.deepEqual(shownIn(file), new Set());
  writeFileSync(
    file,
    `${JSON.stringify({ lesson: 'a.md#a', outcome: 'shown' })}\n{"lesson":"b.md#b","outc\n\n${JSON.stringify({ lesson: 'c.md#c', outcome: 'repeat' })}\n`,
  );
  assert.deepEqual(shownIn(file), new Set(['a.md#a']));
});

function setup(): { deps: Deps; log: string; repo: string } {
  const repo = scratch();
  mkdirSync(join(repo, '.git'));
  const lessons = join(repo, 'lessons');
  mkdirSync(lessons);
  writeFileSync(join(lessons, 'testing.md'), DOC);
  const log = join(repo, 'log');
  return { deps: { env: { SARATHI_LESSONS_DIR: log }, now: () => new Date('2026-11-14T00:00:00Z'), dirs: [lessons] }, log, repo };
}

const FAILURE = (session: string | undefined): string =>
  JSON.stringify({
    hook_event_name: 'PostToolUseFailure',
    ...(session === undefined ? {} : { session_id: session }),
    tool_name: 'Bash',
    tool_input: { command: 'docker compose up --wait' },
    error: 'Exit code 1\nError response from daemon: all predefined address pools have been fully subnetted',
    is_interrupt: false,
  });

function rows(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

test('a matching failure shows its lesson once per session and logs every match', () => {
  const { deps, log } = setup();
  const first = JSON.parse(respond(FAILURE('s1'), deps)) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(first.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(first.hookSpecificOutput.additionalContext, /^Lesson for this moment \(testing\.md, "Address pools exhausted"; shown once per session\):\n- \*\*Address pools exhausted\.\*\*/);
  assert.equal(respond(FAILURE('s1'), deps), '', 'shown once per session');
  assert.notEqual(respond(FAILURE('s2'), deps), '', 'another session sees it');
  const logged = rows(join(log, 's1.jsonl'));
  assert.deepEqual(
    logged.map(row => row.outcome),
    ['shown', 'repeat'],
  );
  assert.deepEqual(logged[0], {
    ts: '2026-11-14T00:00:00.000Z',
    session: 's1',
    event: 'PostToolUseFailure',
    tool: 'Bash',
    kind: 'error',
    lesson: 'testing.md#address-pools-exhausted',
    outcome: 'shown',
    excerpt: 'Exit code 1 Error response from daemon: all predefined address pools have been fully subnetted',
  });
});

test('without a session id every match shows, logged to no-session.jsonl', () => {
  const { deps, log } = setup();
  assert.notEqual(respond(FAILURE(undefined), deps), '');
  assert.notEqual(respond(FAILURE('bad/id'), deps), '');
  assert.equal(rows(join(log, 'no-session.jsonl')).length, 2);
});

test('commands and paths fire before the call; a lesson matched twice in one call shows once', () => {
  const { deps, repo } = setup();
  const command = respond(
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'c', tool_name: 'Bash', tool_input: { command: 'git push origin abc:refs/heads/x' } }),
    deps,
  );
  assert.match(command, /Push by refspec/);
  assert.equal(
    respond(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'c', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }), deps),
    '',
  );
  const path = respond(
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'p',
      cwd: repo,
      tool_name: 'Edit',
      tool_input: { file_path: join(repo, 'apps', 'server', 'prisma', 'schema.prisma') },
    }),
    deps,
  );
  assert.match(path, /"hookEventName":"PreToolUse"/);
  assert.match(path, /Prisma schema/);
  const both = respond(
    JSON.stringify({ hook_event_name: 'PostToolUseFailure', session_id: 'b', error: 'all predefined address pools have been fully subnetted' }),
    deps,
  );
  assert.equal((both.match(/Lesson for this moment/g) ?? []).length, 1);
});

test('nothing matches, nothing written: other events, other text, no lessons of the kind, bad input', () => {
  const { deps, log } = setup();
  const quiet = [
    JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'docker network create' } }),
    JSON.stringify({ hook_event_name: 'PostToolUseFailure', session_id: 'q', error: 'Exit code 1\nunrelated' }),
    JSON.stringify({ hook_event_name: 'PostToolUseFailure', session_id: 'q' }),
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'q', tool_name: 'Bash', tool_input: {} }),
    'not json',
    'null',
  ];
  for (const input of quiet) assert.equal(respond(input, deps), '', input);
  const none = { ...deps, dirs: [join(log, 'nowhere')] };
  assert.equal(respond(FAILURE('q'), none), '');
  assert.throws(() => readFileSync(join(log, 'q.jsonl')));
});

test('an unwritable log still shows the lesson', () => {
  const { deps } = setup();
  const blocked = scratch();
  writeFileSync(join(blocked, 'file'), '');
  const shown = respond(FAILURE('w'), { ...deps, env: { SARATHI_LESSONS_DIR: join(blocked, 'file', 'sub') } });
  assert.match(shown, /Address pools exhausted/);
  const readOnly = scratch();
  chmodSync(readOnly, 0o500);
  assert.match(respond(FAILURE('w'), { ...deps, env: { SARATHI_LESSONS_DIR: readOnly } }), /Address pools exhausted/);
  chmodSync(readOnly, 0o700);
});

test('the package carries its lessons beside dist/: copied at build, listed in files', () => {
  assert.ok(packagedLessons().endsWith(join('sarathi', 'lessons')));
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
    files: string[];
    scripts: { build: string };
  };
  assert.ok(manifest.files.includes('lessons'));
  assert.match(manifest.scripts.build, /cp -R \.\.\/\.\.\/docs\/lessons lessons$/);
});

test("veda's own lessons: every when line compiles, and the Docker pools lesson fires on its error alone", () => {
  const lessons = loadLessons([REPO_LESSONS]);
  assert.deepEqual(triggerProblems(lessons), []);
  const error = 'Exit code 1\nnetwork demo_default  Error\nfailed to create network demo_default: Error response from daemon: all predefined address pools have been fully subnetted';
  const fired = lessons.filter(lesson => lesson.triggers.some(trigger => trigger.kind === 'error' && fires(trigger, error)));
  assert.deepEqual(
    fired.map(lesson => lesson.id),
    ['testing.md#address-pools-exhausted-by-leaked-networks'],
  );
});

test('the hook runs as a script: lesson folders as arguments, the answer on stdout', () => {
  const { deps, log } = setup();
  const run = spawnSync(process.execPath, [HOOK, ...deps.dirs, ''], {
    input: FAILURE('script'),
    encoding: 'utf8',
    env: { ...process.env, SARATHI_LESSONS_DIR: log },
  });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Address pools exhausted/);
  assert.equal(run.stderr, '');
});
