// `dvara records`: the record gate. It selects files, reads them from one git
// tree (the index at pre-commit, HEAD in CI), runs the rules over them and
// holds legacy findings by a per-file baseline whose counts only fall.
//
//   --staged                 pre-commit: every staged file, read from the
//                            index (what is being committed, not the working
//                            tree); branch rules against the merge base with
//                            the first of `baseRefs` that resolves.
//   --all [--base REF]       every tracked file at HEAD; with --base, branch
//                            rules and the baseline's only-falls guard against
//                            the merge base with REF.
//   --base REF               the files changed since the merge base with REF.
//   --all --write-baseline   record today's counts.
//   --all --survey           counts per rule and check.
//
// Exit 0: clean or within the baseline. 1: refused. 2: could not run.
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RecordsConfig } from "../config.ts";
import {
  baselineIncreases,
  countFindings,
  parseBaseline,
  pathMap,
  ratchet,
  renderBaseline,
  staleEntries,
  type Baseline,
} from "./baseline.ts";
import {
  git,
  listTree,
  mergeBase,
  noQuestions,
  objectName,
  readBlobs,
  recordingContext,
  resolveRef,
  treeContext,
  treeLists,
  UnreadableObject,
  type Git,
  type TreeRef,
} from "./git.ts";
import { rulesFor } from "./rules.ts";
import { isReadPath } from "./scope.ts";
import {
  RULE_IDS,
  type Finding,
  type Rule,
  type TreeContext,
} from "./types.ts";

export interface Options {
  readonly mode: "staged" | "all" | "base";
  readonly base: string | null;
  readonly writeBaseline: boolean;
  readonly survey: boolean;
}

export const USAGE =
  "usage: dvara records --staged | --all [--base REF] [--write-baseline | --survey] | --base REF";

export const parseArgs = (
  args: readonly string[],
): Options | { error: string } => {
  let mode: Options["mode"] | null = null;
  let base: string | null = null;
  let writeBaseline = false;
  let survey = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--staged" || arg === "--all") {
      if (mode !== null) return { error: `${arg}: one of --staged or --all` };
      mode = arg === "--staged" ? "staged" : "all";
    } else if (arg === "--base") {
      // A second --base would silently replace the scope the first named.
      if (base !== null) return { error: "--base given twice" };
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--"))
        return { error: "--base needs a ref" };
      base = value;
      i += 1;
    } else if (arg === "--write-baseline") writeBaseline = true;
    else if (arg === "--survey") survey = true;
    else return { error: `unknown argument: ${String(arg)}` };
  }
  if (mode === null && base === null) return { error: "nothing to check" };
  const options: Options = {
    mode: mode ?? "base",
    base,
    writeBaseline,
    survey,
  };
  if (options.mode === "staged" && options.base !== null)
    return {
      error: "--staged compares with the configured base refs; drop --base",
    };
  if (options.writeBaseline && options.survey)
    return { error: "--write-baseline and --survey: pick one" };
  if ((options.writeBaseline || options.survey) && options.mode !== "all")
    return {
      error: "--write-baseline and --survey read the whole tree: add --all",
    };
  return options;
};

export interface Settings {
  readonly records: RecordsConfig;
  /**
   * Refs tried in order for the base a staged change is judged against;
   * every one that resolves is also pushed history, for cited commits.
   */
  readonly baseRefs: readonly string[];
  /** Paths the gate never reads besides the baseline: the config file, say. */
  readonly own?: readonly string[];
  /** The rules to run; `rulesFor(records)` by default. */
  readonly rules?: readonly Rule[];
}

/** The paths in `--name-status -z` output: each change is `<status>\0<path>\0`. */
const changedPaths = (out: string): string[] =>
  [...out.matchAll(/[^\0]+\0([^\0]+)\0/g)].map((m) => m[1] ?? "");

/** Renames git detects in a diff, new path to old path. */
const renamesIn = (
  repo: Git,
  diffArgs: readonly string[],
): Map<string, string> => {
  const listing = git(repo, [
    "diff",
    ...diffArgs,
    "-M",
    "--diff-filter=R",
    "--name-status",
    "-z",
  ]);
  // Each rename is `R<score>\0<old>\0<new>\0`.
  const out = new Map<string, string>();
  for (const m of listing.matchAll(/[^\0]+\0([^\0]+)\0([^\0]+)\0/g))
    out.set(m[2] ?? "", m[1] ?? "");
  return out;
};

interface Plan {
  readonly ref: TreeRef;
  /** Merge base for branch rules: undefined = none, null = the branch adds everything. */
  readonly branchBase: string | null | undefined;
  /** The ref whose baseline the edit guard compares against. */
  readonly baselineBefore: string | null;
  /** Paths to check; a deleted one reads as absent and is skipped. */
  readonly check: string[];
  readonly baselineChanged: boolean;
  /** Renames in the change (new to old), asked only when the baseline moved. */
  readonly renames: () => Map<string, string>;
}

const firstResolving = (repo: Git, refs: readonly string[]): string | null => {
  for (const ref of refs) {
    const commit = resolveRef(repo, ref);
    if (commit !== null) return commit;
  }
  return null;
};

const plan = (
  options: Options,
  repo: Git,
  settings: Settings,
): Plan | { error: string } => {
  const baselinePath = settings.records.baseline;
  const head = resolveRef(repo, "HEAD");
  if (options.mode === "staged") {
    const args = ["diff", "--cached", "--name-status", "-z", "--no-renames"];
    // With no HEAD yet, `diff --cached` lists everything staged.
    const staged = changedPaths(git(repo, args));
    let base: string | null = null;
    let changes = staged;
    if (head !== null) {
      const upstream = firstResolving(repo, settings.baseRefs);
      // A merge in progress commits both parents: the base is the upstream's
      // merge base with that merge, and what the other parent brings
      // unchanged from the base is not this change's to answer for.
      const merging = resolveRef(repo, "MERGE_HEAD");
      base =
        upstream === null
          ? head
          : ((merging === null
              ? mergeBase(repo, upstream, head)
              : mergeBase(repo, upstream, head, merging)) ?? head);
      if (merging !== null) {
        const fromBase = new Set(changedPaths(git(repo, [...args, base])));
        changes = staged.filter((p) => fromBase.has(p));
      }
    }
    const branchBase = base;
    return {
      ref: ":",
      branchBase,
      // Counts only fall relative to the upstream: an allowance the branch
      // itself added and then adjusts is still compared with the upstream's.
      baselineBefore: branchBase,
      check: changes,
      baselineChanged: changes.includes(baselinePath),
      renames: () =>
        branchBase === null
          ? new Map()
          : renamesIn(repo, ["--cached", branchBase]),
    };
  }
  let base: string | undefined;
  if (options.base !== null) {
    const target = resolveRef(repo, options.base);
    if (target === null || head === null)
      return { error: `cannot resolve ${options.base} or HEAD` };
    const found = mergeBase(repo, head, target);
    if (found === null)
      return { error: `no merge base between HEAD and ${options.base}` };
    base = found;
  }
  if (options.mode === "all")
    return {
      ref: "HEAD",
      branchBase: base,
      baselineBefore: base ?? null,
      check: listTree(repo, "HEAD"),
      baselineChanged: base !== undefined,
      // Asked only when the baseline moved, which takes a base.
      renames: () => renamesIn(repo, [String(base), "HEAD"]),
    };
  const changes = changedPaths(
    git(repo, [
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      String(base),
      "HEAD",
    ]),
  );
  return {
    ref: "HEAD",
    branchBase: base,
    baselineBefore: base ?? null,
    check: changes,
    baselineChanged: changes.includes(baselinePath),
    renames: () => renamesIn(repo, [String(base), "HEAD"]),
  };
};

/** Files whose baseline entry differs between two baselines. */
const changedEntries = (before: Baseline, after: Baseline): string[] => {
  const keys = new Set([
    ...Object.keys(before.files),
    ...Object.keys(after.files),
  ]);
  // An equal entry written in another order re-checks its file needlessly,
  // never wrongly.
  return [...keys].filter(
    (key) =>
      JSON.stringify(before.files[key]) !== JSON.stringify(after.files[key]),
  );
};

const format = (finding: Finding): string => {
  const label =
    finding.check === finding.rule
      ? finding.rule
      : `${finding.rule}/${finding.check}`;
  return `  ${finding.file}:${finding.line} [${label}] ${finding.message}`;
};

const survey = (
  findings: readonly Finding[],
  files: number,
  log: (line: string) => void,
): void => {
  const byRule = new Map<string, number>();
  const byCheck = new Map<string, number>();
  const byFile = countFindings(findings);
  for (const f of findings) {
    byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
    byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
  }
  log(
    `files checked: ${files}; files with findings: ${byFile.size}; findings: ${findings.length}`,
  );
  for (const rule of RULE_IDS) {
    const filesWith = [...byFile.values()].filter(
      (c) => (c[rule] ?? 0) > 0,
    ).length;
    log(
      `rule ${rule}: ${byRule.get(rule) ?? 0} findings in ${filesWith} files`,
    );
  }
  for (const [check, n] of [...byCheck].sort(([a], [b]) => (a < b ? -1 : 1)))
    log(`check ${check}: ${n}`);
};

/**
 * Runs the gate; resolves with its exit code. A git store that cannot answer
 * for an object it lists is exit 2; git itself failing throws.
 */
export const records = (
  options: Options,
  repo: Git,
  log: (line: string) => void,
  settings: Settings,
): number => {
  try {
    return runChecks(options, repo, log, settings);
  } catch (error) {
    if (!(error instanceof UnreadableObject)) throw error;
    log(`dvara records: ${error.message}`);
    return 2;
  }
};

const runChecks = (
  options: Options,
  repo: Git,
  log: (line: string) => void,
  settings: Settings,
): number => {
  const started = Date.now();
  const baselinePath = settings.records.baseline;
  const own = [baselinePath, ...(settings.own ?? [])];
  const rules = settings.rules ?? rulesFor(settings.records);
  const planned = plan(options, repo, settings);
  if ("error" in planned) {
    log(`dvara records: ${planned.error}`);
    return 2;
  }
  // A file the branch renamed keeps its history: its base text is the old
  // path's, so what it already cited stays legacy.
  let baseRenames: Map<string, string> | null = null;
  const renamedFrom = (path: string): string | undefined => {
    const base = planned.branchBase;
    if (typeof base !== "string") return undefined;
    baseRenames ??= renamesIn(
      repo,
      planned.ref === ":" ? ["--cached", base] : [base, "HEAD"],
    );
    return baseRenames.get(path);
  };
  // Pushed history: HEAD's, and that of the ref CI names and the base refs.
  const pushed = [
    ...new Set([
      ...(options.base === null ? [] : [options.base]),
      ...settings.baseRefs,
    ]),
  ];
  const tree = treeContext(
    repo,
    planned.ref,
    planned.branchBase,
    renamedFrom,
    pushed,
  );
  const recording = options.writeBaseline || options.survey;
  let baseline: Baseline = { files: pathMap() };
  let before: Baseline | null = null;
  // The commit that adds the baseline has nothing to compare it with, so it
  // must match the tree exactly: every entry is checked, over and under.
  let adding = false;
  try {
    if (!recording) {
      baseline = parseBaseline(tree.read(baselinePath), baselinePath);
      if (planned.baselineChanged) {
        // A root commit has no base at all: its baseline is a first one.
        if (planned.baselineBefore === null) adding = true;
        else {
          const name = `${planned.baselineBefore}:${baselinePath}`;
          const previous = readBlobs(repo, [name]).get(name) ?? null;
          if (previous !== null) before = parseBaseline(previous, name);
          else if (treeLists(repo, planned.baselineBefore, baselinePath))
            // The base has a baseline git cannot read: not a first baseline.
            throw new UnreadableObject(name);
          else adding = true;
        }
      }
    }
  } catch (error) {
    if (error instanceof UnreadableObject) throw error;
    log(`dvara records: ${(error as Error).message}`);
    return 1;
  }
  // A baseline edit re-checks every file whose entry it changed, so a lowered
  // or removed allowance must match the tree in the same change.
  const moved =
    before === null
      ? []
      : changedEntries(before, baseline).filter((p) => tree.pathExists(p));
  const paths = [
    ...new Set([
      ...planned.check,
      ...moved,
      ...(adding ? Object.keys(baseline.files) : []),
    ]),
  ]
    .sort()
    // No rule reads a binary, the gate's own files, a skipped or a frozen
    // path, so they are not read at all. Nor a symlink or a submodule: they
    // are skipped, not refused. A symlink's blob is its target's path, not a
    // record (the target, when tracked, is read under its own path, and a
    // link like `CLAUDE.md -> AGENTS.md` is common); a submodule's entry is a
    // commit of another repository, which this store need not have.
    .filter((p) => isReadPath(p, settings.records, own) && !tree.isLink(p));
  const blobs = readBlobs(
    repo,
    paths.map((p) => objectName(planned.ref, p)),
  );
  const texts: [string, string][] = [];
  for (const path of paths) {
    const text = blobs.get(objectName(planned.ref, path)) ?? null;
    if (text === null) {
      // A path the snapshot lists whose object git cannot read is a broken
      // store, not an absent file: nothing about it can be vouched for.
      if (tree.pathExists(path)) {
        log(
          `dvara records: ${path} is in the ${planned.ref === ":" ? "index" : "commit"} but its object cannot be read`,
        );
        return 2;
      }
      continue;
    }
    if (text.includes("\0")) {
      // Binary content under a text name is skipped, except Markdown: a
      // document every rule reads cannot opt out by carrying a NUL.
      if (/\.mdx?$/.test(path)) {
        log(
          `dvara records: ${path} contains a NUL byte; a Markdown record must be text`,
        );
        return 1;
      }
      continue;
    }
    texts.push([path, text]);
  }
  const check = (path: string, text: string, context: TreeContext): Finding[] =>
    rules.flatMap((rule) => rule(path, text, context));
  // A dry pass records what the rules will ask git; one batch answers it.
  const asked = noQuestions();
  const dry = recordingContext(tree, asked);
  for (const [path, text] of texts) check(path, text, dry);
  tree.warm(asked);
  const checked = texts.map(([path]) => path);
  const findings = texts.flatMap(([path, text]) => check(path, text, tree));

  if (options.writeBaseline) {
    const files = pathMap();
    const held = findings.filter((f) => f.ratchet !== false);
    for (const [file, counts] of countFindings(held)) files[file] = counts;
    const target = join(repo.cwd, baselinePath);
    // Writing through a symlink would replace its target, which may lie
    // outside the repository.
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      log(
        `dvara records: ${baselinePath} is a symlink; replace it with a file before writing the baseline`,
      );
      return 2;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderBaseline({ files }));
    log(
      `dvara records: wrote ${baselinePath} (${Object.keys(files).length} files, ${held.length} findings)`,
    );
    return 0;
  }
  if (options.survey) {
    survey(findings, checked.length, log);
    return 0;
  }

  const scope =
    options.mode === "all" || adding
      ? Object.keys(baseline.files)
      : [...planned.check, ...moved];
  const result = ratchet(checked, findings, baseline);
  const inScope = pathMap();
  for (const p of scope) {
    const entry = baseline.files[p];
    if (entry !== undefined) inScope[p] = entry;
  }
  // An allowance must answer to a file the gate reads: one for a path that
  // is gone, or that the gate skips (binary, NUL-bearing, frozen, skipped,
  // its own), or renamed to such a path, could never be lowered and is
  // refused.
  const read = new Set(checked);
  const stale = staleEntries({ files: inScope }, (p) => read.has(p));
  const raised =
    before === null
      ? []
      : baselineIncreases(before, baseline, planned.renames());

  const ms = Date.now() - started;
  if (
    result.over.length === 0 &&
    result.under.length === 0 &&
    stale.length === 0 &&
    raised.length === 0
  ) {
    // Nothing is over: the baseline holds every finding.
    log(
      `✅ records: ${checked.length} file(s) checked, ${findings.length} legacy finding(s) held by ${baselinePath} (${ms} ms)`,
    );
    return 0;
  }
  log("❌ records: refused");
  for (const over of result.over) {
    const note =
      over.allowed > 0
        ? ` (baseline allows ${over.allowed}, now ${over.now})`
        : "";
    log(`${over.file} — ${over.rule}${note}:`);
    for (const finding of over.findings) log(format(finding));
  }
  for (const under of result.under)
    log(
      `${under.file} — ${under.rule}: ${under.now} left of ${under.allowed}; lower its count in ${baselinePath} to ${under.now}`,
    );
  for (const path of stale) {
    const why = tree.pathExists(path) ? "not a file the gate reads" : "gone";
    log(`${path} — ${why}; remove its entry from ${baselinePath}`);
  }
  for (const problem of raised) log(`${baselinePath}: ${problem}`);
  log(`(${ms} ms)`);
  return 1;
};
