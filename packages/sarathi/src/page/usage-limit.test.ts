import { describe } from 'node:test';

import { expect, it } from './expect.test.ts';
import { usageLimit } from './usage-limit.ts';

const line = (event: unknown) => JSON.stringify(event);
const result = (fields: Record<string, unknown>) =>
  line({ type: 'result', api_error: 'usage_limit_reached', ...fields });
const turn = (...content: unknown[]) =>
  line({ type: 'assistant', message: { content } });

describe('usageLimit', () => {
  it('returns the limit result’s text verbatim, past lines that are not events', () => {
    const stdout = [
      'not json',
      '',
      'null',
      '7',
      line({ type: 'rate_limit_event', api_error: 'usage_limit_reached' }),
      result({ result: '  resets 6:30am  ' }),
    ].join('\n');
    expect(usageLimit(stdout)).toBe('  resets 6:30am  ');
  });

  it('reads the one-object answer of --output-format json', () => {
    expect(
      usageLimit(
        line({
          is_error: true,
          api_error_status: 429,
          api_error: 'usage_limit_reached',
          result:
            "You've hit your weekly limit · resets 6:30am (Asia/Calcutta)",
          type: 'result',
        }),
      ),
    ).toBe("You've hit your weekly limit · resets 6:30am (Asia/Calcutta)");
  });

  it('says the limit without a time when the result has no text', () => {
    for (const fields of [
      {},
      { result: '' },
      { result: '   ' },
      { result: 3 },
    ]) {
      expect(usageLimit(result(fields))).toBe('the claude account is at its usage limit');
    }
  });

  it('finds nothing in any other ending', () => {
    expect(usageLimit('')).toBeUndefined();
    expect(usageLimit('partial')).toBeUndefined();
    expect(
      usageLimit(
        line({ type: 'result', api_error: 'overloaded', result: 'x' }),
      ),
    ).toBeUndefined();
    expect(
      usageLimit(line({ type: 'result', is_error: false, result: 'done' })),
    ).toBeUndefined();
  });

  it('counts the limit only when no tool ran in the session', () => {
    const limit = result({ result: 'resets' });
    expect(
      usageLimit([turn({ type: 'text', text: 'hi' }, 'x'), limit].join('\n')),
    ).toBe('resets');
    expect(
      usageLimit(
        [
          turn({ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't' }),
          limit,
        ].join('\n'),
      ),
    ).toBeUndefined();
    // Order does not matter: a tool after the limit voids it too, and a later
    // turn without a tool does not undo one that ran.
    expect(
      usageLimit([limit, turn({ type: 'tool_use', id: 't' })].join('\n')),
    ).toBeUndefined();
    expect(
      usageLimit(
        [
          turn({ type: 'tool_use', id: 't' }),
          turn({ type: 'text', text: 'after' }),
          limit,
        ].join('\n'),
      ),
    ).toBeUndefined();
    expect(
      usageLimit(
        [limit, turn({ type: 'tool_use', id: 't' }), limit].join('\n'),
      ),
    ).toBeUndefined();
  });
});
