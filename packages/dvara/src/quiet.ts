// Quiet on success. A passing commit hook that prints thirty lines of progress
// costs an agent session those lines on every later request, and says nothing
// one line cannot. The supervisor holds a quiet hook's output: on failure it is
// shown in full; on success it becomes the hook's warnings plus one summary
// line, and the full output is kept in a log. DVARA_VERBOSE=1 streams it.

/** Whether this run's output is held rather than streamed. */
export const isQuiet = (
  kind: string,
  quietHooks: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean => quietHooks.includes(kind) && env.DVARA_VERBOSE !== "1";

/**
 * The warnings a passing run still shows: each line starting with ⚠ and the
 * indented lines that continue it. A warning qualifies a pass; hiding it would
 * turn the pass into an unqualified one.
 */
export const successNotices = (text: string): string[] => {
  const kept: string[] = [];
  let inNotice = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("⚠")) {
      inNotice = true;
      kept.push(line);
    } else if (inNotice && /^\s+\S/.test(line)) {
      kept.push(line);
    } else {
      inNotice = false;
    }
  }
  return kept;
};

/** The one line a passing quiet run prints. */
export const successLine = (
  kind: string,
  durationMs: number,
  logPath: string,
): string =>
  `✅ ${kind} passed in ${(durationMs / 1000).toFixed(1)}s (full output: ${logPath})`;
