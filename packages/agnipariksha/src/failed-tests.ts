/**
 * The tests Stryker names when its initial test run fails. Stryker logs them
 * before its one-line reason, as one record:
 *
 *   12:00:01 (4242) ERROR DryRunExecutor One or more tests failed in the initial test run:
 *   \t<test name>
 *   \t\t<failure message>
 *
 * The gate reads them line by line from the output it tees, so its own line
 * can name the test instead of only Stryker's exit.
 */

export const FAILED_TESTS_HEADER = 'One or more tests failed in the initial test run:';
/** A run keeps at most this many names; a suite failing wholesale needs no more to be found. */
export const MAX_KEPT = 50;
/** A line names at most this many tests, then says how many more. */
export const MAX_NAMED = 5;

// Stryker colours a record's prefix when its output is a terminal.
const ANSI = new RegExp(String.raw`\u001B\[[0-9;]*m`, 'g');
/** The prefix of every Stryker log record: time, (pid), level, category. */
const LOG_RECORD = /^\d\d:\d\d:\d\d \(\d+\) [A-Z]+ /;
const TEST_NAME = /^\t[^\t].*$/;

export interface FailedTestReader {
  /** One line of Stryker's output, without its newline. */
  read: (line: string) => void;
  /** The names read so far, each once, in the order Stryker gave them. */
  names: () => string[];
}

export function failedTestReader(): FailedTestReader {
  const names: string[] = [];
  let inside = false;
  return {
    read: (raw) => {
      const line = raw.replace(ANSI, '').replace(/\r$/, '');
      if (line.includes(FAILED_TESTS_HEADER)) {
        inside = true;
        return;
      }
      if (!inside) return;
      if (LOG_RECORD.test(line)) {
        inside = false;
        return;
      }
      if (!TEST_NAME.test(line)) return;
      // The name is the line past its one tab; trimming drops that tab too.
      const name = line.trim();
      if (name !== '' && !names.includes(name) && names.length < MAX_KEPT) names.push(name);
    },
    names: () => [...names],
  };
}

/** `"a"`, `"a" and "b"`, or the first `MAX_NAMED` and how many more; '' for none. */
export function nameTests(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED).map((name) => JSON.stringify(name));
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  const last = shown.pop() ?? '';
  return shown.length === 0 ? last : `${shown.join(', ')} and ${last}`;
}
