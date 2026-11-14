// aggregate-gate-needs: an aggregate gate depends on every job it gates.
//
// A merge queue that requires one status, a workflow's "CI Gate", lets
// through anything that gate does not wait on: a job missing from its
// `needs:` cannot block a merge however it fails, and an upstream failure
// becomes a downstream skip the gate accepts. Every such mistake shows a green
// required check, so this refuses, in each workflow, a gate (a job whose id or
// `name:` matches the config's `gateName`) whose `needs:` leaves out a job
// other than another gate or one the config calls non-gating. A non-gating job
// (a change detector, say) is exempt from "must be gated", not from "must be
// declared when read": a gate whose `if:` or `${{ }}` reads `needs.<id>` or
// `needs['<id>']` without declaring it gets an undefined output and skips.
//
// Read as conditions: the job's `if:` and each step's `if:`, and every
// `${{ … }}` in the job. Not read: text in a `run:` script, quoted literals in
// an expression, and an action input that happens to be called `if`. A
// workflow that does not parse is reported, never read as having no gaps.
//
// The same workflows are also refused a `workflow_dispatch` trigger beside a
// gate (dispatch-on-gate-workflow): a dispatch run from a branch with an open
// pull request posts every job's check on the head commit, the gate among
// them as skipped, and that replaces the pull request run's success. A merge
// queue requiring the gate then reads it as failed and dequeues the pull
// request. `dispatchAllowed` names the workflows (by file name) where that
// cannot happen, for a project with no merge queue on the gate.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

export interface GateConfig {
  /** Where the workflows are, relative to the root. */
  readonly workflowsDir: string;
  /** Which jobs are gates: tested against a job's `name:` (or id) and its id. */
  readonly gateName: RegExp;
  /** Job ids that gate nothing (a change detector), so no gate need depend on them. */
  readonly nonGating: ReadonlySet<string>;
  /** What the messages call this check: a project's rule id, say. */
  readonly id: string;
  /** Workflow file names (`ci.yml`) whose gate may sit beside a `workflow_dispatch` trigger. */
  readonly dispatchAllowed: ReadonlySet<string>;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  workflowsDir: '.github/workflows',
  gateName: /gate$/i,
  nonGating: new Set(),
  id: 'aggregate-gate-needs',
  dispatchAllowed: new Set(),
};

/** What the messages call the dispatch refusal: its own rule, not the project's needs rule. */
export const DISPATCH_ID = 'dispatch-on-gate-workflow';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `{ "id"?: "<label>", "workflowsDir"?: "<dir>", "gateName"?: "<regex>",
 * "nonGating"?: ["<job id>", …], "dispatchAllowed"?: ["<file name>", …] }`;
 * `gateName` matches case-insensitively. Absent keys take the defaults;
 * anything else throws.
 */
export const parseGateConfig = (text: string): GateConfig => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  const unknown = Object.keys(raw).find((k) => !['id', 'workflowsDir', 'gateName', 'nonGating', 'dispatchAllowed'].includes(k));
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"`);
  const text_ = (key: string, fallback: string): string => {
    // Absent takes the default; a present `null` is refused like any other wrong value.
    const value = key in raw ? raw[key] : fallback;
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`"${key}" must be a non-empty string`);
    return value;
  };
  const id = text_('id', DEFAULT_GATE_CONFIG.id);
  const workflowsDir = text_('workflowsDir', DEFAULT_GATE_CONFIG.workflowsDir);
  const source = text_('gateName', DEFAULT_GATE_CONFIG.gateName.source);
  let gateName: RegExp;
  try {
    gateName = new RegExp(source, 'i');
  } catch (e) {
    throw new Error(`"gateName" is not a regex: ${(e as Error).message}`);
  }
  const names = (key: string, what: string): Set<string> => {
    const value = key in raw ? raw[key] : [];
    if (!Array.isArray(value) || value.some((j) => typeof j !== 'string' || j === '')) throw new Error(`"${key}" must be a list of ${what}`);
    return new Set(value as string[]);
  };
  const nonGating = names('nonGating', 'job ids');
  const dispatchAllowed = names('dispatchAllowed', 'workflow file names');
  return { id, workflowsDir, gateName, nonGating, dispatchAllowed };
};

interface WorkflowJob {
  name?: string;
  needs?: string | string[];
  if?: string;
  steps?: Array<{ if?: unknown } | null>;
}

export interface GateGap {
  readonly workflow: string;
  readonly gate: string;
  readonly missing: string[];
}

/** The `.yml` and `.yaml` files in the workflows folder, as root-relative paths; none when it cannot be read. */
export const workflowFiles = (root: string, dir: string): string[] => {
  try {
    return readdirSync(join(root, dir))
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
};

/** The job's `if:` and each step's `if:`: the two places GitHub reads a condition. */
const ifExpressions = (job: WorkflowJob): string[] => {
  const out: string[] = [];
  if (typeof job.if === 'string') out.push(job.if);
  for (const step of job.steps ?? []) {
    if (step && typeof step === 'object' && typeof step.if === 'string') out.push(step.if);
  }
  return out;
};

/** An expression with its quoted literals emptied: `'needs.x'` is an argument, not a read. */
const stripLiterals = (expression: string): string => expression.replace(/'(?:[^']|'')*'/g, "''");

/** The job ids a gate reads, by `needs.<id>` or `needs['<id>']`, in its conditions and `${{ }}` blocks. */
export const consumedNeeds = (job: WorkflowJob | undefined): string[] => {
  if (!job) return [];
  const expressions = ifExpressions(job);
  for (const m of JSON.stringify(job).matchAll(/\$\{\{([\s\S]*?)\}\}/g)) expressions.push(m[1] ?? '');
  const ids = new Set<string>();
  for (const raw of expressions) {
    // Brackets first, off the raw text: stripping literals would erase the quoted id.
    for (const m of raw.matchAll(/needs\[\s*'([A-Za-z0-9_-]+)'\s*\]/g)) ids.add(m[1] ?? '');
    for (const m of stripLiterals(raw).matchAll(/needs\.([A-Za-z0-9_-]+)/g)) ids.add(m[1] ?? '');
  }
  return [...ids];
};

const asArray = (needs: string | string[] | undefined): string[] => (needs === undefined ? [] : Array.isArray(needs) ? needs : [needs]);

interface Workflow {
  on?: unknown;
  jobs?: Record<string, WorkflowJob>;
}

/** The workflow at `relative`, or undefined when it does not parse; a scalar or null document is no job map, read as empty. */
const readWorkflow = (root: string, relative: string): Workflow | undefined => {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(join(root, relative), 'utf8'));
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null ? (parsed as Workflow) : {};
};

/** The ids of the workflow's gates: jobs whose `name:` (or id), or id, matches `gateName`. */
const gatesOf = (jobs: Record<string, WorkflowJob>, config: GateConfig): string[] => Object.keys(jobs).filter((id) => config.gateName.test(jobs[id]?.name ?? id) || config.gateName.test(id));

/** Each gate, in each of `files` (root-relative), whose `needs:` leaves out a job it gates or reads. */
export const findGateGaps = (root: string, files: readonly string[], config: GateConfig): GateGap[] => {
  const gaps: GateGap[] = [];
  for (const relative of files) {
    const document = readWorkflow(root, relative);
    if (document === undefined) {
      gaps.push({ workflow: relative, gate: '(unparseable)', missing: ['<file did not parse>'] });
      continue;
    }
    const jobs = document.jobs ?? {};
    const jobIds = Object.keys(jobs);
    const gateIds = gatesOf(jobs, config);
    for (const gateId of gateIds) {
      const declared = new Set(asArray(jobs[gateId]?.needs));
      const missing = jobIds.filter((id) => id !== gateId && !gateIds.includes(id) && !config.nonGating.has(id) && !declared.has(id));
      const undeclared = consumedNeeds(jobs[gateId]).filter((id) => jobIds.includes(id) && !declared.has(id));
      const all = [...new Set([...missing, ...undeclared])];
      if (all.length > 0) gaps.push({ workflow: relative, gate: gateId, missing: all });
    }
  }
  return gaps;
};

export interface DispatchedGate {
  readonly workflow: string;
  readonly gate: string;
}

/** Whether the workflow's `on:` (one event, a list, or a map) holds `workflow_dispatch`; a map's value is usually null. */
export const hasDispatch = (on: unknown): boolean => {
  if (typeof on === 'string') return on === 'workflow_dispatch';
  if (Array.isArray(on)) return on.includes('workflow_dispatch');
  return isRecord(on) && Object.hasOwn(on, 'workflow_dispatch');
};

/**
 * Each gate, in each of `files` (root-relative), whose workflow can also be
 * dispatched, outside `dispatchAllowed`. A workflow that does not parse is
 * left to findGateGaps, which reports it.
 */
export const findDispatchedGates = (root: string, files: readonly string[], config: GateConfig): DispatchedGate[] => {
  const found: DispatchedGate[] = [];
  for (const relative of files) {
    if (config.dispatchAllowed.has(basename(relative))) continue;
    const document = readWorkflow(root, relative);
    if (document === undefined || !hasDispatch(document.on)) continue;
    for (const gate of gatesOf(document.jobs ?? {}, config)) found.push({ workflow: relative, gate });
  }
  return found;
};

/** The refusal of one dispatched gate, one line. */
export const dispatchMessage = (found: DispatchedGate): string =>
  `❌ ${DISPATCH_ID}: ${found.workflow}: workflow_dispatch on the workflow holding the required gate ${found.gate}. ` +
  "A dispatch run posts the gate as skipped on the PR's head commit, which a merge queue reads as failed and dequeues the PR. " +
  'Move ad-hoc runs to a separate workflow with no gate-named job.';

/** The verdict on the workflows under `root`: the needs gaps worded as the original check worded them, then each dispatched gate. */
export const checkGates = (root: string, config: GateConfig): { ok: boolean; out: string[]; err: string[] } => {
  const files = workflowFiles(root, config.workflowsDir);
  if (files.length === 0) return { ok: false, out: [], err: [`❌ ${config.id}: no workflow files found — the lookup failed`] };
  const gaps = findGateGaps(root, files, config);
  const dispatched = findDispatchedGates(root, files, config).map(dispatchMessage);
  if (gaps.length === 0 && dispatched.length === 0) return { ok: true, out: [`✅ ${config.id}: every aggregate gate depends on all its jobs (${files.length} workflow(s))`], err: [] };
  const err: string[] = [];
  if (gaps.length > 0) {
    err.push(`\n❌ ${config.id}: ${gaps.length} aggregate gate(s) with an incomplete needs list\n`);
    for (const gap of gaps) err.push(` ${gap.workflow} → job "${gap.gate}"`, `   not depended on: ${gap.missing.join(', ')}\n`);
    err.push(
      'The merge queue checks only the gate. A job absent from its `needs:` cannot\n' +
        'block a merge however it fails — and a failure upstream turns into a SKIP\n' +
        'downstream, which the gate then accepts.\n',
    );
  }
  return { ok: false, out: [], err: [...err, ...dispatched] };
};
