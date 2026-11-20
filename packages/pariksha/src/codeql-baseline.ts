// codeql-baseline: fail on error-level CodeQL alerts that are not in the
// committed baseline. A pre-push scan and a CI scan both judge through it, so
// both judge the same way.
//
// WHY A BASELINE. A gate that counts results whose `level` says "error"
// counts none: CodeQL omits `level` when it equals the rule's default, which
// is how it writes every alert. Read correctly (SARIF 2.1.0 §3.27.10: a
// missing level means the rule's `defaultConfiguration.level`, else
// "warning"), an existing codebase usually holds error-level alerts. The
// baseline records those so they do not block, while any error-level alert
// not in it does. Fixing an alert and regenerating shrinks the baseline;
// nothing is added to it except by regenerating from a scan of main.
//
// SUPPRESSIONS. A false positive is not baselined; it is suppressed where it
// occurs, with a `// codeql[rule-id]` comment on the line above that says why.
// Such a result blocks nothing and is not written to the baseline.
//
// IDENTITY. An alert is its rule, its file, and CodeQL's
// `primaryLocationLineHash`, which hashes the line's content rather than its
// number, so edits elsewhere in a file do not turn a known alert into a new
// one. Counts matter: one line can raise the same rule twice, so the baseline
// is a multiset.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** Where the baseline lives, under the root, unless the settings name another file. */
export const BASELINE_PATH = '.github/codeql/error-baseline.json';

export interface ErrorAlert {
  fingerprint: string;
  ruleId: string;
  path: string;
  line: number;
  message: string;
}

export interface Baseline {
  description: string;
  alerts: ErrorAlert[];
}

interface SarifRule {
  id?: string;
  defaultConfiguration?: { level?: string };
}
interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  partialFingerprints?: { primaryLocationLineHash?: string };
  suppressions?: { kind?: string; status?: string }[];
  locations?: {
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }[];
}
interface SarifRun {
  tool?: {
    driver?: { rules?: SarifRule[] };
    extensions?: { rules?: SarifRule[] }[];
  };
  results?: SarifResult[];
}

/**
 * Whether a result carries an accepted suppression (SARIF 2.1.0 §3.35: a
 * missing `status` means accepted). CodeQL writes one for a result under a
 * `// codeql[rule-id]` comment, but only when `AlertSuppression.ql` is part
 * of the analysis: add ALERT_SUPPRESSION to the suite.
 */
const isSuppressed = (result: SarifResult): boolean => {
  const suppressions = result.suppressions ?? [];
  // Every one accepted: a rejected or under-review suppression beside an accepted one keeps the alert.
  return suppressions.length > 0 && suppressions.every((suppression) => suppression.status === undefined || suppression.status === 'accepted');
};

/** The query that turns `// codeql[rule-id]` comments into SARIF suppressions. */
export const ALERT_SUPPRESSION = 'codeql/javascript-queries:AlertSuppression.ql';

/** Why a SARIF log cannot be judged: it has no runs. */
const NO_RUNS = 'CodeQL SARIF has no runs; the analysis output is unusable';

/** Whether a SARIF log holds at least one run. */
const hasRuns = (sarif: unknown): boolean => {
  const runs = (sarif as { runs?: unknown } | null)?.runs;
  return Array.isArray(runs) && runs.length > 0;
};

/** Every unsuppressed error-level alert in a SARIF log, reading each result's effective level. */
export const errorAlerts = (sarif: unknown): ErrorAlert[] => {
  // Fail closed: a log with no runs is a broken analysis, never a clean one.
  if (!hasRuns(sarif)) throw new Error(NO_RUNS);
  const runs = (sarif as { runs: unknown[] }).runs;
  return (runs as SarifRun[]).flatMap((run) => {
    const defaults = new Map<string, string | undefined>();
    for (const component of [run.tool?.driver, ...(run.tool?.extensions ?? [])]) {
      for (const rule of component?.rules ?? []) {
        if (rule.id !== undefined) defaults.set(rule.id, rule.defaultConfiguration?.level);
      }
    }
    return (run.results ?? [])
      .filter((result) => !isSuppressed(result) && (result.level ?? defaults.get(result.ruleId ?? '') ?? 'warning') === 'error')
      .map((result) => {
        const location = result.locations?.[0]?.physicalLocation;
        const ruleId = result.ruleId ?? 'unknown';
        const path = location?.artifactLocation?.uri ?? 'unknown';
        const line = location?.region?.startLine ?? 0;
        const lineHash = result.partialFingerprints?.primaryLocationLineHash ?? `line:${line.toString()}`;
        return { fingerprint: `${ruleId}|${path}|${lineHash}`, ruleId, path, line, message: result.message?.text ?? '' };
      });
  });
};

/** Alerts beyond what the baseline accounts for, counting repeated fingerprints. */
export const newAlerts = (current: readonly ErrorAlert[], baseline: readonly ErrorAlert[]): ErrorAlert[] => {
  const allowance = new Map<string, number>();
  for (const alert of baseline) allowance.set(alert.fingerprint, (allowance.get(alert.fingerprint) ?? 0) + 1);
  return current.filter((alert) => {
    const left = allowance.get(alert.fingerprint) ?? 0;
    if (left === 0) return true;
    allowance.set(alert.fingerprint, left - 1);
    return false;
  });
};

/** A baseline built from a scan, sorted so regenerating an unchanged scan changes nothing. */
export const toBaseline = (alerts: readonly ErrorAlert[]): Baseline => ({
  description: 'Error-level CodeQL alerts accepted as of the scan this was written from. Regenerate from a scan of main with pariksha codeql-baseline --write; never add by hand.',
  alerts: [...alerts].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : a.line - b.line)),
});

/** The alerts a baseline's text holds; throws on text that is not a baseline, which would otherwise pass every alert or none. */
export const parseBaseline = (text: string): ErrorAlert[] => {
  const raw = JSON.parse(text) as unknown;
  const alerts = (raw as { alerts?: unknown } | null)?.alerts;
  if (!Array.isArray(alerts) || !alerts.every((alert) => typeof (alert as { fingerprint?: unknown } | null)?.fingerprint === 'string')) {
    throw new Error('not a baseline: it must be an object whose "alerts" is a list of alerts, each with a "fingerprint"');
  }
  return alerts as ErrorAlert[];
};

/** The committed baseline's alerts: `path` (BASELINE_PATH by default) read from `root`. */
export const readBaseline = (root: string, path: string = BASELINE_PATH): ErrorAlert[] => parseBaseline(readFileSync(resolve(root, path), 'utf8'));

/** Print the verdict for a SARIF log against the baseline; returns the exit status. */
export const checkSarif = (sarif: unknown, baseline: readonly ErrorAlert[], log: (line: string) => void): number => {
  if (!hasRuns(sarif)) {
    log(`CodeQL: ${NO_RUNS}`);
    return 1;
  }
  const current = errorAlerts(sarif);
  const added = newAlerts(current, baseline);
  const fixed = newAlerts(baseline, current).length;
  log(
    `CodeQL: ${current.length.toString()} error-level alert(s), ${(current.length - added.length).toString()} in the baseline` +
      (fixed > 0 ? `; ${fixed.toString()} baseline alert(s) no longer reported (regenerate to lock that in)` : ''),
  );
  if (added.length === 0) return 0;
  log(`CodeQL: ${added.length.toString()} new error-level alert(s):`);
  for (const alert of added) log(`  ${alert.ruleId}  ${alert.path}:${alert.line.toString()}  ${alert.message}`);
  return 1;
};

export interface Options {
  readonly mode: 'check' | 'write';
  /** The SARIF log, read from the working directory. */
  readonly sarif: string;
  readonly root: string;
  /** The baseline file, read from `root` when relative. */
  readonly baseline: string;
}

/** `body`'s value; when it throws, the same failure with `what` in front of its reason. */
const naming = <T>(what: string, body: () => T): T => {
  try {
    return body();
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`, { cause: e });
  }
};

/**
 * `check`: the verdict on `out`, exit 1 on a new alert (or a log with no
 * runs). `write`: the baseline regenerated from the log. Throws, naming
 * the file, when the log or the baseline cannot be read or written: the
 * CLI turns that into exit 2, never a pass.
 */
export const runCodeqlBaseline = (options: Options, out: (line: string) => void): number => {
  const target = resolve(options.root, options.baseline);
  const shown = isAbsolute(options.baseline) ? relative(options.root, target) : options.baseline;
  const sarif = naming(`cannot read the SARIF log ${options.sarif}`, () => JSON.parse(readFileSync(resolve(options.sarif), 'utf8')) as unknown);
  if (options.mode === 'write') {
    const baseline = naming(`no baseline was written to ${shown}`, () => {
      const built = toBaseline(errorAlerts(sarif));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(built, null, 2)}\n`);
      return built;
    });
    out(`Wrote ${baseline.alerts.length.toString()} alert(s) to ${shown}`);
    return 0;
  }
  const alerts = naming(`cannot read the baseline ${shown}`, () => readBaseline(options.root, target));
  return checkSarif(sarif, alerts, out);
};
