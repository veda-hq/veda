/**
 * The account's usage limit in `claude -p` output. A session that hit it
 * before any tool ran did nothing, so its job can wait for the reset; one in
 * which a tool ran is an ordinary failure.
 */

const NO_LIMIT_MESSAGE = 'the claude account is at its usage limit';

/** A field of a parsed line: undefined for a line with none, null and other non-objects included. */
const field = (value: unknown, key: string): unknown => (value as Record<string, unknown> | null | undefined)?.[key];

/**
 * The event `claude -p` ends on at the limit, as the stream-json `result`
 * line or the whole `--output-format json` answer (both measured 2026-10-28).
 */
const isLimitEvent = (event: unknown): boolean =>
  field(event, 'type') === 'result' && field(event, 'api_error') === 'usage_limit_reached';

/** A turn's content, when the event is a turn. */
function turnContent(event: unknown): unknown[] | undefined {
  if (field(event, 'type') !== 'assistant') return undefined;
  const content = field(field(event, 'message'), 'content');
  return Array.isArray(content) ? content : undefined;
}

const isToolUse = (item: unknown): boolean => field(item, 'type') === 'tool_use';

/**
 * The message of a session that hit the usage limit and ran no tool, the
 * event's `result` text verbatim. A session in which a tool ran is an
 * ordinary failure: the tool may already have changed something.
 */
export function usageLimit(stdout: string): string | undefined {
  let message: string | undefined;
  for (const line of stdout.split('\n')) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // fail-open: a line that is not JSON is another failure's output, which
      // the exit status reports; left undefined, it is no event.
    }
    const content = turnContent(event);
    if (content !== undefined) {
      // A tool anywhere in the session voids the limit, whatever the order: a
      // rerun must never repeat what a tool already did. Nothing later can
      // change that, so the rest of the stream goes unread.
      if (content.some(isToolUse)) return undefined;
    } else if (isLimitEvent(event)) {
      const result = field(event, 'result');
      message = typeof result === 'string' && result.trim() !== '' ? result : NO_LIMIT_MESSAGE;
    }
  }
  return message;
}
