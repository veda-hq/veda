/**
 * The account's usage limit in `claude -p` output. A session that hit it
 * before any tool ran did nothing, so its job can wait for the reset; one in
 * which a tool ran is an ordinary failure.
 */

const NO_LIMIT_MESSAGE = 'the claude account is at its usage limit';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The event `claude -p` ends on at the limit, as the stream-json `result`
 * line or the whole `--output-format json` answer (both measured 2026-10-28).
 */
const isLimitEvent = (event: Record<string, unknown>): boolean =>
  event.type === 'result' && event.api_error === 'usage_limit_reached';

/** A turn's content, when the event is a turn. */
function turnContent(event: Record<string, unknown>): unknown[] | undefined {
  if (event.type !== 'assistant' || !isObject(event.message)) return undefined;
  const { content } = event.message;
  return Array.isArray(content) ? content : undefined;
}

const isToolUse = (item: unknown): boolean => isObject(item) && item.type === 'tool_use';

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
      // the exit status reports.
      continue;
    }
    if (!isObject(event)) continue;
    const content = turnContent(event);
    if (content !== undefined) {
      // A tool anywhere in the session voids the limit, whatever the order: a
      // rerun must never repeat what a tool already did. Nothing later can
      // change that, so the rest of the stream goes unread.
      if (content.some(isToolUse)) return undefined;
    } else if (isLimitEvent(event)) {
      message = typeof event.result === 'string' && event.result.trim() !== '' ? event.result : NO_LIMIT_MESSAGE;
    }
  }
  return message;
}
