// `dvara trailers <commit-msg-file>`, for a commit-msg hook. Git reads a
// message's trailers (Co-Authored-By, Signed-off-by, a repository's own) only
// from its last paragraph. A trailer line above a blank line is prose to git:
// the commit lands, and the trailer is silently not there. This finds such
// lines, so the hook can refuse the commit before that happens.

/** The keys git and its hosts use themselves; a repository adds its own in `trailerKeys`. */
export const GIT_TRAILER_KEYS: readonly string[] = [
  "Co-Authored-By",
  "Signed-off-by",
];

/**
 * Git's scissors line, with its default comment character: everything below
 * it (the diff `commit -v` shows) is not the message.
 */
const SCISSORS = "# ------------------------ >8 ------------------------";

/** A trailer key, as git reads one: letters, digits and `-`, then a colon. */
const KEY = /^([A-Za-z0-9-]+)[ \t]*:/;

export interface Misplaced {
  /** 1-based, in the file as written. */
  readonly line: number;
  readonly text: string;
}

/**
 * The lines in `message` whose key is one of `keys` (any case) and that sit
 * in a paragraph before the last, or in the title's paragraph (the title line
 * aside), which git never reads trailers from. Comment lines are dropped, as git drops
 * them, so a comment neither splits a paragraph nor ends one; blank lines
 * (whitespace only) separate paragraphs; trailing ones start no new one.
 */
export const misplacedTrailers = (
  message: string,
  keys: readonly string[],
): Misplaced[] => {
  const known = new Set(keys.map((key) => key.toLowerCase()));
  const paragraphs: Misplaced[][] = [];
  let open: Misplaced[] | null = null;
  for (const [i, text] of message.split(/\r?\n/).entries()) {
    if (text === SCISSORS) break;
    if (text.startsWith("#")) continue;
    if (text.trim() === "") {
      open = null;
      continue;
    }
    if (open === null) {
      open = [];
      paragraphs.push(open);
    }
    open.push({ line: i + 1, text });
  }
  // Git reads no trailers from the title's paragraph either, so a message of
  // one paragraph keeps none; the title line itself is never a trailer.
  const unread = paragraphs.length > 1 ? paragraphs.slice(0, -1) : paragraphs;
  return unread
    .flat()
    .slice(1)
    .filter(({ text }) => {
      const key = KEY.exec(text)?.[1];
      return key !== undefined && known.has(key.toLowerCase());
    });
};

export const ADVICE =
  "Git reads trailers only from the last paragraph. Move these lines into the final block with no blank line between them (one `-F <file>` message), then check with `git log -1 --format=%(trailers)`.";

/** The refusal for `misplaced` lines of `file`, one line per entry. */
export const refusal = (
  file: string,
  misplaced: readonly Misplaced[],
): string[] => [
  `❌ trailers: ${file} has trailer lines git does not read (above a blank line, or in the title's paragraph):`,
  ...misplaced.map(({ line, text }) => `  ${file}:${line} ${text}`),
  ADVICE,
];
