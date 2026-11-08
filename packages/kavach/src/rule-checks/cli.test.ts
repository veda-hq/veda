/**
 * The rule-check CLI in process: loading a consumer's checks module, the
 * hook's flags and variables, and the subcommands it hands on.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import { CHECKS_ENV, checksOf, hook, type Io, isCheck, loadChecks, run } from './cli.ts';
import { maskProcessGitEnv, repoWithWorktree, scratchDirs } from './fixture.test.ts';
import { markerName } from './live-runs.ts';

let unmask: () => void = () => undefined;
before(() => {
  unmask = maskProcessGitEnv();
});
after(() => unmask());

const { scratch, cleanup } = scratchDirs('rule-cli-');
afterEach(cleanup);

/** A checks module refusing a `git merge`, as a consumer would write one. */
const REFUSE_MERGE = `export const CHECKS = [
  {
    rule: 'H-14',
    events: ['PreToolUse'],
    tools: ['Bash'],
    cost: 'a merge that re-buys a review',
    instead: 'push without merging main',
    run: (context) => (context.command.includes('git merge') ? { action: 'refuse', detail: 'This merges main.' } : null),
  },
];
`;

const REGISTRY = JSON.stringify({
  owner: 'the release manager',
  rules: [{ id: 'H-14', title: 'Merge main only on a conflict', notes: ['merge-only-on-conflict'], enforcer: null }],
});

function capture(): Io & { lines: string[]; errors: string[]; written: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const written: string[] = [];
  return {
    lines,
    errors,
    written,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    write: (text) => written.push(text),
  };
}

const event = (cwd: string, command: string): string =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });

const check = {
  rule: 'H-01',
  events: ['PreToolUse'],
  cost: 'c',
  instead: 'i',
  run: () => null,
};

describe('isCheck and checksOf', () => {
  it('takes a check with or without tools', () => {
    assert.equal(isCheck(check), true);
    assert.equal(isCheck({ ...check, tools: ['Bash'] }), true);
  });

  for (const [name, value] of [
    ['null', null],
    ['a list', [check]],
    ['no rule', { ...check, rule: 1 }],
    ['events that are not text', { ...check, events: [1] }],
    ['events that are not a list', { ...check, events: 'PreToolUse' }],
    ['tools that are not a list', { ...check, tools: 'Bash' }],
    ['no cost', { ...check, cost: undefined }],
    ['no instead', { ...check, instead: 3 }],
    ['a run that is not a function', { ...check, run: 'x' }],
  ] as const) {
    it(`refuses ${name}`, () => {
      assert.equal(isCheck(value), false);
    });
  }

  it('reads CHECKS, else the default export', () => {
    assert.deepEqual(checksOf({ CHECKS: [check] }, 'm'), [check]);
    assert.deepEqual(checksOf({ default: [check] }, 'm'), [check]);
    assert.deepEqual(checksOf({ CHECKS: [], default: [check] }, 'm'), []);
  });

  it('names what a module exports wrongly', () => {
    assert.throws(() => checksOf({}, 'm.js'), {
      message: 'm.js exports no list of checks (as CHECKS or its default export)',
    });
    assert.throws(() => checksOf('text', 'm.js'), { message: /^m\.js exports no list/ });
    assert.throws(() => checksOf({ CHECKS: check }, 'm.js'), { message: /^m\.js exports no list/ });
    assert.throws(() => checksOf({ CHECKS: [check, { rule: 'H-02' }] }, 'm.js'), {
      message: 'm.js: check 1 is not a check (rule, events, cost, instead and run)',
    });
  });
});

describe('loadChecks', () => {
  it('imports a JavaScript module and a TypeScript one', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'checks.mjs'), REFUSE_MERGE);
    writeFileSync(
      join(dir, 'checks.ts'),
      `const checks: { rule: string }[] = [{ rule: 'H-02', events: ['Stop'], cost: 'c', instead: 'i', run: () => null } as { rule: string }];\nexport default checks;\n`,
    );
    assert.deepEqual(
      (await loadChecks(join(dir, 'checks.mjs'))).map((c) => c.rule),
      ['H-14'],
    );
    assert.deepEqual(
      (await loadChecks(join(dir, 'checks.ts'))).map((c) => c.rule),
      ['H-02'],
    );
  });

  it('rejects a module that is missing', async () => {
    await assert.rejects(loadChecks(join(scratch(), 'none.mjs')), /Cannot find module/);
  });
});

describe('hook', () => {
  /** A checkout with the refusing checks module and the registry, as a consumer keeps them. */
  function consumer(): string {
    const { worktree } = repoWithWorktree(scratch);
    mkdirSync(join(worktree, 'rules'));
    writeFileSync(join(worktree, 'rules', 'checks.mjs'), REFUSE_MERGE);
    writeFileSync(join(worktree, 'rules', 'registry.json'), REGISTRY);
    return worktree;
  }

  it('refuses with the registry title and owner, paths relative to the project folder', async () => {
    const root = consumer();
    const fires = join(scratch(), 'fires');
    const out = await hook(
      ['--checks', 'rules/checks.mjs', '--registry', 'rules/registry.json', '--fires-dir', fires],
      event(root, 'git merge origin/main'),
      { CLAUDE_PROJECT_DIR: root },
    );
    const reason: string = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
    assert.equal(reason.split('\n')[0], 'Refused by H-14, "Merge main only on a conflict".');
    assert.match(reason, /\nMemory: merge-only-on-conflict\n/);
    assert.match(readFileSync(join(fires, 'fires.jsonl'), 'utf8'), /"outcome":"refused"/);
  });

  it('is silent when no check fires', async () => {
    const root = consumer();
    const out = await hook(['--checks', join(root, 'rules', 'checks.mjs')], event(root, 'git status'), {
      CLAUDE_PROJECT_DIR: root,
    });
    assert.equal(out, '');
  });

  it('takes its paths from the variables, a flag winning over its variable', async () => {
    const root = consumer();
    const fires = join(scratch(), 'fires');
    const env = {
      CLAUDE_PROJECT_DIR: root,
      [CHECKS_ENV]: 'rules/missing.mjs',
      KAVACH_RULE_REGISTRY: 'rules/registry.json',
      KAVACH_RULE_FIRES_DIR: fires,
    };
    const out = await hook(['--checks', 'rules/checks.mjs'], event(root, 'git merge x'), env);
    assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /^Refused by H-14, "Merge main only on a conflict"\./);
    assert.equal(existsSync(join(fires, 'fires.jsonl')), true);
    const fromEnv = await hook([], event(root, 'git merge x'), { ...env, [CHECKS_ENV]: 'rules/checks.mjs' });
    assert.match(JSON.parse(fromEnv).hookSpecificOutput.permissionDecisionReason, /^Refused by H-14/);
  });

  it('logs to the primary checkout when no fire-log folder is named, an empty variable included', async () => {
    const root = consumer();
    const out = await hook(['--checks', 'rules/checks.mjs'], event(root, 'git merge x'), {
      CLAUDE_PROJECT_DIR: root,
      KAVACH_RULE_FIRES_DIR: '',
    });
    assert.match(out, /permissionDecision/);
    const main = join(root, '..', '..');
    assert.equal(existsSync(join(main, '.tmp', 'rule-checks', 'fires.jsonl')), true);
  });

  for (const [name, argv, env, reason] of [
    ['no checks module', [], {}, 'no checks module: pass --checks or set KAVACH_RULE_CHECKS'],
    ['an empty checks variable', [], { [CHECKS_ENV]: '' }, 'no checks module'],
    ['an unknown flag', ['--check', 'x'], {}, 'unknown argument "--check"'],
    ['a flag with no value', ['--checks'], {}, '--checks needs a value'],
    ['a module that is missing', ['--checks', 'none.mjs'], {}, 'Cannot find module'],
  ] as const) {
    it(`fails open on ${name}, as a logged crash`, async () => {
      const root = scratch();
      const fires = join(root, 'fires');
      const out = await hook(argv, event(root, 'ls'), {
        CLAUDE_PROJECT_DIR: root,
        KAVACH_RULE_FIRES_DIR: fires,
        ...env,
      });
      const context: string = JSON.parse(out).hookSpecificOutput.additionalContext;
      assert.match(context, /^The rule checks crashed \(.*\); the action goes ahead\.$/);
      assert.ok(context.includes(reason), context);
      assert.match(readFileSync(join(fires, 'fires.jsonl'), 'utf8'), /"rule":"runtime"/);
    });
  }

  it('names a thrown value that is not an Error', async () => {
    const root = scratch();
    writeFileSync(join(root, 'throws.mjs'), 'throw "not loaded";\n');
    const out = await hook(['--checks', 'throws.mjs'], event(root, 'ls'), {
      CLAUDE_PROJECT_DIR: root,
      KAVACH_RULE_FIRES_DIR: join(root, 'fires'),
    });
    assert.equal(
      JSON.parse(out).hookSpecificOutput.additionalContext,
      'The rule checks crashed (not loaded); the action goes ahead.',
    );
  });
});

describe('run', () => {
  it('answers a hook event read from stdin, as written', async () => {
    const root = scratch();
    writeFileSync(join(root, 'checks.mjs'), REFUSE_MERGE);
    const io = capture();
    const status = await run(['--checks', 'checks.mjs'], io, () => event(root, 'git merge x'), {
      CLAUDE_PROJECT_DIR: root,
      KAVACH_RULE_FIRES_DIR: join(root, 'fires'),
    });
    assert.equal(status, 0);
    assert.equal(io.written.length, 1);
    assert.match(io.written[0] ?? '', /^\{"hookSpecificOutput":\{"hookEventName":"PreToolUse","permissionDecision":"deny"/);
    assert.deepEqual([io.lines, io.errors], [[], []]);
  });

  it('hands count its arguments', async () => {
    const root = scratch();
    writeFileSync(join(root, 'registry.json'), REGISTRY);
    const io = capture();
    assert.equal(await run(['count', '--registry', join(root, 'registry.json'), '--json'], io, () => '', {}), 0);
    assert.deepEqual(io.lines, [JSON.stringify({ total: 1, unenforced: ['H-14'] })]);
    assert.equal(await run(['count'], io, () => '', {}), 2);
  });

  it('hands push-marker its arguments', async () => {
    const dir = scratch();
    const io = capture();
    assert.equal(await run(['push-marker', 'write', dir, String(process.pid)], io, () => '', {}), 0);
    assert.equal(existsSync(join(dir, markerName(process.pid))), true);
    assert.equal(await run(['push-marker', 'clear', dir, String(process.pid)], io, () => '', {}), 0);
    assert.equal(existsSync(join(dir, markerName(process.pid))), false);
    assert.equal(await run(['push-marker'], io, () => '', {}), 2);
    assert.deepEqual(io.errors, ['usage: push-marker write|clear <git-dir> <pid>']);
  });

  /** A checkout whose settings register one Bash hook that does nothing. */
  function timed(): string {
    const root = scratch();
    mkdirSync(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'true' }] }] } }),
    );
    return root;
  }

  it('reports a latency run that cannot start', async () => {
    const io = capture();
    assert.equal(await run(['latency', '--root', timed(), '--rounds', '0'], io, () => '', {}), 2);
    assert.deepEqual(io.errors, ['latency: --rounds needs a positive whole number']);
    const settings = capture();
    assert.equal(await run(['latency', '--root', scratch()], settings, () => '', {}), 2);
    assert.match(settings.errors[0] ?? '', /^latency: ENOENT/);
  });

  it('runs latency over the hooks of the checkout named', async () => {
    const root = timed();
    const io = capture();
    assert.equal(await run(['latency', '--root', root, '--rounds', '1'], io, () => '', {}), 0);
    assert.match(io.lines[0] ?? '', /\nper call \(all in parallel\) \| 10 \|/);
  });
});
