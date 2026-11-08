/**
 * The shared runtime of the rule checks.
 *
 * A consumer hands it its own checks and registry (`runHook` here, or the CLI
 * in `cli.ts` with the hook input on stdin). It runs every check that applies
 * to the event and tool, and answers Claude Code on stdout. What every check
 * gets from here:
 *
 * - It refuses or warns; it never rewrites the tool input.
 * - A refusal names the rule, the cost it prevents, what to do instead and
 *   the memory notes it came from (titles and notes from the registry).
 * - A Bash command passes one named check when it ends with
 *   `# rule-pass <id>: <reason>`; the pass is logged with the reason. File
 *   edits have no pass: the refusal says to ask the registry's owner.
 * - A check that throws lets the action go ahead with a warning, and the
 *   crash is logged; so does a crash of this runtime itself.
 * - The session's checkout comes from the input's `cwd`, because Claude Code
 *   runs hooks from the main checkout, not the session's worktree.
 * - Every refusal, warning, pass and crash appends a fire-log row.
 *
 * Cost: nothing here spawns a process or reads a file until a check asks for
 * the checkout or something fires, so a call no check fires on costs only
 * Node's start and the checks themselves.
 */
import { appendFires, branchAt, clip, firesDir, type FireRow, type Git, type Outcome } from './fire-log.ts';
import { DEFAULT_OWNER, loadRegistry, type Registry, type Rule } from './registry.ts';
import { shellComments } from './shell-comments.ts';
import { git } from './spawn.ts';

export { git } from './spawn.ts';

export type HookInput = {
  readonly hook_event_name: string;
  readonly tool_name: string;
  readonly tool_input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  /** The Claude Code session; absent when the input names none. */
  readonly session_id?: string;
  /** The session's transcript file; absent when the input names none. */
  readonly transcript_path?: string;
  /** UserPromptSubmit: the prompt's text; absent when the input names none. */
  readonly prompt?: string;
};

export type Context = {
  readonly input: HookInput;
  /** The Bash command; empty for every other tool and event. */
  readonly command: string;
  /** The session's checkout, resolved on first call. */
  readonly root: () => string;
  /** Git in a folder; throws on a failing exit, which fails the check open. */
  readonly git: Git;
};

export type Finding = {
  readonly action: 'refuse' | 'warn';
  /** What this call did that the rule is about, in one or two sentences. */
  readonly detail: string;
};

/** One check, as a consumer's checks module exports it (`CHECKS` or the default export: a list of these). */
export type Check = {
  /** The registry id (`H-01`, `G-03`). */
  readonly rule: string;
  readonly events: readonly string[];
  /** Tool names for tool events; omitted: every tool. */
  readonly tools?: readonly string[] | undefined;
  /** The cost the rule prevents. */
  readonly cost: string;
  /** What to do instead. */
  readonly instead: string;
  readonly run: (context: Context) => Finding | null;
};

export type Fire = {
  readonly rule: string;
  readonly outcome: Outcome;
  readonly message: string;
  readonly reason?: string;
};

/** The registry as the runtime reads it: a rule by id, and who to ask. */
export type Rules = {
  readonly find: (id: string) => Rule | undefined;
  readonly owner: string;
};

/** The shortest reason a `# rule-pass` may state. */
export const MIN_REASON = 12;

function field(value: Readonly<Record<string, unknown>>, key: string): string {
  const item = value[key];
  return typeof item === 'string' ? item : '';
}

/** Events whose input names a tool and carries that tool's input. */
const TOOL_EVENTS: readonly string[] = ['PreToolUse', 'PostToolUse'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read the hook input. Malformed input throws, so `runHook` logs a crash and
 * lets the call go ahead rather than run checks on blanks: it must be a JSON
 * object naming its event, a tool event must name its tool and carry an input
 * object, and `cwd`, when present, must be text. A `session_id` that is not
 * non-empty text is left out: only per-session checks read it, and they
 * treat a missing one as a session they have not seen.
 */
export function parseInput(raw: string): HookInput {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('hook input is not a JSON object');
  const { hook_event_name: event, tool_name: tool, tool_input: given } = value;
  const { cwd = '', session_id: session, transcript_path: path } = value;
  const { prompt } = value;
  if (typeof event !== 'string' || event === '') {
    throw new Error('hook input names no hook_event_name');
  }
  if (typeof cwd !== 'string') throw new Error('hook input cwd is not text');
  const id = {
    ...(typeof session === 'string' && session !== '' ? { session_id: session } : {}),
    ...(typeof path === 'string' && path !== '' ? { transcript_path: path } : {}),
    ...(typeof prompt === 'string' ? { prompt } : {}),
  };
  if (!TOOL_EVENTS.includes(event)) {
    return {
      hook_event_name: event,
      tool_name: '',
      tool_input: {},
      cwd,
      ...id,
    };
  }
  if (typeof tool !== 'string' || tool === '' || !isRecord(given)) {
    throw new Error(`${event} input names no tool_name and tool_input`);
  }
  return {
    hook_event_name: event,
    tool_name: tool,
    tool_input: given,
    cwd,
    ...id,
  };
}

const PASS = /^[ \t]*rule-pass[ \t]+([A-Z]-\d{2})[ \t]*:(.*)$/;

/**
 * Bash only: the stated pass, check id → reason, from the `# rule-pass`
 * comment that ends the command. One pass per command, and only at its end,
 * so no command can follow it. Only a real shell comment counts
 * (`shell-comments.ts`): a marker in a quoted string or heredoc body is data.
 */
export function statedPasses(command: string): Map<string, string> {
  const passes = new Map<string, string>();
  const text = command.trimEnd();
  const last = text.split('\n').length - 1;
  for (const comment of shellComments(text)) {
    const match = PASS.exec(comment.text);
    if (comment.line !== last || match === null) continue;
    const [, id = '', said = ''] = match;
    const reason = said.trim();
    if (reason.length >= MIN_REASON) passes.set(id, reason);
  }
  return passes;
}

/**
 * The checkout `cwd` lies in; `fallback` when it names none. Empty is checked
 * first because `git -C ""` stays in the current folder; a missing path, a
 * file and a folder outside git all make `git -C` fail.
 */
export function sessionRoot(cwd: string, fallback: string, git: Git): string {
  if (cwd === '') return fallback;
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']) || fallback;
  } catch {
    // fail-open: a cwd outside git names no checkout; the fallback stands in.
    return fallback;
  }
}

function applies(check: Check, input: HookInput): boolean {
  return (
    check.events.includes(input.hook_event_name) && (check.tools === undefined || check.tools.includes(input.tool_name))
  );
}

/** The rule's title and, when the registry records one, where it came from. */
function heading(verb: string, rule: string, entry: Rule | undefined): string {
  if (entry === undefined) return `${verb} ${rule} (not in the rule registry).`;
  const origin = entry.origin === undefined ? '' : ` (${entry.origin})`;
  return `${verb} ${rule}, "${entry.title}"${origin}.`;
}

function memory(entry: Rule | undefined): string {
  return `Memory: ${entry === undefined ? 'none recorded' : entry.notes.join(', ')}`;
}

/** Search tools: their checks pass only for the same search run in the shell. */
const SEARCH_TOOLS: readonly string[] = ['Grep', 'Glob'];

/** How to get past a refusal of `tool`. */
function way(rule: string, tool: string, owner: string): string {
  const pass = `# rule-pass ${rule}: <your reason> (logged)`;
  if (tool === 'Bash') {
    return `To pass it deliberately, end the command with: ${pass}.`;
  }
  if (tool === 'AskUserQuestion') {
    return 'A question has no pass: do what "Instead" says first, then ask.';
  }
  return SEARCH_TOOLS.includes(tool)
    ? `${tool} has no pass: run the search in the shell ending with ${pass}, or ask ${owner}.`
    : `File edits have no pass: ask ${owner}.`;
}

/** The refusal text, with the way past it. */
export function refusal(
  check: Check,
  detail: string,
  entry: Rule | undefined,
  tool: string,
  owner: string = DEFAULT_OWNER,
): string {
  return [
    heading('Refused by', check.rule, entry),
    detail,
    `Prevents: ${check.cost}`,
    `Instead: ${check.instead}`,
    memory(entry),
    way(check.rule, tool, owner),
  ].join('\n');
}

export function warning(check: Check, detail: string, entry: Rule | undefined): string {
  return [
    heading('Warning from', check.rule, entry),
    detail,
    `Prevents: ${check.cost}`,
    `Instead: ${check.instead}`,
    memory(entry),
  ].join('\n');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run the checks that apply; one fire per check that refused, warned, passed or crashed. */
export function decide(context: Context, checks: readonly Check[], rules: Rules): Fire[] {
  const bash = context.input.tool_name === 'Bash';
  const passes = bash ? statedPasses(context.command) : new Map<string, string>();
  const fires: Fire[] = [];
  for (const check of checks) {
    if (!applies(check, context.input)) continue;
    let finding: Finding | null;
    try {
      finding = check.run(context);
    } catch (error) {
      // fail-open: a broken check never blocks work; the crash is logged.
      const reason = message(error);
      fires.push({
        rule: check.rule,
        outcome: 'crashed',
        message: `Check ${check.rule} crashed (${reason}); the action goes ahead.`,
        reason,
      });
      continue;
    }
    if (finding === null) continue;
    const entry = rules.find(check.rule);
    const reason = passes.get(check.rule);
    if (finding.action === 'refuse' && reason !== undefined) {
      fires.push({
        rule: check.rule,
        outcome: 'excepted',
        message: `Passed ${check.rule} with your stated reason (logged): ${reason}`,
        reason,
      });
    } else if (finding.action === 'refuse') {
      fires.push({
        rule: check.rule,
        outcome: 'refused',
        message: refusal(check, finding.detail, entry, context.input.tool_name, rules.owner),
      });
    } else {
      fires.push({
        rule: check.rule,
        outcome: 'warned',
        message: warning(check, finding.detail, entry),
      });
    }
  }
  return fires;
}

/** Events whose hook output can add context the model reads. */
const CONTEXT_EVENTS: readonly string[] = [...TOOL_EVENTS, 'UserPromptSubmit'];

/**
 * The hook's stdout for these fires, refusals first; `note` follows them.
 * Empty when nothing needs saying.
 */
export function render(event: string, fires: readonly Fire[], note: string = ''): string {
  if (fires.length === 0) return '';
  const refused = fires.filter((fire) => fire.outcome === 'refused');
  const text = [...refused, ...fires.filter((fire) => fire.outcome !== 'refused')]
    .map((fire) => fire.message)
    .concat(note === '' ? [] : [note])
    .join('\n\n');
  if (refused.length > 0) {
    return JSON.stringify(
      event === 'PreToolUse'
        ? {
            hookSpecificOutput: {
              hookEventName: event,
              permissionDecision: 'deny',
              permissionDecisionReason: text,
            },
          }
        : { decision: 'block', reason: text },
    );
  }
  if (!CONTEXT_EVENTS.includes(event)) return '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  });
}

/**
 * The excerpt a fire-log row keeps: the command, the file a tool touches, or
 * a search tool's pattern and folder.
 */
export function excerptOf(input: HookInput): string {
  const tool = input.tool_input;
  const search = [field(tool, 'pattern'), field(tool, 'path')].filter(Boolean).join(' in ');
  return clip(field(tool, 'command') || field(tool, 'file_path') || field(tool, 'notebook_path') || search);
}

export type Deps = {
  readonly git: Git;
  readonly now: () => Date;
  /** The registry, loaded only when a check finds something. */
  readonly rules: () => Rules;
  /** The checkout to assume when the input names none. */
  readonly fallbackRoot: string;
  /** The fire-log folder; omitted or empty: `.tmp/rule-checks` in the primary checkout. */
  readonly firesDir?: string | undefined;
};

export type HookOptions = Deps & {
  /**
   * The consumer's checks, in the order they run; a function is called once
   * the input is read, so a checks module that failed to load is logged as a
   * crash under the input's event.
   */
  readonly checks: readonly Check[] | (() => readonly Check[]);
};

function rows(fires: readonly Fire[], root: string, input: HookInput | null, deps: Deps): FireRow[] {
  const ts = deps.now().toISOString();
  const branch = branchAt(root, deps.git);
  const excerpt = input === null ? '' : excerptOf(input);
  return fires.map((fire) => ({
    ts,
    rule: fire.rule,
    outcome: fire.outcome,
    branch,
    excerpt,
    ...(fire.reason === undefined ? {} : { reason: clip(fire.reason) }),
  }));
}

function log(fires: readonly Fire[], root: string, input: HookInput | null, deps: Deps): string {
  try {
    appendFires(firesDir(deps.firesDir, root, deps.git), rows(fires, root, input, deps));
    return '';
  } catch (error) {
    // fail-open: the answer still goes out, and says the log missed it.
    return `The rule-check fire log could not be written (${message(error)}).`;
  }
}

/** The registry loaded once, on the first question asked of it. */
function lazy(load: () => Rules): Rules {
  let loaded: Rules | undefined;
  const rules = (): Rules => (loaded ??= load());
  return {
    find: (id) => rules().find(id),
    get owner() {
      return rules().owner;
    },
  };
}

/** One hook call, end to end; never throws. Returns the stdout. */
export function runHook(stdin: string, options: HookOptions): string {
  let input: HookInput | null = null;
  let root = options.fallbackRoot;
  try {
    const parsed = parseInput(stdin);
    input = parsed;
    const checks = typeof options.checks === 'function' ? options.checks() : options.checks;
    let resolved: string | undefined;
    const context: Context = {
      input: parsed,
      command: parsed.tool_name === 'Bash' ? field(parsed.tool_input, 'command') : '',
      root: () => {
        resolved ??= sessionRoot(parsed.cwd, options.fallbackRoot, options.git);
        return resolved;
      },
      git: options.git,
    };
    const fires = decide(context, checks, lazy(options.rules));
    if (fires.length === 0) return '';
    root = context.root();
    return render(parsed.hook_event_name, fires, log(fires, root, parsed, options));
  } catch (error) {
    // fail-open: a crash of the runtime itself lets the action go ahead.
    const reason = message(error);
    const fire: Fire = {
      rule: 'runtime',
      outcome: 'crashed',
      message: `The rule checks crashed (${reason}); the action goes ahead.`,
      reason,
    };
    return render(input?.hook_event_name ?? 'PreToolUse', [fire], log([fire], root, input, options));
  }
}

/** The runtime's view of a parsed registry. */
export function rulesOf(registry: Registry): Rules {
  const byId = new Map(registry.rules.map((rule) => [rule.id, rule]));
  return { find: (id) => byId.get(id), owner: registry.owner ?? DEFAULT_OWNER };
}

/** The registry at `path`; none (every rule unregistered) when no path is given. */
export function registryRules(path?: string): Rules {
  return rulesOf(path === undefined || path === '' ? { rules: [] } : loadRegistry(path));
}

export type LiveOptions = {
  /** The registry JSON; omitted: no registry. */
  readonly registry?: string | undefined;
  /** The fire-log folder; omitted: the default (see `Deps.firesDir`). */
  readonly firesDir?: string | undefined;
};

/** What a real hook call runs with: this process's git and clock, the registry file, and `env`'s project folder. */
export function liveDeps(env: Readonly<Record<string, string | undefined>>, options: LiveOptions = {}): Deps {
  return {
    git,
    now: () => new Date(),
    rules: () => registryRules(options.registry),
    fallbackRoot: env['CLAUDE_PROJECT_DIR'] ?? process.cwd(),
    firesDir: options.firesDir,
  };
}
