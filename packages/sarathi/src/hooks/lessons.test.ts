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
  docProblems,
  eventSubject,
  kindsOf,
  loadLessons,
  logDir,
  packagedLessons,
  parseDoc,
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
  <!-- held by: a check elsewhere -->
- **No trigger here.** Plain bullet.

### Push by refspec

A push by refspec records no upstream.

- a bullet inside the section belongs to it

\`\`\`sh
# not a heading
<!-- when: command "inside a fence" -->
\`\`\`

Run \`git branch -u\` after it.

<!-- when: command "git push \\S+ \\S+:refs/heads/" -->

## Schema

- **Prisma schema.** Run generate after editing.
  <!-- when: path "apps/*/prisma/**" -->

Closing paragraph.
`;

test('a ### section is one lesson; outside one, a column-0 bullet with its indented lines', () => {
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
  assert.ok(!pools.includes('<!--'), 'when and held-by lines are left out');
  const push = lessons[1]?.text ?? '';
  assert.ok(push.startsWith('### Push by refspec'));
  assert.ok(push.includes('- a bullet inside the section belongs to it'));
  assert.ok(push.includes('# not a heading'));
  assert.ok(push.includes('inside a fence'), 'a when line in a fence is text, not a trigger');
  assert.ok(push.endsWith('Run `git branch -u` after it.'));
  assert.equal(lessons[1]?.triggers[0]?.line, 28);
  assert.equal(lessons[2]?.text, '- **Prisma schema.** Run generate after editing.');
});

test('a when line outside a lesson is a stray; the unit is the one the counter reads', () => {
  assert.deepEqual(parseDoc('# Title\n\n- **A.** text\n', 'a.md'), { lessons: [], strays: [] });
  assert.deepEqual(parseDoc('<!-- when: error "boom" -->\n', 'b.md'), { lessons: [], strays: ['b.md:1'] });
  const column0 = parseDoc('## S\n\n- **A.** text\n<!-- when: error "x" -->\n', 'c.md');
  assert.deepEqual(
    column0.lessons.map(lesson => lesson.id),
    ['c.md#a'],
    'a column-0 marker line stays in its bullet',
  );
  const ended = parseDoc('## S\n\n- **A.** text\n\nA paragraph.\n<!-- when: error "x" -->\n', 'c.md');
  assert.deepEqual(ended, { lessons: [], strays: ['c.md:6'] }, 'a column-0 paragraph ends the bullet');
  const unled = parseLessons('## Section\n\n- plain bullet with no bold lead\n  <!-- when: error "x" -->\n', 'd.md');
  assert.equal(unled[0]?.title, 'plain bullet with no bold lead');
  const long = parseLessons(`- **Long.** ${'word '.repeat(600)}\n  <!-- when: error "x" -->\n`, 'e.md');
  assert.equal(long[0]?.text.length, 2000);
  assert.ok(long[0]?.text.endsWith('…'));
  const deeper = parseDoc('### Three\n\ntext\n#### Four\n<!-- when: error "x" -->\n', 'f.md');
  assert.deepEqual(deeper, { lessons: [], strays: ['f.md:5'] }, 'only ### starts a section; any heading ends one');
  const ended3 = parseLessons('### Three\n\ntext\n<!-- when: error "x" -->\n## Next\n- **B.** b\n', 'g.md');
  assert.equal(ended3[0]?.text, '### Three\n\ntext');
});

test('docProblems names strays, shared ids and broken patterns; README.md is not a lesson file', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'a.md'), '<!-- when: error "stray" -->\n### S\n<!-- when: command "(bad" -->\n### S\n<!-- when: error "y" -->\n');
  writeFileSync(join(dir, 'README.md'), '- **R.** r\n  <!-- when: error "readme" -->\n');
  const problems = docProblems([dir, join(dir, 'missing')]);
  assert.equal(problems.length, 3);
  assert.match(problems[0] ?? '', /^a\.md:1: a when line outside a lesson/);
  assert.equal(problems[1], 'a.md#s: two lessons with a when line share this id, so only the first can show');
  assert.match(problems[2] ?? '', /^a\.md:3: "\(bad" is not a regular expression/);
  assert.ok(!loadLessons([dir]).some(lesson => lesson.file === 'README.md'));
});

test('slug follows GitHub anchors', () => {
  assert.equal(slug('Search peer work by file'), 'search-peer-work-by-file');
  assert.equal(slug('`git push`: by refspec!'), 'git-push-by-refspec');
});

test('lessons load from every folder that exists, .md files only', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'b.md'), '- **B.** b\n  <!-- when: error "b" -->\n');
  writeFileSync(join(dir, 'a.md'), '- **A.** a\n  <!-- when: error "a" -->\n');
  writeFileSync(join(dir, 'notes.txt'), '- **T.** t\n  <!-- when: error "t" -->\n');
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

test('a tool line fires on the whole tool name and, given one, its input; a content line needs its path', () => {
  const [lesson] = parseLessons(
    [
      '- **A.** a',
      '  <!-- when: tool "Agent|Task" input "\\x22subagent_type\\x22:\\x22general-purpose\\x22" -->',
      '  <!-- when: tool "mcp__x__start" -->',
      '  <!-- when: content "DROP DATABASE" path "**/*.test.*" -->',
    ].join('\n'),
    'x.md',
  );
  const [agent, start, drop] = lesson?.triggers ?? [];
  assert.deepEqual(agent?.scope, { qualifier: 'input', pattern: '\\x22subagent_type\\x22:\\x22general-purpose\\x22' });
  assert.equal(start?.scope, undefined);
  assert.deepEqual(drop?.scope, { qualifier: 'path', pattern: '**/*.test.*' });
  if (agent === undefined || start === undefined || drop === undefined) throw new Error('three triggers');

  assert.ok(fires(agent, { text: 'Agent', scope: '{"subagent_type":"general-purpose"}' }));
  assert.ok(fires(agent, { text: 'Task', scope: '{"subagent_type":"general-purpose"}' }));
  assert.ok(!fires(agent, { text: 'Agent', scope: '{"subagent_type":"Explore"}' }));
  assert.ok(!fires(agent, { text: 'AgentX', scope: '{"subagent_type":"general-purpose"}' }), 'the whole name');
  assert.ok(!fires(agent, 'Agent'), 'an input clause needs the input');
  assert.ok(fires(start, 'mcp__x__start'));
  assert.ok(!fires(start, 'mcp__x__start_other'));

  assert.ok(fires(drop, { text: 'await db.$executeRaw`DROP DATABASE x`', scope: 'apps/server/a.integration.test.ts' }));
  assert.ok(!fires(drop, { text: 'DROP DATABASE x', scope: 'apps/server/src/migrate.ts' }), 'outside its path');
  assert.ok(!fires(drop, { text: 'select 1', scope: 'a.test.ts' }));
  assert.ok(!fires(drop, 'DROP DATABASE x'), 'no path, no match');
  assert.ok(!fires({ kind: 'content', pattern: 'x', line: 1 }, { text: 'x', scope: 'a' }), 'content needs a path clause');
  assert.ok(!fires({ kind: 'command', pattern: 'x', line: 1, scope: { qualifier: 'input', pattern: 'y' } }, 'x'));
  assert.ok(!fires({ kind: 'tool', pattern: '(bad', line: 1 }, 'x'));
});

test('trigger problems name a missing or wrong second clause, and a bad input pattern', () => {
  const lessons = parseLessons(
    [
      '- **A.** a',
      '  <!-- when: content "DROP" -->',
      '  <!-- when: command "git" input "x" -->',
      '  <!-- when: tool "Agent" path "x" -->',
      '  <!-- when: tool "Agent" input "(bad" -->',
      '  <!-- when: content "ok" path "a/**" -->',
      '  <!-- when: tool "Agent" -->',
    ].join('\n'),
    'x.md',
  );
  assert.deepEqual(triggerProblems(lessons), [
    'x.md:2: a content line takes a path "…", so it never fires',
    'x.md:3: a command line takes no second clause, so it never fires',
    'x.md:4: a tool line takes an optional input "…", so it never fires',
    'x.md:5: "(bad" is not a regular expression (Invalid regular expression: /(bad/: Unterminated group)',
  ]);
});

test('trigger problems name empty and uncompilable patterns', () => {
  const lessons = parseLessons(
    '- **A.** a\n  <!-- when: command "(bad" -->\n  <!-- when: error "" -->\n  <!-- when: error "fine" -->\n  <!-- when: path "ok/*" -->\n  <!-- when: command "ok" -->\n',
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

test('an event offers every kind it can fire: tool before any call, content before Edit or Write', () => {
  assert.deepEqual(kindsOf({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), ['command', 'tool']);
  assert.deepEqual(kindsOf({ hook_event_name: 'PreToolUse', tool_name: 'Edit' }), ['path', 'content', 'tool']);
  assert.deepEqual(kindsOf({ hook_event_name: 'PreToolUse', tool_name: 'Agent' }), ['tool']);
  assert.deepEqual(kindsOf({ hook_event_name: 'PreToolUse' }), []);
  assert.deepEqual(kindsOf({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }), ['error']);
  assert.deepEqual(kindsOf({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }), []);

  const repo = scratch();
  mkdirSync(join(repo, '.git'));
  const file = join(repo, 'a.test.ts');
  assert.deepEqual(eventSubject({ tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } }, 'tool'), {
    text: 'Agent',
    scope: '{"subagent_type":"Explore"}',
  });
  assert.deepEqual(eventSubject({ tool_name: 'Agent' }, 'tool'), { text: 'Agent', scope: '{}' });
  assert.equal(eventSubject({}, 'tool'), undefined);
  assert.equal(subjectOf({ tool_name: 'Agent' }, 'tool'), 'Agent');
  assert.deepEqual(eventSubject({ cwd: repo, tool_input: { file_path: file, new_string: 'x' } }, 'content'), { text: 'x', scope: 'a.test.ts' });
  assert.deepEqual(eventSubject({ cwd: repo, tool_input: { file_path: file, content: 'y' } }, 'content'), { text: 'y', scope: 'a.test.ts' });
  assert.deepEqual(
    eventSubject({ cwd: repo, tool_input: { file_path: file, edits: [{ new_string: 'a' }, { new_string: 'b' }] } }, 'content'),
    { text: 'a\nb', scope: 'a.test.ts' },
  );
  assert.equal(eventSubject({ cwd: repo, tool_input: { file_path: file, edits: [{ old_string: 'a' }, 'odd'] } }, 'content'), undefined);
  assert.equal(eventSubject({ cwd: repo, tool_input: { file_path: file } }, 'content'), undefined);
  assert.equal(eventSubject({ cwd: repo, tool_input: { file_path: '/elsewhere/a.ts', new_string: 'x' } }, 'content'), undefined);
  assert.equal(subjectOf({ cwd: repo, tool_input: { file_path: file, new_string: 'x' } }, 'content'), 'x');
  assert.deepEqual(eventSubject({ tool_input: { command: 'ls' } }, 'command'), { text: 'ls' });
  assert.equal(eventSubject({ tool_input: {} }, 'command'), undefined);
});

test('tool and content lines show their lesson through respond, the log citing what matched', () => {
  const dir = scratch();
  writeFileSync(
    join(dir, 'x.md'),
    [
      '- **Agent helper.** Use Explore.',
      '  <!-- when: tool "Agent" input "\\x22subagent_type\\x22:\\x22general-purpose\\x22" -->',
      '- **Drop in tests.** Defer drops.',
      '  <!-- when: content "DROP DATABASE" path "**/*.test.ts" -->',
      '',
    ].join('\n'),
  );
  const repo = scratch();
  mkdirSync(join(repo, '.git'));
  const log = join(repo, 'log');
  const deps: Deps = { env: { SARATHI_LESSONS_DIR: log }, now: () => new Date(0), dirs: [dir] };
  const agent = respond(
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: repo, tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'p' } }),
    deps,
  );
  assert.match(agent, /Agent helper/);
  assert.doesNotMatch(agent, /Drop in tests/);
  const drop = respond(
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'a.test.ts'), new_string: 'DROP DATABASE t' } }),
    deps,
  );
  assert.match(drop, /Drop in tests/);
  const rows = readFileSync(join(log, 's1.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; excerpt: string });
  assert.deepEqual(rows.map(row => [row.kind, row.excerpt]), [
    ['tool', 'Agent {"subagent_type":"general-purpose","prompt":"p"}'],
    ['content', 'DROP DATABASE t a.test.ts'],
  ]);
  assert.equal(
    respond(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'a.ts'), new_string: 'DROP DATABASE t' } }), deps),
    '',
  );
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

/** One row of `docs/lessons/when-samples.tsv`: a when line and an event it is written for. */
interface Sample {
  lesson: string;
  kind: Trigger['kind'];
  pattern: string;
  /** The line's second clause (`input` or `path`), or ''. */
  scope: string;
  /** An error text, a command or a path; for `tool`, the name then its input as JSON; for `content`, the path then the text. */
  sample: string;
}

const KINDS: readonly string[] = ['error', 'command', 'path', 'tool', 'content'];

function samplesIn(dir: string): Sample[] {
  const [header, ...rows] = readFileSync(join(dir, 'when-samples.tsv'), 'utf8').trimEnd().split('\n');
  assert.equal(header, 'lesson\tkind\tpattern\tscope\tsample');
  return rows.map(row => {
    const [lesson = '', kind = '', pattern = '', scope = '', sample = '', ...rest] = row.split('\t');
    assert.deepEqual(rest, [], `${lesson}: a sample row has five columns`);
    assert.ok(KINDS.includes(kind), `${lesson}: kind ${kind}`);
    return { lesson, kind: kind as Trigger['kind'], pattern, scope, sample };
  });
}

/** A when line as the table keys it. */
function lineKey(lesson: string, trigger: Trigger): string {
  return `${lesson}\t${trigger.kind}\t${trigger.pattern}\t${trigger.scope?.pattern ?? ''}`;
}

/** The event a sample stands for, in the checkout `root`. */
function sampleEvent(sample: Sample, root: string, session: string): Record<string, unknown> {
  const base = { session_id: session, cwd: root };
  const space = sample.sample.indexOf(' ');
  const [head, tail] = [sample.sample.slice(0, space), sample.sample.slice(space + 1)];
  if (sample.kind === 'error') {
    return { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'true' }, error: sample.sample };
  }
  if (sample.kind === 'command') return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: sample.sample } };
  if (sample.kind === 'path') return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, sample.sample) } };
  if (sample.kind === 'tool') return { ...base, hook_event_name: 'PreToolUse', tool_name: head, tool_input: JSON.parse(tail) as unknown };
  return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, head), old_string: '', new_string: tail } };
}

/** The when lines an event fires, as respond tests them. */
function firedBy(lines: readonly { key: string; trigger: Trigger }[], event: Record<string, unknown>): string[] {
  const kinds = kindsOf(event);
  return lines
    .filter(line => {
      const subject = kinds.includes(line.trigger.kind) ? eventSubject(event, line.trigger.kind) : undefined;
      return subject !== undefined && fires(line.trigger, subject);
    })
    .map(line => line.key);
}

test("veda's own lessons: every when line has a sample, and each sample fires its line and no other", () => {
  assert.deepEqual(docProblems([REPO_LESSONS]), []);
  const lines = loadLessons([REPO_LESSONS]).flatMap(lesson => lesson.triggers.map(trigger => ({ key: lineKey(lesson.id, trigger), trigger })));
  const samples = samplesIn(REPO_LESSONS);
  const keys = samples.map(sample => `${sample.lesson}\t${sample.kind}\t${sample.pattern}\t${sample.scope}`);
  assert.deepEqual([...keys].sort(), lines.map(line => line.key).sort(), 'one sample per when line');
  const root = scratch();
  mkdirSync(join(root, '.git'));
  samples.forEach((sample, index) => {
    const key = keys[index];
    const event = sampleEvent(sample, root, `sample-${index}`);
    assert.deepEqual(firedBy(lines, event), [key], `${key}: fires its line alone`);
    const out = respond(JSON.stringify(event), {
      env: { SARATHI_LESSONS_DIR: join(root, 'log') },
      now: () => new Date(0),
      dirs: [REPO_LESSONS],
    });
    const context = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    assert.equal(context.split('Lesson for this moment').length, 2, `${key}: the event shows one lesson`);
    assert.ok(context.startsWith(`Lesson for this moment (${sample.lesson.split('#')[0]}, `), `${key}: from its file`);
  });
});

test("veda's own lessons: everyday calls fire no when line", () => {
  const lines = loadLessons([REPO_LESSONS]).flatMap(lesson => lesson.triggers.map(trigger => ({ key: lineKey(lesson.id, trigger), trigger })));
  const root = scratch();
  mkdirSync(join(root, '.git'));
  const pre = (tool: string, input: Record<string, unknown>): Record<string, unknown> => ({ hook_event_name: 'PreToolUse', cwd: root, tool_name: tool, tool_input: input });
  const edit = (file: string, text: string): Record<string, unknown> => pre('Edit', { file_path: join(root, file), old_string: 'a', new_string: text });
  const everyday: Record<string, unknown>[] = [
    pre('Bash', { command: 'git status -sb' }),
    pre('Bash', { command: 'git commit -F .tmp/msg.txt' }),
    pre('Bash', { command: 'git cherry-pick 1a2b3c4' }),
    pre('Bash', { command: 'git push -u origin HEAD' }),
    pre('Bash', { command: 'pnpm test' }),
    pre('Bash', { command: 'gh pr view 12 --json state,title' }),
    edit('src/index.ts', 'export const a = 1;'),
    edit('scripts/release.mjs', 'process.kill(child.pid)'),
    edit('docs/lessons/testing.md', 'DROP DATABASE is slow'),
    edit('.claude/sarathi.json', '"hooks": {}'),
    edit('.claude/settings.json', '"advisorModel": "fable"'),
    edit('src/a.test.ts', "expect(sum(1, 2)).toBe(3);"),
    pre('Agent', { description: 'd', prompt: 'p', subagent_type: 'Explore' }),
    pre('mcp__ccd_session__start_session', { title: 't', prompt: 'p' }),
    pre('Read', { file_path: join(root, 'src/index.ts') }),
    { hook_event_name: 'PostToolUseFailure', cwd: root, tool_name: 'Bash', error: 'Exit code 1\nAssertionError: expected 2 to equal 3' },
  ];
  for (const event of everyday) assert.deepEqual(firedBy(lines, event), [], JSON.stringify(event));
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
