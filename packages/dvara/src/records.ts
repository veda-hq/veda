// What a supervised hook tells its supervisor while it runs: stage markers
// (`dvara_stage`) and records (`dvara_record`), one line each in files the
// supervisor names. Parsed here into the history row's fields.

export interface StageMark {
  readonly name: string;
  /** Milliseconds from the run's start; NaN when the marker's time was junk. */
  readonly startMs: number;
}

export interface Input {
  readonly kind: string;
  readonly digest: string;
}

export interface Pushed {
  source: string;
  readonly refs: { readonly local: string; readonly remote: string }[];
}

export interface Proof {
  readonly check: string;
  readonly outcome: string;
  readonly ms: number | null;
}

export interface ProofReason {
  readonly check: string;
  readonly reason: string;
  readonly waitMs: number | null;
  readonly executionMs: number | null;
  readonly previousExecutionMs: number | null;
}

/** A check keep-going mode held or skipped, and why (keep-going.sh). */
export interface NotRun {
  readonly check: string;
  readonly reason: string;
}

/** One heavy-work turn a stage asked for (`dvara turn`). */
export interface Turn {
  /** The hook stage it was asked in; empty when none had been marked. */
  readonly stage: string;
  readonly label: string;
  readonly class: string;
  /** `shared` or `exclusive`. */
  readonly width: string;
  /** `record` or `enforce`. */
  readonly mode: string;
  /** How long the command waited before it started. */
  readonly waitedMs: number | null;
  /** When it would have been granted, from its asking; null when it never was while it ran. */
  readonly wouldWaitMs: number | null;
  /** It waited the bound and ran anyway. */
  readonly ranAnyway: boolean;
  /** It ran inside a turn already held, without asking again. */
  readonly nested: boolean;
}

export interface Records {
  /** null: the hook wrote no records file at all. */
  readonly pushed: Pushed | null;
  readonly declared: Map<string, Input>;
  readonly proof: Proof[];
  readonly proofDiagnostics: ProofReason[];
  /** The stage of each refusal keep-going mode carried on past, in order. */
  readonly failed: string[];
  readonly held: NotRun[];
  readonly skipped: NotRun[];
  /** Each heavy-work turn the hook's stages asked for, in order. */
  readonly turns: Turn[];
}

/**
 * A duration field. Empty is unmeasured, not zero; text that is not a finite
 * number is null too, as JSON would have written NaN and Infinity.
 */
export const recordedMs = (text: string | undefined): number | null => {
  if (!text) return null;
  const ms = Number(text);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Records, one tab-separated line each: `refs-source <stdin|none>`,
 * `ref <local> <remote>`, `stage-input <stage> <kind> <digest>`,
 * `proof <check> <outcome> <ms>`,
 * `proof-reason <check> <reason> <waitMs> <executionMs> <previousExecutionMs>`,
 * keep-going mode's `failed <stage>`, `held <check> <reason>` and
 * `skipped <check> <reason>`, whose reason is free text: a tab in it stays,
 * and `dvara turn`'s `turn <stage> <label> <class> <width> <mode> <waitedMs>
 * <wouldWaitMs> <ranAnyway 0|1> <nested 0|1>`. Anything else is ignored.
 */
export const parseRecords = (text: string | null): Records => {
  const declared = new Map<string, Input>();
  const proof: Proof[] = [];
  const proofDiagnostics: ProofReason[] = [];
  const failed: string[] = [];
  const held: NotRun[] = [];
  const skipped: NotRun[] = [];
  const turns: Turn[] = [];
  const lists = { proof, proofDiagnostics, failed, held, skipped, turns };
  if (text === null) return { pushed: null, declared, ...lists };
  const pushed: Pushed = { source: "none", refs: [] };
  const notRun = ([check = "", ...reason]: string[]): NotRun => ({
    check,
    reason: reason.join("\t"),
  });
  // A blank line's type is empty, which no record has: it is ignored.
  for (const line of text.split("\n")) {
    const [type, ...f] = line.split("\t");
    if (type === "refs-source") pushed.source = f[0] ?? "";
    else if (type === "ref")
      pushed.refs.push({ local: f[0] ?? "", remote: f[1] ?? "" });
    else if (type === "stage-input")
      declared.set(f[0] ?? "", { kind: f[1] ?? "", digest: f[2] ?? "" });
    else if (type === "proof") {
      const ms = Number(f[2]);
      proof.push({
        check: f[0] ?? "",
        outcome: f[1] ?? "",
        ms: Number.isFinite(ms) ? ms : null,
      });
    } else if (type === "proof-reason")
      proofDiagnostics.push({
        check: f[0] ?? "",
        reason: f[1] ?? "",
        waitMs: recordedMs(f[2]),
        executionMs: recordedMs(f[3]),
        previousExecutionMs: recordedMs(f[4]),
      });
    else if (type === "failed") failed.push(f[0] ?? "");
    else if (type === "held") held.push(notRun(f));
    else if (type === "skipped") skipped.push(notRun(f));
    else if (type === "turn")
      turns.push({
        stage: f[0] ?? "",
        label: f[1] ?? "",
        class: f[2] ?? "",
        width: f[3] ?? "",
        mode: f[4] ?? "",
        waitedMs: recordedMs(f[5]),
        wouldWaitMs: recordedMs(f[6]),
        ranAnyway: f[7] === "1",
        nested: f[8] === "1",
      });
  }
  return { pushed, declared, ...lists };
};

/**
 * Stage markers, `<seconds>\t<name>` per line (bash's `$SECONDS`), offset by
 * the time the hook spent choosing its runtime before the supervisor started,
 * which becomes a stage of its own. A marker whose time is not a number stays
 * NaN: JSON writes it as null, which voids its neighbours' durations rather
 * than inventing them.
 */
export const parseStages = (
  text: string | null,
  bootstrapMs: number,
): StageMark[] => {
  const stages: StageMark[] = (text ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [seconds, name = ""] = line.split("\t");
      const at = Number(seconds);
      return {
        name,
        startMs: Number.isFinite(at) ? bootstrapMs + at * 1000 : Number.NaN,
      };
    });
  if (bootstrapMs) stages.unshift({ name: "runtime-selection", startMs: 0 });
  return stages;
};

/** Resident memory (KiB) and process count of `rootPid`'s tree, from a `ps -axo pid=,ppid=,rss=` table. */
export const treeUsage = (
  table: string,
  rootPid: number,
): { rssKiB: number; processes: number } => {
  // Splitting yields at least one field, so every row has a pid; a blank row
  // reads as pid 0 with no parent and no memory, which adds nothing.
  const rows = table
    .split("\n")
    .map(
      (row) => row.trim().split(/\s+/).map(Number) as [number, ...number[]],
    );
  const ids = new Set([rootPid]);
  // A Set visits what is added while iterating it: a breadth-first walk.
  for (const id of ids)
    for (const [pid, ppid] of rows) if (ppid === id) ids.add(pid);
  let rssKiB = 0;
  for (const [pid, , rss] of rows) if (ids.has(pid)) rssKiB += rss ?? 0;
  return { rssKiB, processes: ids.size };
};
