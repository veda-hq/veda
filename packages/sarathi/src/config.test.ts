import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ConfigError,
  compileMatcher,
  entriesFor,
  loadConfig,
  longestTimeout,
  parseConfig,
  settingsMatcher,
} from './config.ts';

const ROOT = '/project';
const parse = (value: unknown): ReturnType<typeof parseConfig> => parseConfig(JSON.stringify(value), 'sarathi.json', ROOT);
const refuses = (value: unknown, message: RegExp): void => {
  assert.throws(() => parse(value), (error: unknown) => error instanceof ConfigError && message.test(error.message));
};

describe('parseConfig', () => {
  it('reads entries and resolves kavach paths from the root', () => {
    const config = parse({
      kavach: { config: '.claude/kavach.json', python: 'tools/python.sh' },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', guard: 'command' },
          { matcher: 'Edit|Write', command: './check.sh', timeout: 5, failClosed: true },
        ],
      },
    });
    assert.equal(config.kavach.config, '/project/.claude/kavach.json');
    assert.equal(config.kavach.python, '/project/tools/python.sh');
    assert.deepEqual(config.hooks.PreToolUse, [
      { matcher: 'Bash', guard: 'command' },
      { matcher: 'Edit|Write', command: './check.sh', timeout: 5, failClosed: true },
    ]);
  });

  it('defaults python to python3 and keeps a bare program name or an absolute path', () => {
    assert.equal(parse({ hooks: {} }).kavach.python, 'python3');
    assert.equal(parse({ hooks: {} }).kavach.config, undefined);
    assert.equal(parse({ kavach: { python: 'python3.13' }, hooks: {} }).kavach.python, 'python3.13');
    assert.equal(parse({ kavach: { config: '/etc/k.json' }, hooks: {} }).kavach.config, '/etc/k.json');
  });

  it('refuses what it cannot run exactly', () => {
    assert.throws(() => parseConfig('{', 'f.json', ROOT), /f\.json is not JSON/);
    refuses([], /must hold an object/);
    refuses({ hooks: {}, extra: 1 }, /unknown key "extra"/);
    refuses({ kavach: [], hooks: {} }, /"kavach" must be an object/);
    refuses({ kavach: { other: 1 }, hooks: {} }, /unknown key "other"/);
    refuses({ kavach: { config: 1 }, hooks: {} }, /kavach\.config/);
    refuses({ kavach: { python: 1 }, hooks: {} }, /kavach\.python/);
    refuses({}, /"hooks" must be an object/);
    refuses({ hooks: { Stop: {} } }, /Stop: must be a list/);
    refuses({ hooks: { Stop: ['x'] } }, /an entry must be an object/);
    refuses({ hooks: { Stop: [{ command: 'x', when: 1 }] } }, /unknown key "when"/);
    refuses({ hooks: { Stop: [{ command: 'x', matcher: 1 }] } }, /"matcher" must be a string/);
    refuses({ hooks: { Stop: [{ command: ' ' }] } }, /"command" must be a non-empty string/);
    refuses({ hooks: { Stop: [{ guard: 'other' }] } }, /"guard" must be/);
    refuses({ hooks: { Stop: [{}] } }, /exactly one of/);
    refuses({ hooks: { Stop: [{ command: 'x', guard: 'command' }] } }, /exactly one of/);
    refuses({ hooks: { Stop: [{ command: 'x', timeout: 0 }] } }, /"timeout" must be/);
    refuses({ hooks: { Stop: [{ command: 'x', timeout: '5' }] } }, /"timeout" must be/);
    refuses({ hooks: { Stop: [{ command: 'x', failClosed: 'yes' }] } }, /"failClosed" must be/);
    refuses({ hooks: { Stop: [{ command: 'x', matcher: '(' }] } }, /not a regular expression/);
  });

  it('accepts a $schema key', () => {
    assert.deepEqual(parse({ $schema: 'x', hooks: {} }).hooks, {});
  });
});

describe('loadConfig', () => {
  it('reads a file and names one it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sarathi-config-'));
    const file = join(dir, 'sarathi.json');
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ command: 'true' }] } }));
    assert.equal(loadConfig(file, dir).hooks.Stop?.length, 1);
    assert.throws(() => loadConfig(join(dir, 'missing.json'), dir), /cannot read .*missing\.json \(ENOENT\)/);
  });
});

describe('compileMatcher', () => {
  it('follows Claude Code: all, exact names, or a regular expression', () => {
    for (const all of [undefined, '', '*']) assert.equal(compileMatcher(all)('Anything'), true);
    const exact = compileMatcher('Edit|Write');
    assert.equal(exact('Edit'), true);
    assert.equal(exact('MultiEdit'), false);
    const mcp = compileMatcher('mcp__a-b__c');
    assert.equal(mcp('mcp__a-b__c'), true);
    const pattern = compileMatcher('Notebook.*');
    assert.equal(pattern('NotebookEdit'), true);
    assert.equal(pattern('Bash'), false);
  });
});

describe('entriesFor, settingsMatcher, longestTimeout', () => {
  const config = parse({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash|Edit', command: 'a' },
        { matcher: 'Bash', command: 'b', timeout: 120 },
        { matcher: 'ExitWorktree', command: 'c' },
      ],
      Stop: [{ command: 'd' }],
      PostToolUse: [{ matcher: 'mcp__.*', command: 'e' }],
      Empty: [],
    },
  });

  it('picks the entries a target fires, in order', () => {
    assert.deepEqual(
      entriesFor(config, 'PreToolUse', 'Bash').map(entry => entry.command),
      ['a', 'b'],
    );
    assert.deepEqual(entriesFor(config, 'PreToolUse', 'Read'), []);
    assert.deepEqual(entriesFor(config, 'Missing', 'Bash'), []);
  });

  it('gives the union of plain matchers, or all', () => {
    assert.equal(settingsMatcher(config, 'PreToolUse'), 'Bash|Edit|ExitWorktree');
    assert.equal(settingsMatcher(config, 'Stop'), undefined);
    assert.equal(settingsMatcher(config, 'PostToolUse'), undefined);
    assert.equal(settingsMatcher(config, 'Missing'), '');
  });

  it('gives the longest timeout, defaulting to 60 s', () => {
    assert.equal(longestTimeout(config, 'PreToolUse'), 120);
    assert.equal(longestTimeout(config, 'Stop'), 60);
    assert.equal(longestTimeout(config, 'Empty'), 0);
  });
});
