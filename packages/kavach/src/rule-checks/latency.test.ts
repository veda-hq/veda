/**
 * The latency probe: which hooks it times, the arithmetic, and a real run over
 * fixture hooks.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { scratchDirs } from './fixture.test.ts';
import {
  bashHooks,
  CORPUS,
  HOOK_TIMEOUT_MS,
  hookInput,
  LATENCY_FIRES,
  main,
  measure,
  percentile,
  render,
  rootOf,
  rounds,
  timeHook,
  which,
} from './latency.ts';

const { scratch, cleanup } = scratchDirs('rule-latency-');
afterEach(cleanup);

/** A checkout whose settings register two quick Bash hooks and one Edit hook. */
function fixture(): string {
  const root = scratch();
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  const hook = (name: string, body: string): void => {
    const path = join(root, 'hooks', name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  hook('a.sh', 'cat >> "$CLAUDE_PROJECT_DIR/seen"; echo >> "$CLAUDE_PROJECT_DIR/seen"');
  hook('b.sh', 'exit 2');
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ command: '"$CLAUDE_PROJECT_DIR"/hooks/a.sh' }],
          },
          { matcher: 'Edit|Write', hooks: [{ command: 'false' }] },
          {
            matcher: 'Bash|Edit',
            hooks: [{ command: '"$CLAUDE_PROJECT_DIR"/hooks/b.sh' }],
          },
        ],
      },
    }),
  );
  return root;
}

describe('bashHooks', () => {
  it('takes the PreToolUse hooks whose matcher selects Bash', () => {
    assert.deepEqual(
      bashHooks({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash|Edit|Write', hooks: [{ command: 'one' }] },
            {
              matcher: 'Bash',
              hooks: [{ command: 'two' }, { command: 'three' }],
            },
            { matcher: 'Edit|Write', hooks: [{ command: 'edit' }] },
            { matcher: 'BashOutput', hooks: [{ command: 'prefix' }] },
            { matcher: 'MyBash', hooks: [{ command: 'suffix' }] },
            { hooks: [{ command: 'every tool' }] },
          ],
          PostToolUse: [{ matcher: 'Bash', hooks: [{ command: 'post' }] }],
        },
      }),
      ['one', 'two', 'three', 'every tool'],
    );
  });

  it('finds none without PreToolUse hooks', () => {
    assert.deepEqual(bashHooks({}), []);
    assert.deepEqual(bashHooks({ hooks: {} }), []);
  });
});

describe('percentile', () => {
  it('takes the nearest rank', () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(ten, 50), 5);
    assert.equal(percentile(ten, 95), 10);
    assert.equal(percentile(ten, 90), 9);
    assert.equal(percentile(ten, 100), 10);
    assert.equal(percentile(ten, 1), 1);
    assert.equal(percentile([4], 50), 4);
    assert.equal(percentile([], 95), 0);
  });
});

describe('arguments', () => {
  it('reads --rounds', () => {
    assert.equal(rounds([]), 5);
    assert.equal(rounds(['--rounds', '12']), 12);
    assert.equal(rounds(['--rounds', '1']), 1);
    for (const bad of ['0', '-1', '1.5', 'x']) {
      assert.throws(() => rounds(['--rounds', bad]), { message: '--rounds needs a positive whole number' });
    }
    assert.throws(() => rounds(['--rounds']), { message: '--rounds needs a positive whole number' });
  });

  it('reads --root', () => {
    assert.equal(rootOf([], '/repo'), '/repo');
    assert.equal(rootOf(['--root', '/other/./x'], '/repo'), '/other/x');
    assert.throws(() => rootOf(['--root'], '/repo'), { message: '--root needs a folder' });
  });
});

describe('render', () => {
  it('prints load, interpreters and one line per series', () => {
    assert.equal(
      render(
        [
          { name: 'guard', ms: [30, 10, 20] },
          { name: 'none', ms: [] },
        ],
        [1, 2.345, 3],
        { node: '/bin/node', python3: 'missing' },
      ),
      [
        'load average 1.00 2.35 3.00',
        'node: /bin/node',
        'python3: missing',
        '',
        'hook | samples | p50 ms | p95 ms | max ms',
        'guard | 3 | 20 | 30 | 30',
        'none | 0 | 0 | 0 | 0',
      ].join('\n'),
    );
  });
});

describe('a real run', () => {
  it('feeds each hook a Bash hook input', () => {
    assert.deepEqual(JSON.parse(hookInput('/r', 'ls')), {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: '/r',
      tool_input: { command: 'ls', description: 'latency probe' },
    });
  });

  it('replays ten distinct everyday commands, cheap reads to pushes', () => {
    assert.equal(CORPUS.length, 10);
    assert.equal(new Set(CORPUS).size, 10);
    for (const command of CORPUS) assert.notEqual(command.trim(), '');
    assert.equal(CORPUS[0], 'git status --short');
    assert.equal(
      CORPUS.some((command) => command.startsWith('git push')),
      true,
    );
    assert.equal(
      CORPUS.some((command) => command.startsWith('git commit')),
      true,
    );
  });

  it('times a hook to its exit, whatever its status', async () => {
    const root = fixture();
    const ms = await timeHook('sleep 0.2; exit 3', '', process.env);
    assert.ok(ms >= 200);
    await timeHook('"$CLAUDE_PROJECT_DIR"/hooks/a.sh', 'IN', {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
    });
    assert.equal(readFileSync(join(root, 'seen'), 'utf8'), 'IN\n');
  });

  it('takes no offence at a hook that exits without reading its input', async () => {
    await timeHook('exit 0', 'x'.repeat(1 << 20), process.env);
  });

  it('reports the clock’s elapsed time', async () => {
    const readings = [100, 350];
    const ms = await timeHook('true', '', process.env, 1000, () => {
      const next = readings.shift();
      if (next === undefined) throw new Error('clock read too often');
      return next;
    });
    assert.equal(ms, 250);
  });

  it('rejects when bash cannot start or the hook hangs', async () => {
    await assert.rejects(timeHook('true', '', { PATH: '/nonexistent' }), { message: 'true: spawn-error' });
    await assert.rejects(timeHook('sleep 5', '', process.env, 100), { message: 'sleep 5: timeout' });
    assert.equal(HOOK_TIMEOUT_MS, 30_000);
  });

  it('kills what a hung hook started along with it', async () => {
    const root = scratch();
    const mark = join(root, 'mark');
    await assert.rejects(timeHook(`(sleep 0.6; touch ${mark}) & sleep 5`, '', process.env, 100), {
      message: /: timeout$/,
    });
    await new Promise((done) => setTimeout(done, 900));
    assert.equal(spawnSync('test', ['-e', mark]).status, 1);
  });

  it('times every hook alone and all together, rounds × corpus each', async () => {
    const root = fixture();
    const series = await measure(['"$CLAUDE_PROJECT_DIR"/hooks/a.sh', 'true'], ['ls', 'pwd'], 2, root);
    assert.deepEqual(
      series.map((item) => [item.name, item.ms.length]),
      [
        ['"$CLAUDE_PROJECT_DIR"/hooks/a.sh', 4],
        ['true', 4],
        ['per call (all in parallel)', 4],
      ],
    );
    const seen = readFileSync(join(root, 'seen'), 'utf8').trim().split('\n');
    assert.deepEqual(
      seen.map((line) => (JSON.parse(line) as { tool_input: { command: string } }).tool_input.command),
      ['ls', 'ls', 'pwd', 'pwd', 'ls', 'ls', 'pwd', 'pwd'],
    );
  });

  it('sends the timed hooks’ fires away from the real fire log', async () => {
    const root = fixture();
    await measure(['echo "$KAVACH_RULE_FIRES_DIR" > "$CLAUDE_PROJECT_DIR/fires-dir"'], ['ls'], 1, root);
    assert.equal(
      readFileSync(join(root, 'fires-dir'), 'utf8').trim(),
      join(root, '.tmp/rule-checks/latency-fires'),
    );
    assert.equal(LATENCY_FIRES, '.tmp/rule-checks/latency-fires');
  });

  it('runs a call’s hooks together and measures it by the slowest', async () => {
    const root = fixture();
    // Each hook marks its run; on its second run (the parallel one) it waits
    // for the other's second mark, which only hooks running together meet.
    const meet = (me: string, other: string, after: string): string =>
      `echo ${me} >> "$CLAUDE_PROJECT_DIR/marks"; ` +
      `if [ "$(grep -cx ${me} "$CLAUDE_PROJECT_DIR/marks")" = 2 ]; then ` +
      `until [ "$(grep -cx ${other} "$CLAUDE_PROJECT_DIR/marks")" = 2 ]; ` +
      `do sleep 0.01; done; ${after}; fi`;
    const [, , together] = await measure([meet('a', 'b', 'sleep 0.3'), meet('b', 'a', 'true')], ['ls'], 1, root);
    assert.match(readFileSync(join(root, 'marks'), 'utf8'), /^a\nb\n[ab]\n[ab]\n$/);
    assert.ok((together?.ms[0] ?? 0) >= 300);
  });

  it('reports a parallel call by the clock’s elapsed time', async () => {
    const ticks = [1000, 1250];
    const [, together] = await measure(['true'], ['ls'], 1, fixture(), () => Number(ticks.shift()));
    assert.deepEqual(together?.ms, [250]);
  });

  it('finds interpreters on PATH', () => {
    assert.match(which('bash'), /\/bash$/);
    assert.equal(which('no-such-program-kavach'), 'missing');
  });

  it('reports the hooks of the checkout it is pointed at', async () => {
    const root = fixture();
    const out: string[] = [];
    await main(['--rounds', '1', '--root', root], '/unused', (text) => out.push(text));
    const lines = (out[0] ?? '').split('\n');
    assert.match(lines[0] ?? '', /^load average \d+\.\d\d \d+\.\d\d \d+\.\d\d$/);
    assert.equal(lines[1], `node: ${which('node')}`);
    assert.equal(lines[2], `python3: ${which('python3')}`);
    assert.deepEqual(
      lines.slice(5).map((line) => line.split(' | ').slice(0, 2).join(' | ')),
      [
        `"$CLAUDE_PROJECT_DIR"/hooks/a.sh | ${CORPUS.length}`,
        `"$CLAUDE_PROJECT_DIR"/hooks/b.sh | ${CORPUS.length}`,
        `per call (all in parallel) | ${CORPUS.length}`,
      ],
    );
  });

  it('runs as a CLI subcommand', () => {
    const root = fixture();
    const cli = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'latency', '--rounds', '1', '--root', root], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(cli.status, 0);
    assert.match(cli.stdout, /^load average /);
    assert.ok(cli.stdout.includes(`per call (all in parallel) | ${CORPUS.length} |`));
  });
});
