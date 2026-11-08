/**
 * The rule-check runtime: input, passes, the session's checkout, refusal and
 * warning text, the decision, Claude Code's output, and one call end to end
 * with the fire log. Checks and registry here are small fakes.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import { maskProcessGitEnv, realGit, repoWithWorktree, scratchDirs } from './fixture.test.ts';
import type { Rule } from './registry.ts';
import {
  type Check,
  type Context,
  decide,
  type Deps,
  excerptOf,
  type Fire,
  git,
  type HookInput,
  type HookOptions,
  liveDeps,
  MIN_REASON,
  parseInput,
  refusal,
  registryRules,
  render,
  type Rules,
  rulesOf,
  runHook,
  sessionRoot,
  statedPasses,
  warning,
} from './runtime.ts';

/** A table of cases, each row typed as its own tuple. */
const rows = <const T extends readonly (readonly unknown[])[]>(table: T): T => table;

// The code under test runs its own git with this process's environment;
// mask it too, or a machine's trace2 daemon writes into the fixtures.
let unmask: () => void = () => undefined;
before(() => {
  unmask = maskProcessGitEnv();
});
after(() => unmask());

const { scratch, cleanup } = scratchDirs('rule-runtime-');
afterEach(cleanup);

const RULE: Rule = {
  id: 'H-14',
  title: 'Merge main only on a conflict',
  notes: ['review-rewords-dismissed-findings', 'second-note'],
  origin: 'work 12',
  enforcer: null,
};
const OWNER = 'the release manager';
const rules: Rules = {
  find: (id) => (id === RULE.id ? RULE : undefined),
  owner: OWNER,
};

function check(overrides: Partial<Check> = {}): Check {
  return {
    rule: 'H-14',
    events: ['PreToolUse'],
    tools: ['Bash'],
    cost: 'a merge that re-buys a whole review',
    instead: 'push without merging main',
    run: () => ({
      action: 'refuse',
      detail: 'This merges main with no conflict.',
    }),
    ...overrides,
  };
}

function input(overrides: Partial<HookInput> = {}): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git merge origin/main' },
    cwd: '',
    ...overrides,
  };
}

function context(hook: HookInput = input(), command = 'git merge origin/main'): Context {
  return {
    input: hook,
    command,
    root: () => '/nowhere',
    git: () => {
      throw new Error('no git in this test');
    },
  };
}

describe('parseInput', () => {
  it('keeps the fields a check reads', () => {
    assert.deepEqual(
      parseInput(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          cwd: '/w',
          session_id: 's',
        }),
      ),
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: '/w',
        session_id: 's',
      },
    );
  });

  for (const [field, event] of rows([
    ['"session_id":""', 'PreToolUse'],
    ['"session_id":7', 'PreToolUse'],
    ['"session_id":7', 'Stop'],
  ])) {
    it(`leaves out a session id that is not text: ${field} on ${event}`, () => {
      assert.ok(
        !('session_id' in parseInput(`{"hook_event_name":"${event}","tool_name":"Edit","tool_input":{},${field}}`)),
      );
    });
  }

  it('keeps the transcript path, on tool events and others', () => {
    assert.equal(
      parseInput(
        '{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{},"transcript_path":"/t.jsonl"}',
      ).transcript_path,
      '/t.jsonl',
    );
    assert.equal(
      parseInput('{"hook_event_name":"UserPromptSubmit","transcript_path":"/t.jsonl"}').transcript_path,
      '/t.jsonl',
    );
  });

  it('keeps a prompt, even an empty one, and leaves out one that is not text', () => {
    assert.equal(parseInput('{"hook_event_name":"UserPromptSubmit","prompt":"Delete 5."}').prompt, 'Delete 5.');
    assert.equal(parseInput('{"hook_event_name":"UserPromptSubmit","prompt":""}').prompt, '');
    assert.ok(!('prompt' in parseInput('{"hook_event_name":"UserPromptSubmit","prompt":7}')));
  });

  for (const field of ['""', '7']) {
    it(`leaves out a transcript path that is not text: ${field}`, () => {
      assert.ok(!('transcript_path' in parseInput(`{"hook_event_name":"Stop","transcript_path":${field}}`)));
    });
  }

  it('keeps the session id of an event without a tool', () => {
    assert.equal(parseInput('{"hook_event_name":"Stop","session_id":"s"}').session_id, 's');
  });

  it('reads an event without a tool, and a missing cwd, as empty', () => {
    assert.deepEqual(parseInput('{"hook_event_name":"Stop","tool_name":"Bash","cwd":"/w"}'), {
      hook_event_name: 'Stop',
      tool_name: '',
      tool_input: {},
      cwd: '/w',
    });
    assert.deepEqual(parseInput('{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{}}'), {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {},
      cwd: '',
    });
  });

  for (const [raw, error] of rows([
    ['{}', 'hook input names no hook_event_name'],
    ['{"hook_event_name":3}', 'hook input names no hook_event_name'],
    ['{"hook_event_name":""}', 'hook input names no hook_event_name'],
    ['{"hook_event_name":"Stop","cwd":null}', 'hook input cwd is not text'],
    ['{"hook_event_name":"PreToolUse","tool_input":{}}', 'PreToolUse input names no tool_name and tool_input'],
    [
      '{"hook_event_name":"PreToolUse","tool_name":"","tool_input":{}}',
      'PreToolUse input names no tool_name and tool_input',
    ],
    ['{"hook_event_name":"PostToolUse","tool_name":"Bash"}', 'PostToolUse input names no tool_name and tool_input'],
    [
      '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":[1]}',
      'PreToolUse input names no tool_name and tool_input',
    ],
    [
      '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":"ls"}',
      'PreToolUse input names no tool_name and tool_input',
    ],
  ])) {
    it(`refuses malformed input ${raw}`, () => {
      assert.throws(() => parseInput(raw), { message: error });
    });
  }

  for (const raw of ['null', '[]', '"text"', '7']) {
    it(`refuses ${raw}`, () => {
      assert.throws(() => parseInput(raw), { message: 'hook input is not a JSON object' });
    });
  }

  it('throws on text that is not JSON', () => {
    assert.throws(() => parseInput('not json'), SyntaxError);
  });
});

describe('statedPasses', () => {
  it('reads the one pass that ends the command', () => {
    assert.equal(MIN_REASON, 12);
    assert.deepEqual(
      [...statedPasses('git merge origin/main  # rule-pass H-14: GitHub reports a conflict  \n\n')],
      [['H-14', 'GitHub reports a conflict']],
    );
    assert.deepEqual(
      [...statedPasses('ls\ngit add -A #rule-pass\tH-06\t:\tthe whole tree is generated')],
      [['H-06', 'the whole tree is generated']],
    );
  });

  it('reads no pass that a later line could run past', () => {
    const pass = '# rule-pass H-14: GitHub reports a conflict';
    assert.equal(statedPasses(`git status ${pass}\ngit merge origin/main`).size, 0);
    assert.equal(statedPasses(`git status ${pass}\ngit merge # ordinary note`).size, 0);
    assert.equal(statedPasses(`git status ${pass}\n \ngit merge`).size, 0);
  });

  it('ignores a reason shorter than the minimum', () => {
    assert.equal(statedPasses('x # rule-pass H-14: 12345678901').size, 0);
    assert.equal(statedPasses('x # rule-pass H-14: 123456789012').get('H-14'), '123456789012');
    assert.equal(statedPasses('x # rule-pass H-14:       1234567890      ').size, 0);
  });

  for (const command of [
    'x # rule-pass H-1: a reason long enough',
    'x # rule-pass h-14: a reason long enough',
    'x # rule-pass H-14 a reason long enough',
    'x rule-pass H-14: a reason long enough',
    'x # rule-pass: H-14: a reason long enough',
    'x # rule-passes H-14: a reason long enough',
  ]) {
    it(`reads no pass from ${command}`, () => {
      assert.equal(statedPasses(command).size, 0);
    });
  }

  it('keeps the reason to its own line', () => {
    assert.equal(statedPasses('x\ny # rule-pass H-14: the last line only').get('H-14'), 'the last line only');
  });

  it('reads a pass only from a real comment, never from quoted or heredoc text', () => {
    const reason = 'a reason long enough';
    for (const command of [
      `git merge origin/main && echo "# rule-pass H-14: ${reason}"`,
      `git merge origin/main -m '# rule-pass H-14: ${reason}'`,
      `git merge origin/main && cat <<EOF\n# rule-pass H-14: ${reason}\nEOF`,
      `git merge origin/main # note: rule-pass H-14: ${reason}`,
      `git merge origin/main # x rule-pass H-14: ${reason}`,
    ]) {
      assert.equal(statedPasses(command).size, 0, command);
    }
    assert.equal(statedPasses(`cat <<EOF\nbody\nEOF\ngit merge # rule-pass H-14: ${reason}`).get('H-14'), reason);
    assert.equal(statedPasses(`x # rule-pass H-14 :${reason}`).get('H-14'), reason);
  });
});

describe('sessionRoot', () => {
  it('names the toplevel of the cwd, a linked worktree included', () => {
    const { worktree } = repoWithWorktree(scratch);
    assert.equal(sessionRoot(join(worktree, 'sub'), '/fallback', realGit), worktree);
  });

  it('falls back without a usable cwd', () => {
    const plain = scratch();
    writeFileSync(join(plain, 'file'), '');
    assert.equal(sessionRoot('', '/fallback', realGit), '/fallback');
    assert.equal(sessionRoot(join(plain, 'missing'), '/fallback', realGit), '/fallback');
    assert.equal(sessionRoot(join(plain, 'file'), '/fallback', realGit), '/fallback');
    assert.equal(sessionRoot(plain, '/fallback', realGit), '/fallback');
    assert.equal(sessionRoot(plain, '/fallback', () => ''), '/fallback');
  });
});

describe('refusal and warning', () => {
  it('names rule, origin, detail, cost, instead, notes and the Bash pass', () => {
    assert.equal(
      refusal(check(), 'This merges main.', RULE, 'Bash', OWNER),
      [
        'Refused by H-14, "Merge main only on a conflict" (work 12).',
        'This merges main.',
        'Prevents: a merge that re-buys a whole review',
        'Instead: push without merging main',
        'Memory: review-rewords-dismissed-findings, second-note',
        'To pass it deliberately, end the command with: # rule-pass H-14: <your reason> (logged).',
      ].join('\n'),
    );
  });

  it('names no origin when the registry records none', () => {
    const { origin: _origin, ...bare } = { ...RULE, id: 'H-19', title: 'File work issues with their type and parent' };
    assert.equal(
      refusal(check({ rule: 'H-19' }), 'D.', bare, 'Bash').split('\n')[0],
      'Refused by H-19, "File work issues with their type and parent".',
    );
    assert.equal(
      warning(check({ rule: 'H-19' }), 'D.', bare).split('\n')[0],
      'Warning from H-19, "File work issues with their type and parent".',
    );
  });

  it('offers no pass for file edits, and survives an unregistered rule', () => {
    assert.equal(
      refusal(check({ rule: 'H-04' }), 'D.', undefined, 'Write', OWNER),
      [
        'Refused by H-04 (not in the rule registry).',
        'D.',
        'Prevents: a merge that re-buys a whole review',
        'Instead: push without merging main',
        'Memory: none recorded',
        'File edits have no pass: ask the release manager.',
      ].join('\n'),
    );
  });

  it('asks the repository owner when no owner is given', () => {
    assert.equal(
      refusal(check(), 'D.', undefined, 'Edit').split('\n').at(-1),
      'File edits have no pass: ask the repository owner.',
    );
  });

  it('offers no pass for a question', () => {
    assert.equal(
      refusal(check({ rule: 'H-20' }), 'D.', undefined, 'AskUserQuestion').split('\n').at(-1),
      'A question has no pass: do what "Instead" says first, then ask.',
    );
  });

  it('sends a search tool to the shell, where a pass can be stated', () => {
    for (const tool of ['Grep', 'Glob']) {
      assert.equal(
        refusal(check({ rule: 'H-09' }), 'D.', undefined, tool, OWNER),
        [
          'Refused by H-09 (not in the rule registry).',
          'D.',
          'Prevents: a merge that re-buys a whole review',
          'Instead: push without merging main',
          'Memory: none recorded',
          `${tool} has no pass: run the search in the shell ending with # rule-pass H-09: <your reason> (logged), or ask the release manager.`,
        ].join('\n'),
      );
    }
  });

  it('words a warning the same way, without a pass', () => {
    assert.equal(
      warning(check(), 'Peer work.', RULE),
      [
        'Warning from H-14, "Merge main only on a conflict" (work 12).',
        'Peer work.',
        'Prevents: a merge that re-buys a whole review',
        'Instead: push without merging main',
        'Memory: review-rewords-dismissed-findings, second-note',
      ].join('\n'),
    );
  });
});

describe('decide', () => {
  it('runs only the checks for this event and tool', () => {
    const ran: string[] = [];
    const spy = (rule: string, overrides: Partial<Check>): Check =>
      check({ rule, ...overrides, run: () => (ran.push(rule), null) });
    decide(
      context(),
      [spy('H-01', {}), spy('H-02', { events: ['Stop'] }), spy('H-03', { tools: ['Edit', 'Write'] }), spy('H-04', { tools: undefined })],
      rules,
    );
    assert.deepEqual(ran, ['H-01', 'H-04']);
  });

  it('refuses, warns and logs each finding', () => {
    const fires = decide(
      context(),
      [
        check(),
        check({
          rule: 'H-05',
          run: () => ({ action: 'warn', detail: 'Peer work.' }),
        }),
      ],
      rules,
    );
    assert.deepEqual(fires, [
      {
        rule: 'H-14',
        outcome: 'refused',
        message: refusal(check(), 'This merges main with no conflict.', RULE, 'Bash', OWNER),
      },
      {
        rule: 'H-05',
        outcome: 'warned',
        message: warning(check({ rule: 'H-05' }), 'Peer work.', undefined),
      },
    ]);
  });

  it('refuses a file edit without offering a pass, naming the owner', () => {
    const edit = input({
      tool_name: 'Write',
      tool_input: { file_path: '/w/a.md' },
    });
    const [fire] = decide(context(edit, ''), [check({ tools: ['Write'] })], rules);
    assert.equal(fire?.message, refusal(check(), 'This merges main with no conflict.', RULE, 'Write', OWNER));
  });

  it('lets a stated pass through its own check only, and logs the reason', () => {
    const command = 'git merge origin/main # rule-pass H-14: GitHub reports a conflict on the PR';
    const fires = decide(
      context(input(), command),
      [check(), check({ rule: 'H-06' }), check({ run: () => ({ action: 'warn', detail: 'W.' }) })],
      rules,
    );
    assert.deepEqual(
      fires.map((fire) => [fire.rule, fire.outcome, fire.reason]),
      [
        ['H-14', 'excepted', 'GitHub reports a conflict on the PR'],
        ['H-06', 'refused', undefined],
        ['H-14', 'warned', undefined],
      ],
    );
    assert.equal(fires[0]?.message, 'Passed H-14 with your stated reason (logged): GitHub reports a conflict on the PR');
  });

  it('honours no pass outside Bash', () => {
    const write = input({ tool_name: 'Write' });
    const fires = decide(context(write, 'x # rule-pass H-14: a reason long enough'), [check({ tools: ['Write'] })], rules);
    assert.equal(fires[0]?.outcome, 'refused');
  });

  it('lets the action go ahead when a check throws, and logs why', () => {
    const fires = decide(
      context(),
      [
        check({
          run: () => {
            throw new Error('boom');
          },
        }),
        check({
          rule: 'H-06',
          run: () => {
            // A check may throw anything; the runtime still names it.
            throw Object.assign(Object.create(null) as object, { toString: () => 'plain' });
          },
        }),
        check({ rule: 'H-07' }),
      ],
      rules,
    );
    assert.deepEqual(fires.slice(0, 2), [
      {
        rule: 'H-14',
        outcome: 'crashed',
        message: 'Check H-14 crashed (boom); the action goes ahead.',
        reason: 'boom',
      },
      {
        rule: 'H-06',
        outcome: 'crashed',
        message: 'Check H-06 crashed (plain); the action goes ahead.',
        reason: 'plain',
      },
    ]);
    assert.equal(fires[2]?.outcome, 'refused');
  });

  it('looks up the registry only for a finding', () => {
    const asked: string[] = [];
    decide(context(), [check({ run: () => null }), check({ rule: 'H-06' })], {
      find: (id) => (asked.push(id), undefined),
      owner: OWNER,
    });
    assert.deepEqual(asked, ['H-06']);
  });
});

describe('render', () => {
  const refused: Fire = { rule: 'H-14', outcome: 'refused', message: 'R' };
  const warned: Fire = { rule: 'H-05', outcome: 'warned', message: 'W' };

  it('says nothing when nothing fired', () => {
    assert.equal(render('PreToolUse', []), '');
    assert.equal(render('PreToolUse', [], 'note'), '');
  });

  it('denies a tool call, refusals first, then the rest and the note', () => {
    assert.deepEqual(JSON.parse(render('PreToolUse', [warned, refused], 'N')), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'R\n\nW\n\nN',
      },
    });
  });

  it('blocks other events with a reason', () => {
    assert.deepEqual(JSON.parse(render('Stop', [refused])), {
      decision: 'block',
      reason: 'R',
    });
  });

  it('adds a warning as context the model reads', () => {
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit']) {
      assert.deepEqual(JSON.parse(render(event, [warned])), {
        hookSpecificOutput: { hookEventName: event, additionalContext: 'W' },
      });
    }
    assert.equal(render('Stop', [warned]), '');
  });
});

describe('excerptOf', () => {
  it('keeps the command, else the file a tool touches', () => {
    assert.equal(excerptOf(input()), 'git merge origin/main');
    assert.equal(excerptOf(input({ tool_input: { file_path: '/w/a.md', content: 'x' } })), '/w/a.md');
    assert.equal(excerptOf(input({ tool_input: { notebook_path: '/w/n.ipynb' } })), '/w/n.ipynb');
    assert.equal(excerptOf(input({ tool_input: {} })), '');
    assert.equal(excerptOf(input({ tool_input: { command: 'a'.repeat(200) } })).length, 120);
  });

  it("keeps a search tool's pattern and folder", () => {
    const search = (tool_input: Record<string, unknown>): string => excerptOf(input({ tool_name: 'Grep', tool_input }));
    assert.equal(search({ pattern: 'TODO', path: '/home/a' }), 'TODO in /home/a');
    assert.equal(search({ pattern: '**/*.md' }), '**/*.md');
    assert.equal(search({ path: '/home/a' }), '/home/a');
    assert.equal(search({ command: 'grep x', pattern: 'p' }), 'grep x');
  });
});

describe('runHook', () => {
  function options(checks: HookOptions['checks'], overrides: Partial<Deps> = {}): HookOptions {
    return {
      firesDir: join(scratch(), 'fires'),
      git: realGit,
      now: () => new Date('2026-10-05T10:00:00.000Z'),
      rules: () => rules,
      fallbackRoot: '/fallback',
      checks,
      ...overrides,
    };
  }
  const stdin = (cwd: string, command = 'git merge origin/main'): string =>
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd,
      tool_input: { command },
    });
  const fires = (dir: string | undefined): Record<string, string>[] =>
    readFileSync(join(dir ?? '', 'fires.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, string>);

  it('costs nothing when no check fires: no git, no registry, no log', () => {
    const calls: string[] = [];
    const quiet: Partial<Deps> = {
      git: () => (calls.push('git'), ''),
      rules: () => (calls.push('rules'), rules),
    };
    assert.equal(runHook(stdin('/w'), options([], quiet)), '');
    assert.equal(runHook(stdin('/w'), options([check({ run: () => null })], quiet)), '');
    assert.deepEqual(calls, []);
  });

  it("hands checks the deps' git", () => {
    const seen: string[][] = [];
    const asks = check({ run: ({ git }) => (git('/r', ['status']), null) });
    assert.equal(runHook(stdin('/w'), options([asks], { git: (root, args) => (seen.push([root, ...args]), '') })), '');
    assert.deepEqual(seen, [['/r', 'status']]);
  });

  it('refuses in a worktree session and logs to the primary checkout by default', () => {
    const { main, worktree } = repoWithWorktree(scratch);
    const out = runHook(stdin(join(worktree, 'sub')), options([check()], { firesDir: undefined }));
    assert.deepEqual(JSON.parse(out), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: refusal(check(), 'This merges main with no conflict.', RULE, 'Bash', OWNER),
      },
    });
    assert.deepEqual(fires(join(main, '.tmp', 'rule-checks')), [
      {
        ts: '2026-10-05T10:00:00.000Z',
        rule: 'H-14',
        outcome: 'refused',
        branch: 'wt',
        excerpt: 'git merge origin/main',
      },
    ]);
  });

  it('resolves the checkout once and loads the registry once per call', () => {
    const { worktree } = repoWithWorktree(scratch);
    const calls: string[] = [];
    const both: Check[] = [
      check({
        run: (ctx) => (ctx.root(), ctx.root(), { action: 'warn', detail: 'A.' }),
      }),
      check({ rule: 'H-06' }),
    ];
    runHook(
      stdin(worktree),
      options(both, {
        git: (root, args) => (calls.push(args[0] ?? ''), realGit(root, args)),
        rules: () => (calls.push('rules'), rules),
      }),
    );
    assert.deepEqual(calls, ['rev-parse', 'rules', 'branch']);
  });

  it('takes its checks from a function, called once the input is read', () => {
    let calls = 0;
    const later = (): readonly Check[] => (calls++, [check({ run: () => null })]);
    assert.equal(runHook(stdin('/w'), options(later)), '');
    assert.equal(calls, 1);
  });

  it('logs the stated reason of a pass, clipped', () => {
    const o = options([check()], { git: (_root, args) => (args[0] === 'branch' ? 'b' : '') });
    const reason = `GitHub reports a conflict ${'z'.repeat(150)}`;
    const out = runHook(stdin('', `git merge origin/main # rule-pass H-14: ${reason}`), o);
    assert.equal(
      JSON.parse(out).hookSpecificOutput.additionalContext,
      `Passed H-14 with your stated reason (logged): ${reason}`,
    );
    const [row] = fires(o.firesDir);
    assert.equal(row?.['outcome'], 'excepted');
    assert.equal(row?.['branch'], 'b');
    assert.equal(row?.['reason']?.length, 120);
    assert.equal(row?.['excerpt']?.length, 120);
  });

  it('gives Bash checks the command, and other tools none', () => {
    const seen: string[] = [];
    const spy = check({
      tools: undefined,
      run: (ctx) => (seen.push(ctx.command), null),
    });
    runHook(stdin('/w', 'ls -la'), options([spy]));
    runHook(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { command: 'ls' },
      }),
      options([spy]),
    );
    assert.deepEqual(seen, ['ls -la', '']);
  });

  it('fails open on input it cannot read, and logs the crash', () => {
    const o = options([check()], { git: (_root, args) => (args[0] === 'branch' ? 'main' : '') });
    const out = runHook('not json', o);
    const answer = JSON.parse(out).hookSpecificOutput;
    assert.equal(answer.hookEventName, 'PreToolUse');
    assert.match(answer.additionalContext, /^The rule checks crashed \(.+\); the action goes ahead\.$/);
    const [row] = fires(o.firesDir);
    assert.partialDeepStrictEqual(row, {
      rule: 'runtime',
      outcome: 'crashed',
      branch: 'main',
      excerpt: '',
    });
  });

  it('fails open on a crash after reading the input, under its event', () => {
    const o = options([check()], {
      git: (_root, args) => (args[0] === 'branch' ? 'main' : ''),
      rules: () => {
        throw new Error('registry unreadable');
      },
    });
    const out = runHook(stdin('/w'), o);
    assert.deepEqual(JSON.parse(out), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'The rule checks crashed (registry unreadable); the action goes ahead.',
      },
    });
    const [row] = fires(o.firesDir);
    assert.partialDeepStrictEqual(row, {
      rule: 'runtime',
      excerpt: 'git merge origin/main',
      reason: 'registry unreadable',
    });
  });

  it('fails open, under the event, when the checks cannot be had', () => {
    const o = options(
      () => {
        throw new Error('checks module missing');
      },
      { git: () => 'b' },
    );
    const out = runHook(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
      o,
    );
    assert.deepEqual(JSON.parse(out), {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'The rule checks crashed (checks module missing); the action goes ahead.',
      },
    });
    assert.equal(fires(o.firesDir)[0]?.['reason'], 'checks module missing');
  });

  it('says so when the fire log cannot be written', () => {
    const blocker = join(scratch(), 'file');
    writeFileSync(blocker, '');
    const out = runHook(stdin(''), options([check()], { firesDir: join(blocker, 'fires'), git: () => 'b' }));
    assert.match(
      JSON.parse(out).hookSpecificOutput.permissionDecisionReason,
      /\n\nThe rule-check fire log could not be written \(.+\)\.$/,
    );
  });
});

describe('the registry and the real seams', () => {
  it('git runs in the named checkout', () => {
    const { worktree } = repoWithWorktree(scratch);
    assert.equal(git(worktree, ['branch', '--show-current']), 'wt');
  });

  it("git carries git's complaint in its error", () => {
    let failure = '';
    try {
      git(scratch(), ['rev-parse', '--show-toplevel']);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    assert.match(failure, /^git rev-parse --show-toplevel: fatal: not a git repository\b.*\.git$/);
  });

  it('rulesOf finds a rule by id and names the owner, the default when none is given', () => {
    const lookup = rulesOf({ owner: OWNER, rules: [RULE] });
    assert.equal(lookup.find('H-14')?.title, 'Merge main only on a conflict');
    assert.equal(lookup.find('X-99'), undefined);
    assert.equal(lookup.owner, OWNER);
    assert.equal(rulesOf({ rules: [] }).owner, 'the repository owner');
  });

  it('registryRules reads the registry file named, and none without one', () => {
    const path = join(scratch(), 'registry.json');
    writeFileSync(path, JSON.stringify({ owner: OWNER, rules: [RULE] }));
    assert.equal(registryRules(path).find('H-14')?.origin, 'work 12');
    assert.equal(registryRules(path).owner, OWNER);
    for (const none of [undefined, '']) {
      assert.equal(registryRules(none).find('H-14'), undefined);
      assert.equal(registryRules(none).owner, 'the repository owner');
    }
  });

  it('liveDeps wires this process to the real seams', () => {
    const path = join(scratch(), 'registry.json');
    writeFileSync(path, JSON.stringify({ rules: [RULE] }));
    const env = { CLAUDE_PROJECT_DIR: '/project', OTHER: 'x' };
    const deps = liveDeps(env, { registry: path, firesDir: '/fires' });
    assert.equal(deps.git, git);
    assert.equal(deps.rules().find('H-14')?.id, 'H-14');
    assert.equal(deps.fallbackRoot, '/project');
    assert.equal(deps.firesDir, '/fires');
    const before = Date.now();
    const now = deps.now().getTime();
    assert.ok(now >= before && now <= Date.now());
    const bare = liveDeps({});
    assert.equal(bare.fallbackRoot, process.cwd());
    assert.equal(bare.firesDir, undefined);
    assert.equal(bare.rules().find('H-14'), undefined);
  });
});
