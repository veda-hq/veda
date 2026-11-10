// Where a Markdown file's fenced code blocks are, line by line: the one
// reading EVIDENCE-01 needs to tell commands from captured output. Which
// lines open and close a fence is CommonMark's answer, from
// mdast-util-from-markdown; the lines stay the file's own, so every finding
// keeps its source line.
import { fromMarkdown } from "mdast-util-from-markdown";

export interface Fence {
  /** 1-based line of the opening marker. */
  readonly open: number;
  /** 1-based line of the closing marker; the container's last line when unclosed. */
  readonly close: number;
  /** First word of the info string, lower-cased ('' when none). */
  readonly lang: string;
  /** The lines between the markers, quote markers taken off, with their 1-based numbers. */
  readonly body: readonly { readonly n: number; readonly text: string }[];
}

export interface MarkdownDoc {
  readonly lines: readonly string[];
  readonly fences: readonly Fence[];
  /** inFence[n] is true when 1-based line n is a fence marker or inside one. */
  readonly inFence: readonly boolean[];
}

/** The part of an mdast node this reading uses. */
interface MdNode {
  readonly type: string;
  readonly lang?: string | null | undefined;
  readonly value?: string | undefined;
  readonly children?: readonly MdNode[] | undefined;
  readonly position?: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  } | undefined;
}

/** A regular expression match's group: '' when it did not take part. */
export const group = (match: RegExpExecArray, index: number): string =>
  match[index] ?? "";

/** 1-based line `n` of `lines`: '' past the end. */
const lineAt = (lines: readonly string[], n: number): string =>
  lines[n - 1] ?? "";

/** A fenced block's opener, read where mdast places the code node. */
const FENCE_MARKER = /^(`{3,}|~{3,})/;
/** A closer: the opener's character, alone on its line. */
const FENCE_CLOSER = /^\s*(`+|~+)\s*$/;

/**
 * A line with its `quotes` blockquote markers taken off: a fence inside a
 * quote (`> ```text`) is a fence, and its body lines carry the same `> `.
 * mdast counts the quotes, so a marker may sit at every indent: a quote nested
 * in a list item starts past the item's own indentation.
 */
const unquote = (line: string, quotes: number): string => {
  let inner = line;
  for (let depth = 0; depth < quotes; depth += 1) {
    inner = inner.replace(/^[ \t]*> ?/, "");
  }
  return inner;
};

export const parseMarkdown = (text: string): MarkdownDoc => {
  const lines = text.split(/\r?\n/);
  // Frontmatter is not Markdown: a `---` block on the first line is skipped,
  // and its lines are never in a fence.
  let offset = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end !== -1) offset = end + 1;
  }
  const fences: Fence[] = [];
  const inFence = new Array<boolean>(lines.length + 1).fill(false);
  const readFence = (node: MdNode, parent: MdNode, quotes: number): void => {
    // mdast gives every code node its position and value.
    const { start, end } = node.position as NonNullable<MdNode["position"]>;
    const value = node.value as string;
    const n = start.line + offset;
    // An indented code block starts at its indentation, not at a marker.
    const marker = FENCE_MARKER.exec(lineAt(lines, n).slice(start.column - 1));
    if (marker === null) return;
    const inner = (at: number): string => unquote(lineAt(lines, at), quotes);
    const last = end.line + offset;
    const closer = FENCE_CLOSER.exec(inner(last));
    const bodyLines = value === "" ? 0 : value.split("\n").length;
    // Closed: the last line is a closer mdast left out of the body (a
    // closer-shaped line indented as body text stays in it). A one-line
    // fence has no body line to leave out, so it is never closed. A closed
    // fence's value holds the lines between the markers, never one more:
    // trailing blank lines count, and a lone blank line is '' (0 < 2).
    const closed =
      closer !== null &&
      group(closer, 1).startsWith(group(marker, 1).charAt(0)) &&
      group(closer, 1).length >= group(marker, 1).length &&
      bodyLines !== last - n;
    // Unclosed, a fence runs to the end of its container: the document's
    // last line, or the line before mdast's end when that is a line start.
    let close = last;
    if (!closed && parent.type === "root") close = lines.length;
    else if (!closed && end.column === 1) close = last - 1;
    const body: { n: number; text: string }[] = [];
    for (let at = n + 1; at <= (closed ? close - 1 : close); at += 1) {
      body.push({ n: at, text: inner(at) });
    }
    for (let at = n; at <= close; at += 1) inFence[at] = true;
    fences.push({
      open: n,
      close,
      lang: (node.lang ?? "").toLowerCase(),
      body,
    });
  };
  const visit = (node: MdNode, parent: MdNode, quotes: number): void => {
    if (node.type === "code") readFence(node, parent, quotes);
    const inner = quotes + (node.type === "blockquote" ? 1 : 0);
    for (const child of node.children ?? []) visit(child, node, inner);
  };
  // A lone CR is a line ending to CommonMark but not to `lines`: it is read
  // as a space.
  const root: MdNode = fromMarkdown(
    lines.slice(offset).join("\n").replaceAll("\r", " "),
  );
  visit(root, root, 0);
  return { lines, fences, inFence };
};

const SCRIPT_LANGS = new Set(["sh", "bash", "zsh", "shell"]);
const TRANSCRIPT_LANGS = new Set([
  "",
  "text",
  "txt",
  "console",
  "shell-session",
  "output",
  "log",
  "plaintext",
]);

/**
 * A fence by its info string: `script` (`sh`, `bash`, …) is commands to run,
 * every line; `transcript` (none, `text`, `console`, …) has `$ ` command
 * lines and what they printed; `source` (`ts`, `json`, …) quotes a file.
 */
export const fenceKind = (
  fence: Pick<Fence, "lang">,
): "script" | "transcript" | "source" => {
  if (SCRIPT_LANGS.has(fence.lang)) return "script";
  return TRANSCRIPT_LANGS.has(fence.lang) ? "transcript" : "source";
};
