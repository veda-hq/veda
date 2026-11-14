/**
 * PreToolUse and PostToolUseFailure handler: shows a lesson at the moment it
 * matters.
 *
 * A lesson doc (Markdown) marks a lesson that has a moment with a line at the
 * lesson's end, so the text and its trigger live in one place:
 *
 *   <!-- when: error "all predefined address pools have been fully subnetted" -->
 *   <!-- when: command "git push \S+ \S+:refs/heads/" -->
 *   <!-- when: path "apps/server/prisma/schema.prisma" -->
 *   <!-- when: tool "Agent|Task" input "\x22subagent_type\x22:\x22general-purpose\x22" -->
 *   <!-- when: content "DROP DATABASE" path "**\/*.test.*" -->
 *
 * - `error`: plain text, found in a failed tool call's `error`
 *   (PostToolUseFailure), ignoring case and runs of whitespace.
 * - `command`: a JavaScript regular expression, tested against a Bash call's
 *   command before it runs.
 * - `path`: a glob, matched against an Edit or Write call's file, relative to
 *   the session's checkout: `*` and `?` within one path segment, `**` across
 *   segments.
 * - `tool`: a regular expression for the whole tool name, before any call the
 *   hook is routed (PreToolUse). An optional `input "<regex>"` must also
 *   match the call's input as JSON, so the line fires on one use of a tool.
 * - `content`: a regular expression, tested against the text an Edit or Write
 *   puts in its file (`new_string`, or `content`), and only for files its
 *   required `path "<glob>"` matches, so it stays off unrelated edits.
 *
 * Patterns are written between double quotes and do not contain one; write
 * `\x22` for a quote inside a regular expression.
 *
 * The lesson unit is the one a "lessons nothing holds" counter reads (a lesson
 * with neither a `when` line nor a `held by` line), so a lesson with a `when`
 * line is never counted as unheld. In every `.md` file but README.md: a `### `
 * section is one lesson, bullets inside it included, up to the next heading of
 * any level; outside one, a column-0 `- ` bullet is one lesson with its
 * indented lines and any column-0 `<!--` lines, up to a column-0 paragraph. A
 * `when` line in neither is a stray, reported by `docProblems`. Lines in fenced
 * code are never headings, bullets or `when` lines. A lesson's id is its file
 * and the slug of its heading or bold lead (`**Title.**`; else the bullet's
 * first 60 characters), so it survives edits to the text around it.
 *
 * The handler adds each matching lesson to Claude's context
 * (`additionalContext`), at most once per session, and appends one log row per
 * match: `shown`, or `repeat` when this session was shown it already. It never
 * blocks: on any doubt it prints nothing and exits 0. With no match it makes no
 * git call and writes nothing.
 *
 * Log, the shared state: `<git common dir>/sarathi/lessons/<session>.jsonl`
 * (`SARATHI_LESSONS_DIR` overrides the folder), one JSON row per match.
 * - Ordering: nothing waits on the file. Two matches of one lesson racing in
 *   one session can both show it, which costs one repeated lesson.
 * - Failure cleanup: a short append leaves a partial line, which the next
 *   append's leading newline ends; readers skip blank and partial lines. The
 *   lesson is still shown.
 * - Overlap: one file per session, appended whole rows at a time (O_APPEND).
 * - Input validity: the session id must match SESSION before it names a file;
 *   without one every match shows and logs to `no-session.jsonl`.
 *
 * Lessons are read from the package's own `lessons/` folder (veda's
 * `docs/lessons/`, copied at build) and from each folder named as an argument;
 * a missing folder is skipped.
 *
 * Run: node <sarathi>/dist/hooks/lessons.js [<lesson folder>...]
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Kind = 'error' | 'command' | 'path' | 'tool' | 'content';

/** The qualifier each kind takes: `tool` an optional `input`, `content` a required `path`. */
export type Qualifier = 'input' | 'path';

export interface Trigger {
  readonly kind: Kind;
  /** The text between the quotes. */
  readonly pattern: string;
  /** The `when` line's 1-based line number, for messages. */
  readonly line: number;
  /** A second clause, `input "<regex>"` or `path "<glob>"`, when the line has one. */
  readonly scope?: { readonly qualifier: Qualifier; readonly pattern: string };
}

/** What an event offers a trigger of one kind: the text it is tested on, and the text its scope is. */
export interface Subject {
  readonly text: string;
  readonly scope?: string;
}

export interface Lesson {
  /** `<file>#<slug>`: stable while the lesson's title stays. */
  readonly id: string;
  /** The file's name, as the lesson is cited. */
  readonly file: string;
  /** The bold lead or heading, without Markdown. */
  readonly title: string;
  /** The lesson's Markdown, its `when` lines left out. */
  readonly text: string;
  readonly triggers: readonly Trigger[];
}

export interface ToolEvent {
  readonly hook_event_name?: unknown;
  readonly session_id?: unknown;
  readonly cwd?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly error?: unknown;
  readonly is_interrupt?: unknown;
}

/** One lesson's text in context is capped: a lesson is a bullet or a short section. */
export const TEXT_MAX = 2000;
export const EXCERPT_MAX = 120;
const WHEN = /^<!--\s*when:\s*(error|command|path|tool|content)\s+"(.*?)"(?:\s+(input|path)\s+"(.*)")?\s*-->$/;
/** Marker lines a lesson's text leaves out: `when` lines and L-01's `held by` lines. */
const MARKER_LINE = /^<!--\s*(when|held by):.*-->$/;
const MARKER = '<!-- when:';
const BULLET = /^- /;
const FENCE = /^\s*```/;
const BOLD_LEAD = /^-\s+\*\*(.+?)\*\*/;
const SESSION = /^[\w.-]{1,128}$/;

/** GitHub's anchor for a title: lower case, punctuation dropped, spaces to hyphens. */
export function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function plain(markdown: string): string {
  return markdown.replace(/[*_`]/g, '').replace(/[.:]\s*$/, '').trim();
}

export interface Doc {
  readonly lessons: Lesson[];
  /** `when` lines outside any lesson: `<file>:<line>`. */
  readonly strays: string[];
}

/** The lessons with a `when` line in one doc's text, and the `when` lines outside any lesson. */
export function parseDoc(text: string, file: string): Doc {
  if (!text.includes(MARKER)) return { lessons: [], strays: [] };
  const lines = text.split('\n');
  const units = new Map<number, { end: number; title: string; triggers: Trigger[] }>();
  const strays: string[] = [];
  const markers = new Set<number>();
  let fenced = false;
  let section = -1;
  let item = -1;
  let unit: { start: number; end: number; title: string } | undefined;
  const closeAt = (index: number): void => {
    if (unit !== undefined) {
      const found = units.get(unit.start);
      if (found !== undefined) found.end = index;
    }
    unit = undefined;
  };
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (FENCE.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    if (raw.startsWith('#')) {
      closeAt(index);
      item = -1;
      section = raw.startsWith('### ') ? index : -1;
      if (section >= 0) unit = { start: index, end: lines.length, title: plain(raw.slice(4)) };
      return;
    }
    if (section < 0 && BULLET.test(raw)) {
      closeAt(index);
      item = index;
      unit = { start: index, end: lines.length, title: plain(BOLD_LEAD.exec(raw)?.[1] ?? raw.slice(2, 62)) };
      return;
    }
    // A column-0 paragraph ends a bullet; a column-0 marker line stays in it.
    if (section < 0 && /^\S/.test(raw) && !raw.startsWith('<!--')) {
      closeAt(index);
      item = -1;
    }
    if (MARKER_LINE.test(line)) markers.add(index);
    const when = WHEN.exec(line);
    if (when === null) return;
    const scope = when[3] === undefined ? {} : { scope: { qualifier: when[3] as Qualifier, pattern: when[4] ?? '' } };
    const trigger: Trigger = { kind: when[1] as Kind, pattern: when[2] ?? '', line: index + 1, ...scope };
    if (unit === undefined || (section < 0 && item < 0)) {
      strays.push(`${file}:${index + 1}`);
      return;
    }
    const found = units.get(unit.start) ?? { end: lines.length, title: unit.title, triggers: [] };
    found.triggers.push(trigger);
    units.set(unit.start, found);
  });
  closeAt(lines.length);
  const lessons = [...units.entries()].map(([start, found]) => {
    const body = lines
      .slice(start, found.end)
      .filter((_, offset) => !markers.has(start + offset))
      .join('\n')
      .trim();
    const title = found.title === '' ? file : found.title;
    return {
      id: `${file}#${slug(title)}`,
      file,
      title,
      text: body.length <= TEXT_MAX ? body : `${body.slice(0, TEXT_MAX - 1)}…`,
      triggers: found.triggers,
    };
  });
  return { lessons, strays };
}

/** The lessons with a `when` line in one doc's text. */
export function parseLessons(text: string, file: string): Lesson[] {
  return parseDoc(text, file).lessons;
}

/** Every `.md` file of the folders that exist, parsed, in folder then name order. */
export function loadDocs(dirs: readonly string[]): Doc[] {
  const docs: Doc[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter(name => name.endsWith('.md') && name !== 'README.md')
        .sort();
    } catch {
      // fail-open: a folder that cannot be listed holds no lesson this call can show
      continue;
    }
    for (const name of names) {
      try {
        docs.push(parseDoc(readFileSync(join(dir, name), 'utf8'), name));
      } catch {
        // fail-open: an unreadable file holds no lesson this call can show
      }
    }
  }
  return docs;
}

/** The lessons in every `.md` file of the folders that exist. */
export function loadLessons(dirs: readonly string[]): Lesson[] {
  return loadDocs(dirs).flatMap(doc => doc.lessons);
}

/** What is wrong with the folders' `when` lines: strays outside a lesson, and patterns that never fire. */
export function docProblems(dirs: readonly string[]): string[] {
  const docs = loadDocs(dirs);
  const lessons = docs.flatMap(doc => doc.lessons);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const lesson of lessons) (seen.has(lesson.id) ? duplicates : seen).add(lesson.id);
  return [
    ...docs.flatMap(doc => doc.strays.map(where => `${where}: a when line outside a lesson (a ### section, or a column-0 bullet)`)),
    ...[...duplicates].map(id => `${id}: two lessons with a when line share this id, so only the first can show`),
    ...triggerProblems(lessons),
  ];
}

/** A glob as a regular expression over a `/`-separated relative path. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? '';
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The qualifier a kind takes, and whether it must have it. */
const QUALIFIERS: Readonly<Record<Kind, { qualifier?: Qualifier; required: boolean }>> = {
  error: { required: false },
  command: { required: false },
  path: { required: false },
  tool: { qualifier: 'input', required: false },
  content: { qualifier: 'path', required: true },
};

/** Is the trigger's scope the one its kind takes (present when required, absent when none)? */
function scopeFits(trigger: Trigger): boolean {
  const rule = QUALIFIERS[trigger.kind];
  if (trigger.scope === undefined) return !rule.required;
  return trigger.scope.qualifier === rule.qualifier && trigger.scope.pattern !== '';
}

/**
 * Does `trigger` fire on `subject`: a string (an error, a command, a path,
 * a tool name, a file's new text) or a Subject with the scope text too? A
 * pattern that does not compile never fires; a scope a trigger needs and the
 * subject lacks never matches.
 */
export function fires(trigger: Trigger, subject: string | Subject): boolean {
  const { text, scope } = typeof subject === 'string' ? { text: subject, scope: undefined } : subject;
  if (trigger.pattern === '' || !scopeFits(trigger)) return false;
  try {
    if (trigger.kind === 'error') return squash(text).includes(squash(trigger.pattern));
    if (trigger.kind === 'command') return new RegExp(trigger.pattern).test(text);
    if (trigger.kind === 'path') return globToRegExp(trigger.pattern).test(text);
    if (trigger.kind === 'tool') {
      if (!new RegExp(`^(?:${trigger.pattern})$`).test(text)) return false;
      return trigger.scope === undefined || (scope !== undefined && new RegExp(trigger.scope.pattern).test(scope));
    }
    return scope !== undefined && globToRegExp(trigger.scope?.pattern ?? '').test(scope) && new RegExp(trigger.pattern).test(text);
  } catch {
    // fail-open: a pattern that does not compile never fires; triggerProblems reports it
    return false;
  }
}

/** Problems with the `when` lines: an empty pattern, one that does not compile, or a missing or wrong qualifier. */
export function triggerProblems(lessons: readonly Lesson[]): string[] {
  const problems: string[] = [];
  for (const lesson of lessons) {
    for (const trigger of lesson.triggers) {
      const where = `${lesson.file}:${trigger.line}`;
      if (trigger.pattern.trim() === '') {
        problems.push(`${where}: an empty ${trigger.kind} pattern never fires`);
        continue;
      }
      if (!scopeFits(trigger)) {
        const rule = QUALIFIERS[trigger.kind];
        const wanted = rule.qualifier === undefined ? 'no second clause' : `${rule.required ? 'a' : 'an optional'} ${rule.qualifier} "…"`;
        problems.push(`${where}: a ${trigger.kind} line takes ${wanted}, so it never fires`);
        continue;
      }
      const regexes = [
        ...(trigger.kind === 'command' || trigger.kind === 'tool' || trigger.kind === 'content' ? [trigger.pattern] : []),
        ...(trigger.scope?.qualifier === 'input' ? [trigger.scope.pattern] : []),
      ];
      for (const pattern of regexes) {
        try {
          new RegExp(pattern);
        } catch (error) {
          // fail-open: the problem is returned to the caller, not thrown
          problems.push(`${where}: "${pattern}" is not a regular expression (${(error as Error).message})`);
        }
      }
    }
  }
  return problems;
}

/** The checkout holding `start` and its git common dir, found on disk with no git call; `undefined` outside git. */
export function gitPlaces(start: string): { root: string; common: string } | undefined {
  let dir = resolve(start);
  for (;;) {
    const dotGit = join(dir, '.git');
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return { root: dir, common: dotGit };
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      if (pointer === undefined) return undefined;
      const gitDir = resolve(dir, pointer);
      const commonFile = join(gitDir, 'commondir');
      const common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
      return { root: dir, common };
    } catch {
      // fail-open: no readable .git here, so look in the parent
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

/** The trigger kind an event can fire: an error after a failed call, a command before Bash, a path before Edit or Write. */
export function kindOf(event: ToolEvent): Kind | undefined {
  if (event.hook_event_name === 'PostToolUseFailure') return event.is_interrupt === true ? undefined : 'error';
  if (event.hook_event_name !== 'PreToolUse') return undefined;
  if (event.tool_name === 'Bash') return 'command';
  return event.tool_name === 'Edit' || event.tool_name === 'Write' ? 'path' : undefined;
}

/** Every trigger kind an event can fire: its `kindOf`, a `tool` before any call, and `content` before Edit or Write. */
export function kindsOf(event: ToolEvent): Kind[] {
  const kind = kindOf(event);
  if (event.hook_event_name !== 'PreToolUse' || typeof event.tool_name !== 'string' || event.tool_name === '') return kind === undefined ? [] : [kind];
  return [...(kind === undefined ? [] : [kind]), ...(kind === 'path' ? (['content'] as const) : []), 'tool'];
}

/** The text an Edit or Write puts in its file: `new_string`, `content`, or a MultiEdit's `edits`. */
function newText(input: Record<string, unknown>): string | undefined {
  if (typeof input.new_string === 'string') return input.new_string;
  if (typeof input.content === 'string') return input.content;
  if (!Array.isArray(input.edits)) return undefined;
  const parts = input.edits.map((edit: unknown) => (typeof edit === 'object' && edit !== null ? (edit as Record<string, unknown>).new_string : undefined));
  return parts.every(part => typeof part === 'string') ? parts.join('\n') : undefined;
}

/** What an event offers a trigger of `kind`: its text and, for `tool` and `content`, the text a scope is tested on. */
export function eventSubject(event: ToolEvent, kind: Kind): Subject | undefined {
  const input = typeof event.tool_input === 'object' && event.tool_input !== null ? (event.tool_input as Record<string, unknown>) : {};
  if (kind === 'tool') return typeof event.tool_name === 'string' ? { text: event.tool_name, scope: JSON.stringify(input) } : undefined;
  if (kind !== 'content') {
    const text = subjectOf(event, kind);
    return text === undefined ? undefined : { text };
  }
  const path = subjectOf(event, 'path');
  const text = newText(input);
  return path === undefined || text === undefined ? undefined : { text, scope: path };
}

/** The text an event's triggers are tested against, for its kind; `undefined` when it has none. */
export function subjectOf(event: ToolEvent, kind: Kind): string | undefined {
  const input = typeof event.tool_input === 'object' && event.tool_input !== null ? (event.tool_input as Record<string, unknown>) : {};
  if (kind === 'error') return typeof event.error === 'string' ? event.error : undefined;
  if (kind === 'command') return typeof input.command === 'string' ? input.command : undefined;
  if (kind === 'tool' || kind === 'content') return eventSubject(event, kind)?.text;
  const file = input.file_path;
  if (typeof file !== 'string' || file === '') return undefined;
  const cwd = typeof event.cwd === 'string' && event.cwd !== '' ? event.cwd : process.cwd();
  const absolute = isAbsolute(file) ? file : resolve(cwd, file);
  const root = gitPlaces(cwd)?.root ?? cwd;
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/** The folder the log lives in. */
export function logDir(event: ToolEvent, env: Readonly<Record<string, string | undefined>>): string {
  const override = env.SARATHI_LESSONS_DIR;
  if (override !== undefined && override !== '') return override;
  const cwd = typeof event.cwd === 'string' && event.cwd !== '' ? event.cwd : process.cwd();
  const common = gitPlaces(cwd)?.common;
  if (common !== undefined) return join(common, 'sarathi', 'lessons');
  const state = env.XDG_STATE_HOME;
  return join(state !== undefined && state !== '' ? state : join(homedir(), '.local', 'state'), 'sarathi', 'lessons');
}

export interface Row {
  readonly ts: string;
  readonly session: string;
  readonly event: string;
  readonly tool: string;
  readonly kind: Kind;
  readonly lesson: string;
  readonly outcome: 'shown' | 'repeat';
  readonly excerpt: string;
}

function clip(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length <= EXCERPT_MAX ? line : `${line.slice(0, EXCERPT_MAX - 1)}…`;
}

/** The lesson ids this session's log says were shown. */
export function shownIn(file: string): Set<string> {
  const shown = new Set<string>();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // fail-open: no log yet means nothing was shown this session
    return shown;
  }
  for (const line of text.split('\n')) {
    try {
      const row = JSON.parse(line) as Partial<Row>;
      if (row.outcome === 'shown' && typeof row.lesson === 'string') shown.add(row.lesson);
    } catch {
      // fail-open: a blank line, or a partial one from a short append, records nothing
    }
  }
  return shown;
}

export interface Deps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  /** Folders to read lessons from, the package's own first. */
  readonly dirs: readonly string[];
}

/** The package's own lessons folder: veda's `docs/lessons/`, copied in at build. */
export function packagedLessons(): string {
  return fileURLToPath(new URL('../../lessons', import.meta.url));
}

function render(lesson: Lesson): string {
  return `Lesson for this moment (${lesson.file}, "${lesson.title}"; shown once per session):\n${lesson.text}`;
}

/** The hook's whole answer for one raw stdin: the JSON to print, or '' for none. Never throws. */
export function respond(raw: string, deps: Deps): string {
  try {
    const event = JSON.parse(raw) as ToolEvent;
    const kinds = kindsOf(event);
    if (kinds.length === 0) return '';
    const candidates = loadLessons(deps.dirs).filter(lesson => lesson.triggers.some(trigger => kinds.includes(trigger.kind)));
    if (candidates.length === 0) return '';
    const subjects = new Map<Kind, Subject>();
    for (const kind of kinds) {
      const subject = eventSubject(event, kind);
      if (subject !== undefined) subjects.set(kind, subject);
    }
    const matchOf = (lesson: Lesson): { kind: Kind; subject: Subject } | undefined => {
      for (const trigger of lesson.triggers) {
        const subject = subjects.get(trigger.kind);
        if (subject !== undefined && fires(trigger, subject)) return { kind: trigger.kind, subject };
      }
      return undefined;
    };
    const matched = candidates.flatMap(lesson => {
      const match = matchOf(lesson);
      return match === undefined ? [] : [{ lesson, ...match }];
    });
    if (matched.length === 0) return '';
    const unique = [...new Map(matched.map(match => [match.lesson.id, match])).values()];
    const session = typeof event.session_id === 'string' && SESSION.test(event.session_id) ? event.session_id : undefined;
    const dir = logDir(event, deps.env);
    const file = join(dir, `${session ?? 'no-session'}.jsonl`);
    const seen = session === undefined ? new Set<string>() : shownIn(file);
    const fresh = unique.filter(match => !seen.has(match.lesson.id)).map(match => match.lesson);
    const ts = deps.now().toISOString();
    const rows = unique.map(({ lesson, kind, subject }) => ({
      ts,
      session: session ?? '',
      event: String(event.hook_event_name),
      tool: typeof event.tool_name === 'string' ? event.tool_name : '',
      kind,
      lesson: lesson.id,
      outcome: seen.has(lesson.id) ? 'repeat' : 'shown',
      // A tool or content match is cited by what it matched on: the call's input, or the file.
      excerpt: clip(kind === 'tool' || kind === 'content' ? `${subject.text} ${subject.scope ?? ''}` : subject.text),
    }));
    try {
      mkdirSync(dir, { recursive: true });
      // One write of whole rows; the leading newline ends any partial row a short append left.
      appendFileSync(file, `\n${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    } catch {
      // fail-open: the lesson still shows when its row cannot be written
    }
    if (fresh.length === 0) return '';
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: fresh.map(render).join('\n\n') },
    });
  } catch {
    // fail-open: a lesson is advice; on any doubt the call goes ahead with none
    return '';
  }
}

async function main(): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  const extra = process.argv.slice(2).filter(arg => arg !== '');
  process.stdout.write(respond(raw, { env: process.env, now: () => new Date(), dirs: [packagedLessons(), ...extra] }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
