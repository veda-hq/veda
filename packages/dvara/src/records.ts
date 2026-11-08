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

export interface Records {
  /** null: the hook wrote no records file at all. */
  readonly pushed: Pushed | null;
  readonly declared: Map<string, Input>;
  readonly proof: Proof[];
  readonly proofDiagnostics: ProofReason[];
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
 * `proof <check> <outcome> <ms>`, and
 * `proof-reason <check> <reason> <waitMs> <executionMs> <previousExecutionMs>`.
 * Anything else is ignored.
 */
export const parseRecords = (text: string | null): Records => {
  const declared = new Map<string, Input>();
  const proof: Proof[] = [];
  const proofDiagnostics: ProofReason[] = [];
  if (text === null) return { pushed: null, declared, proof, proofDiagnostics };
  const pushed: Pushed = { source: "none", refs: [] };
  for (const line of text.split("\n").filter(Boolean)) {
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
  }
  return { pushed, declared, proof, proofDiagnostics };
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
  const rows = table
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/).map(Number));
  const ids = new Set([rootPid]);
  // A Set visits what is added while iterating it: a breadth-first walk.
  for (const id of ids)
    for (const [pid, ppid] of rows)
      if (ppid === id && pid !== undefined) ids.add(pid);
  let rssKiB = 0;
  for (const [pid, , rss] of rows)
    if (pid !== undefined && ids.has(pid)) rssKiB += rss ?? 0;
  return { rssKiB, processes: ids.size };
};
