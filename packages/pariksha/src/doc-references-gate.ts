// The doc-references gate: DOC-DRIFT-01 (paths, links, anchors, file:line),
// -02 (documented scripts and commands) and -04 (code identifiers), each
// held to a per-file baseline whose counts only fall.
//
//   staged  a commit: the index. Staged docs and comments, plus any doc
//           naming a path the commit deletes or renames. DOC-DRIFT-01, -02.
//   range   a push: the pushed tree against its merge base. Changed docs, and
//           docs naming a deleted or renamed path, a changed file by
//           `name:line`, or an identifier, script or flag the diff removed.
//           All three checks. A finding the merge base already had is legacy.
//   all     every reference file in the worktree, every check; it alone may
//           lower (`update`) or seed (`write`) the baseline.
//
// The baseline holds counts for files whose references predate the check. A
// checked file may not exceed its count; a file under its count must lower
// it in the same change; the baseline file may only lose entries or lower
// counts; an entry for a file this change removed must go.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { findCommandProblems } from './doc-command-rules.ts';
import { findIdentifierProblems, manifestObject } from './doc-identifiers.ts';
import { findLinkProblems, type LinkRunner } from './doc-links.ts';
import { findPathProblems } from './doc-paths.ts';
import type { Config } from './doc-references-config.ts';
import { applyBaseline, baselineGrowth, CHECK_IDS, createSnapshot, docKind, emptyBaseline, git, gitOrUndefined, parseBaseline, referenceFiles, serializeBaseline, takenFromMerge, type Baseline, type CheckId, type ReferenceProblem, type RepoSnapshot, type Slack } from './doc-references.ts';
import { definedScripts, findScriptProblems, scriptBodies, scriptScopes } from './doc-scripts.ts';

export type GateMode = { readonly kind: 'staged' } | { readonly kind: 'range'; readonly base: string; readonly head: string } | { readonly kind: 'all' };

export interface GateOptions {
  readonly root: string;
  readonly config: Config;
  readonly mode: GateMode;
  readonly checks: readonly CheckId[];
  readonly baseline: 'update' | 'write' | undefined;
  readonly links: LinkRunner;
}

export interface GateReport {
  /** Files the checks read. */
  readonly checked: string[];
  /** Files the change itself touched (slack there must be given up). */
  readonly changed: string[];
  readonly problems: ReferenceProblem[];
  readonly failures: ReferenceProblem[];
  readonly slack: Slack[];
  readonly growth: string[];
  /** Set when the run wrote the baseline: how many files it holds. */
  readonly wrote: number | undefined;
  readonly exitCode: 0 | 1;
}

/** Runs `checks` over `files` in `snapshot`; one finding once. */
export const runChecks = (config: Config, snapshot: RepoSnapshot, files: readonly string[], checks: readonly CheckId[], links: LinkRunner): ReferenceProblem[] => {
  const problems: ReferenceProblem[] = [];
  const read = (path: string): string | undefined => snapshot.read(path);
  if (checks.includes('DOC-DRIFT-01')) problems.push(...findPathProblems(config, snapshot, files), ...findLinkProblems(config, snapshot, files, links));
  if (checks.includes('DOC-DRIFT-02')) {
    const docs = files.filter((file) => docKind(config, file) === 'markdown');
    const { manifests } = config.scripts;
    const scripts = findScriptProblems(config, docs, definedScripts(snapshot.root, manifests, read), scriptScopes(snapshot.root, manifests, read), read);
    const commands = findCommandProblems(config, { read, exists: (path) => snapshot.files.has(path), ...scriptBodies(manifests, read) }, docs);
    for (const p of [...scripts, ...commands]) problems.push({ check: 'DOC-DRIFT-02', file: p.file, line: p.line, ref: p.script, reason: p.reason });
  }
  if (checks.includes('DOC-DRIFT-04')) problems.push(...findIdentifierProblems(config, snapshot, files));
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.check}\0${p.file}\0${p.line}\0${p.ref}\0${p.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * The failures this change introduced. A push is judged against its merge
 * base: a finding the base already had (same file, check and reference) is
 * legacy, however far it runs past the file's count, because the branch did
 * not write it. `baseOf` maps a file to its path at the base (a rename's old
 * path). Each base finding excuses one failure. With no failure the base is
 * never read.
 */
export const introducedFailures = (failures: readonly ReferenceProblem[], baseProblems: (files: string[]) => readonly ReferenceProblem[], baseOf: (file: string) => string): ReferenceProblem[] => {
  if (failures.length === 0) return [];
  const key = (file: string, p: ReferenceProblem): string => `${file}\0${p.check}\0${p.ref}`;
  const legacy = new Map<string, number>();
  for (const p of baseProblems([...new Set(failures.map((f) => baseOf(f.file)))])) legacy.set(key(p.file, p), (legacy.get(key(p.file, p)) ?? 0) + 1);
  return failures.filter((p) => {
    const k = key(baseOf(p.file), p);
    const left = legacy.get(k) ?? 0;
    if (left === 0) return true;
    legacy.set(k, left - 1);
    return false;
  });
};

export interface Change {
  readonly status: string;
  readonly path: string;
  /** The path on the side compared with: the old one for a rename or copy. */
  readonly from: string;
}

/** `git diff --name-status -z` entries. */
export const parseNameStatus = (output: string): Change[] => {
  const fields = output.split('\0').filter(Boolean);
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = String(fields[i]);
    if (/^[RC]/.test(status)) {
      changes.push({ status: status.charAt(0), from: String(fields[i + 1]), path: String(fields[i + 2]) });
      i += 3;
    } else {
      changes.push({ status: status.charAt(0), path: String(fields[i + 1]), from: String(fields[i + 1]) });
      i += 2;
    }
  }
  return changes;
};

const IDENTIFIER_WORD = /[A-Za-z_$][\w$]*/g;
const LOOKS_LIKE_IDENTIFIER = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)$/;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reference files that cite something this change took away: a deleted or
 * renamed path (by basename, so relative links count), a changed file by
 * `name:line`, an identifier whose last definition the diff removed, or a
 * removed term (a script name, a `--flag`).
 */
export const referrers = (config: Config, snapshot: RepoSnapshot, removedPaths: readonly string[], lineCited: readonly string[], removedWords: ReadonlySet<string>, removedTerms: readonly string[] = []): string[] => {
  if (removedPaths.length === 0 && lineCited.length === 0 && removedWords.size === 0 && removedTerms.length === 0) return [];
  const names = [...new Set([...removedPaths.map((path) => posix.basename(path)), ...removedTerms])];
  // The basename starts a path segment: `check-x.sh:11` does not cite a changed `x.sh`.
  const cited = [...new Set(lineCited.map((path) => posix.basename(path)))].map((name) => new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?::|#L)\\d`));
  const out: string[] = [];
  for (const [file, text] of snapshot.readMany(referenceFiles(config, snapshot))) {
    if (names.some((name) => text.includes(name)) || cited.some((pattern) => pattern.test(text))) {
      out.push(file);
      continue;
    }
    if (removedWords.size !== 0 && docKind(config, file) === 'markdown') {
      for (const match of text.matchAll(IDENTIFIER_WORD)) {
        if (removedWords.has(match[0])) {
          out.push(file);
          break;
        }
      }
    }
  }
  return out;
};

const readBaseline = (text: string | undefined, where: string): Baseline => (text === undefined ? emptyBaseline() : parseBaseline(text, where));

/** Script names a manifest change removed (`pnpm <name>` now runs nothing); an unparsable manifest names none. */
const removedScripts = (before: string | undefined, after: string | undefined): string[] => {
  const names = (text: string | undefined): Set<string> => {
    const scripts = text === undefined ? undefined : manifestObject(text)?.['scripts'];
    return new Set(typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts) ? Object.keys(scripts) : []);
  };
  const now = names(after);
  return [...names(before)].filter((name) => !now.has(name));
};

/** Files whose baseline entry an edit changed: each is re-checked. */
const baselineEdits = (previous: Baseline | undefined, current: Baseline): string[] => {
  if (previous === undefined) return Object.keys(current.files);
  const files = new Set([...Object.keys(previous.files), ...Object.keys(current.files)]);
  return [...files].filter((file) => JSON.stringify(previous.files[file] ?? {}) !== JSON.stringify(current.files[file] ?? {}));
};

/**
 * The hunk lines of a unified diff: everything after a file's first `@@`
 * until the next `diff --git`. The `---`/`+++` file headers come before the
 * first hunk, so a removed line whose content starts `--` is still read.
 */
export const hunkLines = (diff: string): string[] => {
  const lines: string[] = [];
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk) lines.push(line);
  }
  return lines;
};

/** What the diff's removed lines held that its added lines do not, by `pattern`, kept when `keep` says so. */
const removedTokens = (diff: string, pattern: RegExp, keep: (token: string) => boolean): Set<string> => {
  const removed = new Set<string>();
  const added = new Set<string>();
  for (const line of hunkLines(diff)) {
    const target = line.startsWith('-') ? removed : line.startsWith('+') ? added : null;
    if (target === null) continue;
    for (const match of line.matchAll(pattern)) if (keep(match[0])) target.add(match[0]);
  }
  for (const token of added) removed.delete(token);
  return removed;
};

/** `--flags` the diff's removed lines held that its added lines do not. */
export const removedFlags = (diff: string): string[] => [...removedTokens(diff, /--[a-z][\w-]+/g, () => true)];

/** Identifier-shaped words the diff's removed lines held that its added lines do not. */
export const removedIdentifiers = (diff: string): Set<string> => removedTokens(diff, IDENTIFIER_WORD, (word) => LOOKS_LIKE_IDENTIFIER.test(word));

export const runGate = (options: GateOptions): GateReport => {
  const { root, config, mode, checks, links } = options;
  const baselineFile = config.baseline;
  let snapshot: RepoSnapshot;
  let changed: string[];
  let checked: string[];
  let previous: Baseline | undefined;
  // A push's merge base and head; a commit and --all have none.
  let range: { base: string; head: string } | undefined;
  // A file's path at the merge base: a rename's old path.
  let baseOf = (file: string): string => file;
  // Baseline entries whose file this change answers for if it is gone: every
  // entry under --all; otherwise the paths the change removed and the entries
  // it edited. A doc another change deleted is that change's to clear.
  let answersForGone: (file: string) => boolean = () => true;

  if (mode.kind === 'all') {
    snapshot = createSnapshot(root, { kind: 'worktree' });
    checked = referenceFiles(config, snapshot);
    changed = checked;
  } else {
    let diffArgs: string[];
    // What the change is compared with: HEAD for a commit, the merge base for a push.
    let before: (path: string) => string | undefined;
    // Mid-merge, what the merge took from MERGE_HEAD unchanged is that
    // branch's to judge, however it comes in. A push skips nothing.
    let taken: ReadonlySet<string> = new Set();
    if (mode.kind === 'staged') {
      taken = takenFromMerge(root);
      snapshot = createSnapshot(root, { kind: 'index' });
      const hasHead = gitOrUndefined(root, ['show', 'HEAD:']) !== undefined;
      diffArgs = ['diff', '--cached', '--name-status', '-z', '-M', ...(hasHead ? ['HEAD'] : [])];
      before = (path) => (hasHead ? gitOrUndefined(root, ['show', `HEAD:${path}`]) : undefined);
    } else {
      const base = git(root, ['merge-base', mode.base, mode.head]).trim();
      range = { base, head: mode.head };
      snapshot = createSnapshot(root, { kind: 'ref', ref: mode.head });
      diffArgs = ['diff', '--name-status', '-z', '-M', base, mode.head];
      before = (path) => gitOrUndefined(root, ['show', `${base}:${path}`]);
    }
    const priorText = before(baselineFile);
    previous = priorText === undefined ? undefined : parseBaseline(priorText, `${baselineFile} (before this change)`);
    const changes = parseNameStatus(git(root, diffArgs)).filter((change) => !taken.has(change.path));
    const renamed = new Map(changes.filter((change) => change.status === 'R').map((change) => [change.path, change.from]));
    baseOf = (file) => renamed.get(file) ?? file;
    changed = changes.filter((change) => change.status !== 'D' && docKind(config, change.path) !== null).map((change) => change.path);
    const removedPaths = changes.flatMap((change) => (change.status === 'D' ? [change.path] : change.status === 'R' ? [change.from] : []));
    // A script removed from a manifest strands every doc that runs it.
    const terms = changes.filter((change) => change.path.endsWith('package.json')).flatMap((change) => removedScripts(before(change.from), snapshot.read(change.path)));
    let lineCited: string[] = [];
    let words = new Set<string>();
    if (range !== undefined) {
      // Pushed: a changed file can move the line a doc cites, and a removed
      // definition or flag strands the docs that name it.
      lineCited = changes.filter((change) => change.status === 'M').map((change) => change.path);
      const diff = git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', range.base, range.head, '--', '.', ...config.identifiers.diffExclude.map((p) => `:(exclude)${p}`)]);
      terms.push(...removedFlags(diff));
      if (checks.includes('DOC-DRIFT-04')) words = removedIdentifiers(diff);
    }
    // Ignore rules decide which absent paths count, so a change to them re-checks every reference.
    const everything = changes.some((change) => posix.basename(change.path) === '.gitignore');
    const edited = baselineEdits(previous, readBaseline(snapshot.read(baselineFile), baselineFile));
    // A seed (no earlier baseline) edits every entry, but deleted none of their files.
    const answered = new Set([...removedPaths, ...(previous === undefined ? [] : edited)]);
    answersForGone = (file) => answered.has(file);
    checked = (
      everything
        ? referenceFiles(config, snapshot)
        : [
            ...new Set([
              ...changed,
              ...referrers(config, snapshot, removedPaths, lineCited, words, terms),
              // An entry dropped for a file the check no longer reads re-checks nothing.
              ...edited.filter((file) => snapshot.files.has(file) && docKind(config, file) !== null),
            ]),
          ].sort()
    ).filter((file) => !taken.has(file));
  }

  // --all reads the worktree, where a baseline being written is not yet
  // tracked; every other mode reads the snapshot it checks.
  const current = readBaseline(mode.kind === 'all' && existsSync(join(root, baselineFile)) ? readFileSync(join(root, baselineFile), 'utf8') : snapshot.read(baselineFile), baselineFile);
  // One batched read: an index or ref snapshot otherwise spawns a git process per file.
  snapshot.readMany(checked);
  const problems = runChecks(config, snapshot, checked, checks, links);

  if (mode.kind === 'all' && options.baseline !== undefined) {
    const counts = emptyBaseline();
    for (const p of problems) {
      const entry = (counts.files[p.file] ??= {});
      entry[p.check] = (entry[p.check] ?? 0) + 1;
    }
    if (options.baseline === 'update') {
      // Only ever lower: a count can fall to what remains, never rise.
      for (const [file, entry] of Object.entries(counts.files)) {
        for (const check of CHECK_IDS) {
          const now = entry[check];
          if (now !== undefined) entry[check] = Math.min(now, current.files[file]?.[check] ?? 0);
        }
      }
    }
    const text = serializeBaseline(counts);
    writeFileSync(join(root, baselineFile), text);
    return { checked, changed, problems, failures: [], slack: [], growth: [], wrote: Object.keys(parseBaseline(text, baselineFile).files).length, exitCode: 0 };
  }

  const growth = [
    ...(previous === undefined ? [] : baselineGrowth(previous, current)),
    // An entry for a file that is gone would hold an allowance for nothing.
    ...Object.keys(current.files)
      .filter((file) => !snapshot.files.has(file) && answersForGone(file))
      .map((file) => `${file}: no such file; remove its entry`),
  ];
  const judged = applyBaseline(problems, current, checked, checks);
  let { failures } = judged;
  if (range !== undefined) {
    // Over its count, a file still fails only for what the merge base did not already have.
    const baseRef = range.base;
    failures = introducedFailures(
      failures,
      (files) => {
        const base = createSnapshot(root, { kind: 'ref', ref: baseRef });
        const present = files.filter((file) => base.files.has(file));
        base.readMany(present);
        return runChecks(config, base, present, checks, links);
      },
      baseOf,
    );
  }
  const changedSet = new Set(changed);
  const blocking = judged.slack.some((entry) => changedSet.has(entry.file));
  return { checked, changed, problems, failures, slack: judged.slack, growth, wrote: undefined, exitCode: failures.length > 0 || growth.length > 0 || blocking ? 1 : 0 };
};

const P = 'pariksha doc-references:';

/** What the run prints: problems and what to do on stderr; the one-line verdict on stdout. */
export const formatReport = (report: GateReport, options: Pick<GateOptions, 'config' | 'mode' | 'checks'>, configPath: string): { ok: boolean; out: string[]; err: string[] } => {
  const { config, mode, checks } = options;
  const scope = mode.kind === 'staged' ? 'staged' : mode.kind === 'range' ? 'pushed' : 'all';
  if (report.wrote !== undefined) {
    return { ok: true, out: [`${P} wrote ${config.baseline}: ${report.wrote} file(s) hold ${report.problems.length} problem(s) (${report.checked.length} reference file(s) checked)`], err: [] };
  }
  const out: string[] = [];
  const err: string[] = [];
  for (const p of report.failures) err.push(`${P} ${p.file}:${p.line}: [${p.check}] ${p.ref}: ${p.reason}`);
  if (report.failures.length > 0) {
    const files = new Set(report.failures.map((p) => p.file)).size;
    err.push(`${P} ${report.failures.length} unresolved reference(s) in ${files} file(s). Fix each; one that names something absent on purpose (a quoted finding, a deleted or planned file) ends its line with <!-- ${config.exemptWord}: <why> --> (in code, a comment holding ${config.exemptWord}: <why>).`);
  }
  const changed = new Set(report.changed);
  const lower = `pariksha doc-references --config ${configPath} --all --update-baseline`;
  for (const entry of report.slack) {
    const line = `${P} ${config.baseline}: ${entry.file} ${entry.check}: baseline ${entry.baseline}, now ${entry.actual}; lower it: ${lower}`;
    (changed.has(entry.file) ? err : out).push(line);
  }
  for (const message of report.growth) err.push(`${P} ${config.baseline}: ${message}`);
  if (report.exitCode === 0) {
    const notRun = CHECK_IDS.filter((id) => !checks.includes(id));
    const ran = notRun.length === 0 ? scope : `${scope}; ${notRun.join(', ')} not run`;
    out.push(`${P} ${report.checked.length} reference file(s) checked (${ran}), no new problem; the baseline does not grow`);
    if (config.skipped.length > 0) out.push(`${P} not checked: ${config.skipped.join(', ')}`);
  }
  return { ok: report.exitCode === 0, out, err };
};
