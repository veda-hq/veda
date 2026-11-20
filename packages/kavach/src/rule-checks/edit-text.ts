/**
 * The text a file-writing tool call proposes: what an edit-time check judges
 * before the tool runs.
 */

/**
 * The file's text once the tool has run: a Write's content; an Edit applied to
 * `current`. An Edit whose old text is not in the file fails anyway, so its
 * new text is judged beside the current file.
 */
export function afterEdit(tool: string, given: Readonly<Record<string, unknown>>, current: string | null): string {
  const text = (key: string): string => {
    const value = given[key];
    return typeof value === 'string' ? value : '';
  };
  if (tool === 'Write') return text('content');
  const before = current ?? '';
  const old = text('old_string');
  const next = text('new_string');
  if (old === '' || !before.includes(old)) return `${before}\n${next}`;
  return given['replace_all'] === true ? before.split(old).join(next) : before.replace(old, () => next);
}
