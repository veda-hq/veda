import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { rules } from './index.js';

/**
 * The cases for `signal-handler-before-spawn.js`, the module this suite owns
 * (a SHELL-09 script rule).
 *
 * Each `invalid` case is the lesson's shape, reduced: a script that spawns
 * its child and only then installs the handler that forwards a signal to it.
 * Each `valid` case is the corrected code or a near miss. The `guard
 * removal` block moves the handler back after the spawn and proves the rule
 * fires again.
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

const SCRIPT = 'scripts/run.ts';
const installedAfter = (signal: string) => ({ messageId: 'after', data: { signal } });

ruleTester.run('signal-handler-before-spawn', rules['signal-handler-before-spawn']!, {
  valid: [
    // Corrected: the handler first, forwarding to a child it assigns later.
    {
      filename: SCRIPT,
      code: `let child;
      process.on('SIGTERM', () => child?.kill('SIGTERM'));
      process.on('SIGINT', () => child?.kill('SIGINT'));
      child = spawn(process.execPath, [entry], { stdio: 'inherit' });`,
    },
    // The same order inside a function.
    {
      filename: SCRIPT,
      code: `async function main() {
        let child;
        process.once('SIGHUP', () => child?.kill('SIGHUP'));
        child = cp.spawn('x', []);
      }`,
    },
    // A spawn in another function body than the handler's.
    {
      filename: SCRIPT,
      code: `function start() { return spawn('x', []); }
      function guard() { process.on('SIGTERM', stop); }
      const child = fork(worker);
      function later() { process.on('SIGINT', stop); }`,
    },
    // A handler on the child, for another event, for a signal not named
    // here, for a signal the rule cannot read, or removing a listener.
    {
      filename: SCRIPT,
      code: `const child = spawn('x', []);
      child.on('SIGTERM', stop);
      process.on('exit', stop);
      process.on('SIGUSR2', stop);
      process.on(signal, stop);
      process.on(\`SIGTERM\`, stop);
      process.on();
      process.off('SIGTERM', stop);
      process.emit('SIGTERM');
      process[method]('SIGTERM', stop);
      globalThis.process.on('SIGTERM', stop);`,
    },
    // A blocking spawn returns with the child gone; calls that only look like
    // a spawn.
    {
      filename: SCRIPT,
      code: `spawnSync('x', []);
      execFileSync('x', []);
      getSpawner()('x');
      spawner[name]('x');
      process.on('SIGTERM', stop);`,
    },
  ],
  invalid: [
    // The lesson: the child runs before the parent can forward to it.
    {
      filename: SCRIPT,
      code: `const child = spawn(process.execPath, [entry], { stdio: 'inherit' });
      process.on('SIGTERM', () => child.kill('SIGTERM'));
      process.on('SIGINT', () => child.kill('SIGINT'));`,
      errors: [installedAfter('SIGTERM'), installedAfter('SIGINT')],
    },
    // Inside a function body, through a module member.
    {
      filename: SCRIPT,
      code: `async function main() {
        const child = cp.spawn('x', []);
        process.once('SIGHUP', () => child.kill('SIGHUP'));
      }`,
      errors: [installedAfter('SIGHUP')],
    },
    // fork, every listener method, a computed name, behind casts.
    {
      filename: SCRIPT,
      code: `const child = fork(worker);
      process.addListener('SIGTERM', stop);
      process.prependListener('SIGINT', stop);
      process.prependOnceListener('SIGHUP', stop);
      process['on']('SIGTERM', stop);
      process!.on('SIGINT', stop);
      (process.on as typeof process.on)('SIGHUP', stop);`,
      errors: [
        installedAfter('SIGTERM'),
        installedAfter('SIGINT'),
        installedAfter('SIGHUP'),
        installedAfter('SIGTERM'),
        installedAfter('SIGINT'),
        installedAfter('SIGHUP'),
      ],
    },
  ],
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
          rules: { 'shuddhi/signal-handler-before-spawn': 'error' },
        },
      ],
      SCRIPT,
    )
    .map(message => message.messageId ?? message.message);
}

describe('guard removal flips each corrected case', () => {
  it('signal-handler-before-spawn/after', () => {
    const handler = `process.on('SIGTERM', () => child?.kill('SIGTERM'));`;
    const spawnLine = `child = spawn('node', [entry]);`;
    const corrected = `let child;\n${handler}\n${spawnLine}`;
    assert.deepEqual(messageIds(corrected), []);
    const broken = corrected.replace(`${handler}\n${spawnLine}`, `${spawnLine}\n${handler}`);
    assert.notEqual(broken, corrected);
    assert.deepEqual(messageIds(broken), ['after']);
  });
});

describe('signal-handler-before-spawn rule metadata', () => {
  it('states the rule and its message verbatim', () => {
    assert.deepEqual(rules['signal-handler-before-spawn']?.meta, {
      type: 'suggestion',
      docs: {
        description:
          'A script installs its signal handlers before it spawns the child they forward to',
      },
      schema: [],
      messages: {
        after:
          'This {{signal}} handler is installed after `spawn()`, which returns with the child already running: a {{signal}} in between takes the default action, killing this process and orphaning the child. Install the handler before the spawn (it can forward to a `let child` it assigns later).',
      },
    });
  });
});
