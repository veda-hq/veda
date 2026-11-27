// EVIDENCE-01: where `identityPaths` match, a commit is cited by its full
// 40-hex id, and that id is a commit of this repository.
//
// An abbreviation is ambiguous by design: git lengthens it as history grows
// and clones disagree on its length, so a record that cites `303d6a0be` stops
// naming one commit. Refused:
// - a 7–39 hex token the line makes a commit: backticked on its own, after a
//   commit word (commit, sha, merged, HEAD, main, push, …), in an `a..b`
//   range, or cut off with an ellipsis, unless the line names it another
//   kind of hash (digest, sha256, fingerprint, key, …);
// - a git command that prints abbreviations (`--oneline`, `%h`,
//   `--abbrev-commit`, `rev-parse --short`);
// - a 40-hex id cited as a commit that is not one in this repository, among
//   those the change adds (compared with the ids the file cited at the merge
//   base). No baseline holds these: they are new by construction;
// - among those same added ids, a commit this clone has that is on no pushed
//   history: neither HEAD nor a base ref reaches it, so a CI clone, which
//   fetches only those, does not have it. A shallow clone cannot tell where
//   a commit stands (its walk stops at the cut), so it judges none, as before.
//
// Captured output inside a fence is exempt from the token rule; its command
// line is not.
import type { RecordsConfig } from "../config.ts";
import { fenceKind, group, parseMarkdown } from "./markdown.ts";
import type { Finding, Rule } from "./types.ts";

// Hex is read in either case: git accepts `ABC1234` as readily as `abc1234`.
const SHORT = /(?<![\w./=?#-])[0-9a-f]{7,39}(?![\w-])/gi;
/**
 * The right endpoint of an `a..b` or `a...b` range. The left one is an id or
 * a ref (`main`, `origin/main`, `HEAD~2`, `v1.2`, `HEAD^`): a ref's dots
 * never run into the range's own. A match may start after any `/`, `.`, `~`
 * or `^` of the ref, so it reads only the ref's last word and a bare `~` or
 * `^` after it. Bounded, as the windows below are: a page's line of
 * megabytes is not a ref.
 */
const RANGE_RIGHT =
  /(?<![\w-])[\w-]{1,64}[~^]{0,4}\.{2,3}([0-9a-f]{7,40})(?![\w-])/gi;
const FULL = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/gi;
const TEST_MERGE =
  /(?<![0-9a-f])([0-9a-f]{40})(?::refs\/(?:remotes\/)?| +-> +(?:refs\/(?:remotes\/)?)?)pull\/\d+\/merge\b/gi;

const COMMIT_WORD =
  /(?<![\w-])(commits?|committed|sha1?|head|main|merged?|merges|push(ed)?|revert(ed)?|cherry-pick(ed)?|resolved-by|rebased?|checkout|checked out|built from|landed|shipped|fix(ed)? in|tip)\b|"(sha|commit|head|base|merge)"\s*:/i;
const OTHER_HASH =
  /\b(sha-?256|sha-?512|md5|digests?|fingerprints?|checksums?|etags?|hash(es)?|keys?|nonces?|uuids?|run[- ]?ids?|versions?|state[- ]list)\b/i;
/** Turbo prints 16-hex task hashes: `cache miss, executing 40896a8f6fe567b8`. */
const TASK_HASH = /(cache (hit|miss)|executing|replaying)\W*$/i;
/** Bounded like the windows below: a command is short, a page's line is not. */
const ABBREVIATING_COMMAND =
  /\bgit\b[^\n]{0,300}?(--oneline|%h\b|--abbrev-commit|rev-parse\s+--short)/;
const DIFF_INDEX = /^\s*index\s/;
/** A shell line that a trailing backslash continues onto the next. */
const CONTINUED = /\\$/;
/** A commit word right before the token: `commit 1234567`, `sha: abcdefa`. */
const IMMEDIATE = new RegExp(`(?:${COMMIT_WORD.source})[\\s:=\`"'(]*$`, "i");
/** Raw captured output kept as a file: a log, not prose anyone edits. */
const CAPTURED = /\.(txt|log|diff|patch)$/;

const hasLetterAndDigit = (token: string): boolean =>
  /[a-f]/i.test(token) && /\d/.test(token);

const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A hex token's role on its line, for abbreviated and full ids alike:
 * `explicit` when a commit word stands right before it or it is a range end
 * or cut off; `label` when a checksum-like label (or a task hash's prefix)
 * names it; `implied` when a commit word farther back only suggests it;
 * `none` when nothing on the line names it.
 */
export const hexRole = (
  line: string,
  index: number,
  token: string,
): "explicit" | "implied" | "label" | "none" => {
  // Bounded windows: a generated HTML page is one line of megabytes, and a
  // copy of the rest of the line per token made that quadratic.
  const before = line.slice(Math.max(0, index - 48), index);
  const after = line.slice(index + token.length, index + token.length + 48);
  // A diff's `index a..b` header pairs blobs, not commits.
  const range =
    !DIFF_INDEX.test(line) &&
    (/^\.{2,3}[0-9a-f]{7,}/i.test(after) ||
      /[0-9a-f]{7,}\.{2,3}$/i.test(before));
  const cut = /^(…|\.\.\.)(?!\.)/.test(after) && !range;
  if (TASK_HASH.test(before)) return "label";
  if (range || cut || IMMEDIATE.test(before)) return "explicit";
  // A label at the token ("checksum `abc1234def`") outranks a commit word
  // farther back on the line ("the merged archive has checksum …").
  if (OTHER_HASH.test(before.slice(-20)) || OTHER_HASH.test(after.slice(0, 24)))
    return "label";
  if (COMMIT_WORD.test(before)) return "implied";
  return OTHER_HASH.test(before) ? "label" : "none";
};

/**
 * How an abbreviated token is cited as a commit: `explicit` (every hex token counts),
 * `implied` (a token needs a letter and a digit: `1234567` is a number,
 * `deadbeef` a word), or null when it is not a commit.
 */
export const citesAsCommit = (
  line: string,
  index: number,
  token: string,
): "explicit" | "implied" | null => {
  const role = hexRole(line, index, token);
  if (role === "explicit" || role === "implied") return role;
  if (role === "label") return null;
  // Sixteen hex digits with no commit word is a Turbo task hash's length.
  if (token.length === 16) return null;
  const backticked =
    line[index - 1] === "`" && line[index + token.length] === "`";
  return backticked ? "implied" : null;
};

/**
 * Lines the token rule reads: all of a data file (JSON a script wrote names
 * its commits in keys); prose and commands of Markdown; nothing of a captured
 * log, which is output exactly as the tool printed it.
 */
const readable = (
  path: string,
  text: string,
): { n: number; text: string }[] => {
  if (CAPTURED.test(path)) return [];
  const lines = text.split(/\r?\n/);
  if (!/\.mdx?$/.test(path)) {
    return lines.map((line, i) => ({ n: i + 1, text: line }));
  }
  const doc = parseMarkdown(text);
  // A script fence holds commands, every line; a transcript's `$ ` lines are
  // commands and the rest is what they printed; a source fence quotes a
  // file. A body is read as the parser unquoted it: `> $ git log` in a
  // quoted transcript is a command.
  const script = new Map<number, string>();
  const transcript = new Map<number, string>();
  for (const fence of doc.fences) {
    const kind = fenceKind(fence);
    if (kind === "source") continue;
    const into = kind === "script" ? script : transcript;
    for (const line of fence.body) into.set(line.n, line.text);
  }
  const out: { n: number; text: string }[] = [];
  // A transcript command ending in `\` goes on: its next line is the same
  // command, though it has no `$ `. The line it carries onto, once one has.
  let continued: number | undefined;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (!doc.inFence[n]) {
      out.push({ n, text: line });
      return;
    }
    const scripted = script.get(n);
    if (scripted !== undefined) {
      out.push({ n, text: scripted });
      return;
    }
    const body = transcript.get(n);
    const command =
      body !== undefined && (n === continued || /^\s*\$ /.test(body));
    if (command) out.push({ n, text: body });
    if (command && CONTINUED.test(body)) continued = n + 1;
  });
  return out;
};

/**
 * Whether a command prints abbreviated commits. `--no-abbrev-commit` after
 * `--oneline` or `--abbrev-commit` restores full ids; `%h` is abbreviated
 * whatever follows.
 */
const abbreviates = (command: string): boolean => {
  const abbreviating = ABBREVIATING_COMMAND.exec(command);
  if (abbreviating === null) return false;
  const restored =
    ["--oneline", "--abbrev-commit"].includes(group(abbreviating, 1)) &&
    !/%h\b/.test(command) &&
    /--no-abbrev(-commit)?\b/.test(
      command.slice(abbreviating.index + abbreviating[0].length),
    );
  return !restored;
};

/**
 * The lines, by index, whose command prints abbreviated commits. A command
 * is read with the lines a trailing `\` continues it onto joined in, and
 * keyed by its first line. Lines join only when adjacent in the file, so a
 * skipped line breaks the command.
 */
const abbreviatingCommands = (
  lines: readonly { n: number; text: string }[],
): Set<number> => {
  // Each command's text, joined so far, by the index of its first line.
  const commands = new Map<number, string>();
  // The command a trailing `\` leaves open, and the line that goes on with it.
  let open: { at: number; text: string; next: number } | null = null;
  lines.forEach((line, i) => {
    if (open !== null && open.next === line.n) {
      open.text = `${open.text.slice(0, -1)} ${line.text}`;
      open.next = line.n + 1;
    } else {
      open = { at: i, text: line.text, next: line.n + 1 };
    }
    commands.set(open.at, open.text);
    if (!CONTINUED.test(line.text)) open = null;
  });
  return new Set(
    [...commands].filter(([, text]) => abbreviates(text)).map(([at]) => at),
  );
};

interface Cited {
  readonly n: number;
  readonly sha: string;
  readonly asCommit: boolean;
}

/** The 40-hex ids a text cites as this repository's objects. */
const citedIds = (text: string, repository: string | null): Cited[] => {
  const cited: Cited[] = [];
  // GitHub's test merge of a pull request is fetched by id and kept by no
  // branch, so no clone resolves it once the job ends. A log that names an
  // id as that ref also prints it bare, as the checked-out head.
  const testMerges = new Set(
    [...text.matchAll(TEST_MERGE)].map((m) => group(m, 1).toLowerCase()),
  );
  const own = repository?.toLowerCase();
  text.split(/\r?\n/).forEach((line, i) => {
    for (const match of line.matchAll(FULL)) {
      const sha = match[0].toLowerCase();
      // Git's null id names the absent side of an added or deleted file.
      if (testMerges.has(sha) || /^0+$/.test(sha)) continue;
      const role = hexRole(line, match.index, match[0]);
      if (role === "label") continue;
      const before = line.slice(Math.max(0, match.index - 120), match.index);
      // Another repository's commit URL resolves on GitHub, not here; so
      // does an Actions log's downloaded action.
      const other =
        /github\.com\/([\w.-]+\/[\w.-]+)\/(commit|tree|blob)\/$/.exec(before) ??
        /Download action repository '([\w.-]+\/[\w.-]+)(?:\/[^@']*)?@[^']*' \(SHA:$/.exec(
          before,
        );
      if (other && group(other, 1).toLowerCase() !== own) continue;
      cited.push({ n: i + 1, sha, asCommit: role !== "none" });
    }
  });
  return cited;
};

/** EVIDENCE-01 under these settings: `identityPaths` and `repository`. */
export const commitIdentity = (
  records: Pick<RecordsConfig, "identityPaths" | "repository">,
): Rule => {
  const shortUrl =
    records.repository === null
      ? null
      : new RegExp(
          `github\\.com\\/${escape(records.repository)}\\/commit\\/([0-9a-f]{7,39})(?![0-9a-f])`,
          "gi",
        );
  const finding = (
    path: string,
    n: number,
    check:
      | "abbreviating-command"
      | "abbreviated-id"
      | "unresolved-id"
      | "unpushed-id",
    message: string,
  ): Finding => ({
    rule: "EVIDENCE-01",
    check,
    file: path,
    line: n,
    message,
  });
  return (path, text, tree) => {
    if (!records.identityPaths.some((p) => p.test(path))) return [];
    const found: Finding[] = [];
    const lines = readable(path, text);
    // A command continued with `\` is read whole, reported at its first line.
    const abbreviating = abbreviatingCommands(lines);
    lines.forEach(({ n, text: line }, i) => {
      if (abbreviating.has(i)) {
        found.push(
          finding(
            path,
            n,
            "abbreviating-command",
            "a git command that prints abbreviated commits (--oneline, %h, --abbrev-commit, rev-parse --short); use %H or git rev-parse",
          ),
        );
      }
      for (const match of line.matchAll(SHORT)) {
        const token = match[0];
        const cited = citesAsCommit(line, match.index, token);
        if (cited === null) continue;
        if (cited === "implied" && !hasLetterAndDigit(token)) continue;
        found.push(
          finding(
            path,
            n,
            "abbreviated-id",
            `abbreviated commit "${token}": cite the full 40-hex sha (git rev-parse ${token})`,
          ),
        );
      }
      // SHORT's boundary skips a token after `..`; a range's right endpoint
      // is a commit as surely as its left.
      for (const match of line.matchAll(RANGE_RIGHT)) {
        const token = group(match, 1);
        if (token.length === 40 || DIFF_INDEX.test(line)) continue;
        found.push(
          finding(
            path,
            n,
            "abbreviated-id",
            `abbreviated commit "${token}" ends a range: cite the full 40-hex sha (git rev-parse ${token})`,
          ),
        );
      }
      for (const match of shortUrl === null ? [] : line.matchAll(shortUrl)) {
        const token = group(match, 1);
        found.push(
          finding(
            path,
            n,
            "abbreviated-id",
            `abbreviated commit URL "${token}": link the full 40-hex sha (git rev-parse ${token})`,
          ),
        );
      }
    });
    // Full ids anywhere, fences included, but only those the change adds:
    // what a clone has differs by machine (a laptop keeps commits of deleted
    // branches, a CI clone does not), so no baseline could hold legacy ones
    // the same way everywhere. With no branch to compare, none are asked.
    const baseText = tree.baseText(path);
    if (baseText === undefined) return found;
    // Legacy means cited before in the same role: an id the base only printed
    // as an object is new again once a line calls it a commit.
    // A file the change adds (null) has none.
    const legacyAny = new Set<string>();
    const legacyCommit = new Set<string>();
    if (baseText !== null) {
      for (const { sha, asCommit } of citedIds(baseText, records.repository)) {
        legacyAny.add(sha);
        if (asCommit) legacyCommit.add(sha);
      }
    }
    const full = citedIds(text, records.repository).filter((c) =>
      c.asCommit ? !legacyCommit.has(c.sha) : !legacyAny.has(c.sha),
    );
    if (full.length === 0) return found;
    const types = tree.typesOf([...new Set(full.map((f) => f.sha))]);
    // A commit this clone has may still be one CI's clone lacks: one made
    // here and never pushed, or on a branch since deleted. Only history HEAD
    // or a base ref reaches is fetched there. Asked of every commit, however
    // the line names it: CI fails to resolve a bare id the same way.
    const commits = [...types]
      .filter(([, t]) => t === "commit")
      .map(([s]) => s);
    const history = commits.length === 0 ? null : tree.onHistory(commits);
    for (const { n, sha, asCommit } of full) {
      const type = types.get(sha);
      if (type === "commit" && history?.unreached.has(sha)) {
        const refs =
          history.refs.length === 0
            ? "a base ref (none resolves in this clone)"
            : history.refs.join(" or ");
        found.push({
          ...finding(
            path,
            n,
            "unpushed-id",
            `${sha} is not on pushed history: it is neither an ancestor of HEAD nor of ${refs}, so CI cannot resolve it. Cite a commit that is merged or on this branch.`,
          ),
          ratchet: false,
        });
        continue;
      }
      // Git prints blob and tree ids too: every object resolves, unless the
      // line names it a commit.
      if (type !== undefined && (!asCommit || type === "commit")) continue;
      found.push({
        ...finding(
          path,
          n,
          "unresolved-id",
          type === undefined
            ? `${sha} does not resolve in this repository (git cat-file -t ${sha})`
            : `${sha} is cited as a commit but is a ${type} (git cat-file -t ${sha})`,
        ),
        // New by construction, so no legacy allowance may absorb it.
        ratchet: false,
      });
    }
    return found;
  };
};
