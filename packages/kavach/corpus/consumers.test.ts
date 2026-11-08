import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  bashEvent,
  CONSUMERS,
  denied,
  PACKAGE_ROOT,
  SAMPLE_CONFIG,
  verdict,
  type Spawned,
} from './consumers.ts';
import type { CorpusRow } from './corpus.ts';

const spawned = (over: Partial<Spawned>): Spawned => ({
  status: 0,
  stdout: '',
  stderr: '',
  ...over,
});

describe('verdict', () => {
  it('reads exit 2, or a JSON deny in either protocol, as a refusal', () => {
    for (const result of [
      spawned({ status: 2 }),
      spawned({ stdout: '{"hookSpecificOutput":{"permissionDecision": "deny"}}' }),
      spawned({ stdout: '{"decision":"deny"}' }),
    ]) {
      assert.equal(denied(result), true);
      assert.equal(verdict(result), true);
    }
  });

  it('reads only a clean exit 0 as an allow', () => {
    assert.equal(denied(spawned({})), false);
    assert.equal(verdict(spawned({})), false);
  });

  it('refuses to read a crash, a timeout or any other status as a verdict', () => {
    for (const status of [null, 1, 3, 124]) {
      assert.throws(
        () => verdict(spawned({ status, stderr: 'Traceback: boom' })),
        /guard gave no verdict \(status .*\): Traceback: boom/,
      );
    }
  });
});

describe('the consumers', () => {
  it('send the PreToolUse event Claude Code sends for a Bash call', () => {
    assert.deepEqual(JSON.parse(bashEvent('ls', '/w')), {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/w',
    });
  });

  it('name source files and a sample config that exist', () => {
    assert.equal(existsSync(SAMPLE_CONFIG), true);
    for (const consumer of CONSUMERS) {
      for (const file of consumer.files) {
        assert.equal(existsSync(join(PACKAGE_ROOT, file)), true, file);
      }
    }
  });

  it('refuse to judge a row without a fixture', async () => {
    const row: CorpusRow = {
      id: 'r',
      intent: 'outside-write',
      role: 'attack',
      happens: true,
      family: 'f',
      text: 'touch x',
    };
    for (const consumer of CONSUMERS) {
      await assert.rejects(
        async () => consumer.judge(row, row.text, null),
        /guard consumers need a fixture/,
      );
    }
  });
});
