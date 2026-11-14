/**
 * How a one-off `claude -p` session's tool traffic is read: shared by
 * `page.ts` (the stream it prints) and `guard.ts` (the
 * transcript its hook reads), so the check before a publish and the check
 * after it cannot read the same session differently. Node builtins only: the
 * guard runs under plain `node`.
 */

/** One tool call of a session, with what the tool returned. */
export interface ToolCall {
  name: string;
  action: unknown;
  /** The page and thread the call targeted, as the session passed them. */
  url: unknown;
  thread: unknown;
  ok: boolean;
  output: string;
}

interface Block {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: { action?: unknown; url?: unknown; thread_id?: unknown } | null;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
  text?: unknown;
}

/** A tool result's text, whether a string or text blocks. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .map(b => (typeof b?.text === 'string' ? b.text : ''))
    .join('\n');
}

function blocksOf(event: unknown): Block[] {
  if (typeof event !== 'object' || event === null || !('message' in event)) {
    return [];
  }
  const { message } = event;
  if (typeof message !== 'object' || message === null) return [];
  const content = 'content' in message ? message.content : undefined;
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** Every tool call paired with its result, in the order the results came. */
export function toolCalls(events: readonly unknown[]): ToolCall[] {
  const pending = new Map<unknown, Omit<ToolCall, 'ok' | 'output'>>();
  const calls: ToolCall[] = [];
  for (const b of events.flatMap(blocksOf)) {
    if (b.type === 'tool_use' && b.id && typeof b.name === 'string') {
      pending.set(b.id, {
        name: b.name,
        action: b.input?.action,
        url: b.input?.url,
        thread: b.input?.thread_id,
      });
    } else if (b.type === 'tool_result') {
      const call = pending.get(b.tool_use_id);
      if (call) {
        calls.push({
          ...call,
          ok: b.is_error !== true,
          output: contentText(b.content),
        });
      }
    }
  }
  return calls;
}

/**
 * The page version an Artifact `read` result names in its opening header,
 * `[Artifact <id> (version <v>) …`. Only the start counts: the page's own
 * HTML follows and may contain the same words.
 */
export const readVersion = (output: string): string | undefined =>
  /^\[Artifact [^\s\]]+ \(version ([^\s)]+)\)/.exec(output)?.[1];

/**
 * The version the latest Artifact call on `url` confirmed, if that call was a
 * read. A read that failed or named no version confirms nothing, whatever came
 * before it, and a publish uses up the read before it: the page has moved on.
 */
export function confirmedVersion(
  calls: readonly ToolCall[],
  url: string,
): string | undefined {
  const last = calls.findLast(c => c.name === 'Artifact' && c.url === url);
  return last?.action === 'read' && last.ok
    ? readVersion(last.output)
    : undefined;
}
