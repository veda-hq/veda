/**
 * One answer to Claude Code from many handlers.
 *
 * Claude Code reads one hook's answer from its exit code and output: exit 2
 * blocks (stderr goes to Claude), exit 0 may print JSON with a decision or
 * context, any other exit is a non-blocking error shown to the user. When it
 * runs several hooks it combines their answers; sarathi runs them all behind
 * one hook, so it combines them the same way:
 *
 * - any handler that blocks makes the answer block, with every blocker's reason;
 *   on Stop and SubagentStop the other handlers' block reasons and context
 *   follow it, since an exit 2 drops every JSON answer;
 * - a fail-closed handler (a guard) that ends any other way than exit 0 blocks too;
 * - JSON answers merge field by field, the strictest decision winning
 *   (deny over ask over allow; block over none; continue false over true);
 * - context from every handler is kept, joined;
 * - a handler that failed without blocking is reported in `systemMessage`
 *   when there is JSON to carry it, else on stderr with exit 1.
 */
import type { Outcome } from './run.ts';

export interface Answer {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

type Json = Record<string, unknown>;

/** Events whose plain stdout Claude Code adds to Claude's context. */
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const PERMISSION_ORDER = ['deny', 'ask', 'allow'];

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The object a handler printed, or undefined for any other output: a record is the only answer. */
function parseJson(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text.trim());
    return isRecord(value) ? value : undefined;
  } catch {
    // Output that is not JSON is no record: the function falls through to undefined.
  }
  return undefined;
}

function strings(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

function joined(values: readonly unknown[]): string | undefined {
  const kept = strings(values);
  return kept.length === 0 ? undefined : kept.join('\n\n');
}

function ends(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

function blocks(outcome: Outcome): boolean {
  if (outcome.code === 2) return true;
  return outcome.failClosed && outcome.code !== 0;
}

function blockReason(outcome: Outcome): string {
  if (outcome.code === 2) return ends(outcome.stderr);
  const how = outcome.timedOut ? 'ran out of time' : outcome.code === null ? 'did not finish' : `exited ${outcome.code}`;
  return `${ends(outcome.stderr)}BLOCKED: ${outcome.label} ${how} instead of giving a verdict, so the call is refused.\n`;
}

function failureNote(outcome: Outcome): string {
  const how = outcome.timedOut ? 'ran out of time' : outcome.code === null ? 'did not finish' : `exited ${outcome.code}`;
  const detail = outcome.stderr.trim();
  return detail === '' ? `${outcome.label} ${how}` : `${outcome.label} ${how}: ${detail}`;
}

/** Merges the hook-specific fields of several JSON answers for `event`. */
function mergeSpecific(event: string, answers: readonly Json[], extraContext: readonly string[]): Json | undefined {
  const specifics = answers.map(answer => answer.hookSpecificOutput).filter(isRecord);
  const merged: Json = {};
  for (const specific of specifics) {
    for (const [key, value] of Object.entries(specific)) {
      if (!(key in merged)) merged[key] = value;
    }
  }
  const decisions = specifics.map(specific => specific.permissionDecision).filter((value): value is string => typeof value === 'string');
  const winner = PERMISSION_ORDER.find(decision => decisions.includes(decision)) ?? decisions[0];
  if (winner !== undefined) {
    merged.permissionDecision = winner;
    // Only the winners' reasons: with none, undefined leaves out the one another decision gave.
    merged.permissionDecisionReason = joined(specifics.filter(specific => specific.permissionDecision === winner).map(specific => specific.permissionDecisionReason));
  }
  const context = joined([...specifics.map(specific => specific.additionalContext), ...extraContext]);
  if (context === undefined) delete merged.additionalContext;
  else merged.additionalContext = context;
  if (Object.keys(merged).length === 0) return undefined;
  merged.hookEventName = event;
  return merged;
}

const MANAGED = new Set(['continue', 'stopReason', 'suppressOutput', 'decision', 'reason', 'systemMessage', 'hookSpecificOutput']);

/** The merged answer. A managed field left undefined is left out of the JSON it becomes. */
function mergeJson(event: string, answers: readonly Json[], extraContext: readonly string[], notes: readonly string[]): Json {
  const merged: Json = {};
  for (const answer of answers) {
    for (const [key, value] of Object.entries(answer)) {
      if (!MANAGED.has(key) && !(key in merged)) merged[key] = value;
    }
  }
  if (answers.some(answer => answer.continue === false)) {
    merged.continue = false;
    merged.stopReason = joined(answers.map(answer => answer.stopReason));
  }
  if (answers.some(answer => answer.suppressOutput === true)) merged.suppressOutput = true;
  const blockers = answers.filter(answer => answer.decision === 'block');
  if (blockers.length > 0) {
    merged.decision = 'block';
    merged.reason = joined(blockers.map(answer => answer.reason));
  }
  merged.systemMessage = joined([...answers.map(answer => answer.systemMessage), ...notes]);
  merged.hookSpecificOutput = mergeSpecific(event, answers, extraContext);
  return merged;
}

/**
 * Events whose exit-2 answer carries the other handlers' texts too. Claude Code
 * gives the model a blocked Stop's stderr and, beside it, each hook's block
 * reason and context; sarathi's one exit 2 would drop the JSON answers, so
 * their texts follow the blockers' stderr instead (veda#307).
 */
const TEXTS_ON_BLOCK = new Set(['Stop', 'SubagentStop']);

/** The other handlers' block reasons, then their context, as one block's stderr. */
function othersTexts(outcomes: readonly Outcome[]): string[] {
  const answers = outcomes
    .filter(outcome => outcome.code === 0)
    .map(outcome => parseJson(outcome.stdout))
    .filter((answer): answer is Json => answer !== undefined);
  const reasons = answers.filter(answer => answer.decision === 'block').map(answer => answer.reason);
  const context = answers.map(answer => answer.hookSpecificOutput).filter(isRecord).map(specific => specific.additionalContext);
  return strings([...reasons, ...context]).map(text => text.trim());
}

/** Combines the outcomes of `event`'s handlers into the one answer sarathi gives. */
export function merge(event: string, outcomes: readonly Outcome[]): Answer {
  const blockers = outcomes.filter(blocks);
  if (blockers.length > 0) {
    const reasons = blockers.map(blockReason).join('');
    // othersTexts reads only exit-0 answers, and no blocker exits 0.
    const others = TEXTS_ON_BLOCK.has(event) ? othersTexts(outcomes) : [];
    if (others.length === 0) return { code: 2, stdout: '', stderr: reasons };
    const texts = [reasons.trimEnd(), ...others].filter(text => text !== '');
    return { code: 2, stdout: '', stderr: `${texts.join('\n\n')}\n` };
  }

  const failed = outcomes.filter(outcome => outcome.code !== 0);
  const passed = outcomes.filter(outcome => outcome.code === 0);
  const answers: Json[] = [];
  const texts: string[] = [];
  for (const outcome of passed) {
    const json = parseJson(outcome.stdout);
    if (json !== undefined) answers.push(json);
    else if (outcome.stdout.trim() !== '') texts.push(outcome.stdout.trim());
  }
  const contextTexts = CONTEXT_EVENTS.has(event) ? texts : [];
  const notes = failed.map(failureNote);

  if (answers.length > 0 || (failed.length > 0 && contextTexts.length > 0)) {
    return { code: 0, stdout: `${JSON.stringify(mergeJson(event, answers, contextTexts, notes))}\n`, stderr: '' };
  }
  if (failed.length > 0) {
    return { code: 1, stdout: '', stderr: failed.map(outcome => ends(failureNote(outcome))).join('') };
  }
  return { code: 0, stdout: texts.length === 0 ? '' : `${texts.join('\n\n')}\n`, stderr: '' };
}
