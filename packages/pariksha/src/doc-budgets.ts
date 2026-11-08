// The doc-budgets check: documents that agents read on every turn stay inside
// a byte budget. The budgets live in one Markdown table, so the rule that sets
// them is also the only list of them:
//
//   ## Budgets
//
//   | Doc         | Budget |
//   | ----------- | -----: |
//   | `CLAUDE.md` | 9,000  |

export interface Budget {
  readonly path: string;
  readonly bytes: number;
}

/** The text of the `## <section>` section, up to the next `## ` heading; '' when absent. */
export const section = (markdown: string, name: string): string => {
  const start = markdown.indexOf(`\n## ${name}\n`);
  if (start === -1) return '';
  const end = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, end === -1 ? undefined : end);
};

/** Table lines after the header row and its `| --- |` separator. */
export const dataRows = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(1)
    .filter((line) => !/^\|\s*-/.test(line));

/** Rows of the form "| `path` | 1,200 |". */
export const parseBudgets = (text: string): Budget[] =>
  [...text.matchAll(/^\|\s*`([^`]+)`\s*\|\s*([\d,]+)\s*\|$/gm)].map(([, path = '', bytes = '']) => ({
    path,
    bytes: Number(bytes.replaceAll(',', '')),
  }));

export interface Outcome {
  readonly ok: boolean;
  readonly out: string[];
  readonly err: string[];
}

/**
 * Every budget row is well formed, and every file it names is within budget.
 * `size` returns a file's byte length, or undefined when it does not exist.
 */
export const checkBudgets = (
  table: string,
  sectionName: string,
  tablePath: string,
  size: (path: string) => number | undefined,
): Outcome => {
  const text = section(table, sectionName);
  const budgets = parseBudgets(text);
  const rows = dataRows(text);
  const err: string[] = [];
  if (rows.length === 0) err.push(`pariksha doc-budgets: ${tablePath} has no table under "## ${sectionName}"`);
  else if (budgets.length !== rows.length)
    err.push(
      `pariksha doc-budgets: ${tablePath}: ${rows.length - budgets.length} row(s) under "## ${sectionName}" are not "| \`path\` | bytes |", so nothing enforces them`,
    );
  const out: string[] = [];
  for (const b of budgets) {
    const bytes = size(b.path);
    if (bytes === undefined) err.push(`pariksha doc-budgets: ${b.path} has a budget but does not exist`);
    else if (bytes > b.bytes) err.push(`pariksha doc-budgets: ${b.path} is ${bytes} bytes, over its budget of ${b.bytes}; cut it`);
    else out.push(`pariksha doc-budgets: ${b.path} ${bytes} / ${b.bytes} bytes`);
  }
  return { ok: err.length === 0, out, err };
};
