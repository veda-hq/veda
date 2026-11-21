// pr-title: the pull request title is a commit subject, so check it like one.
//
// A repository that squash-merges keeps one commit per pull request, and its
// subject is the title with ` (#N)` appended (GitHub's squash and a merge
// queue both write it so). The branch's own commits, which a commit-msg hook
// and commitlint already check, never reach the default branch, so the title
// is the only subject it keeps, and it has to pass the same rules:
//
//   1. the repository's commitlint config, loaded and run through commitlint
//      itself (`@commitlint/load` and `@commitlint/lint`, optional peers of
//      pariksha), so this cannot drift from the config every commit is linted
//      with. It lints the subject the branch will get, suffix included
//      (`PR_NUMBER`, else a five-digit stand-in), so a title that passes
//      cannot become a subject over `header-max-length`;
//   2. with `shape` in the settings, the shape a commit-msg hook may enforce
//      on top of commitlint, on the title as written: one of the listed
//      emoji, one of the listed types, an optional scope, then a summary of
//      at most `summaryMax` characters that does not end with a period.
//
// The title, the number and the head branch come from the environment
// (PR_TITLE, PR_NUMBER, HEAD_REF), as a workflow passes them: a title in an
// argument would be one shell quote away from running. A head branch that
// starts with one of `skipHeadPrefixes` (a merge queue's own draft, whose
// title is the queue's) is skipped.
//
// The emoji, the types, the limit, the skipped prefixes and the guide the
// refusal points at are the repository's, read from its settings; pariksha
// ships none.

export interface Shape {
  /** The emoji a title may start with, each exactly as written (with or without U+FE0F). */
  readonly gitmoji: readonly string[];
  readonly types: readonly string[];
  /** The longest summary, in characters (code points). */
  readonly summaryMax: number;
}

export interface PrTitleConfig {
  readonly shape: Shape | undefined;
  readonly skipHeadPrefixes: readonly string[];
  /** Where the refusal sends the reader, a path or a URL; undefined for nowhere. */
  readonly guide: string | undefined;
}

export const DEFAULT_PR_TITLE_CONFIG: PrTitleConfig = { shape: undefined, skipHeadPrefixes: [], guide: undefined };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isWordList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v !== '' && v.trim() === v);

const parseShape = (raw: unknown): Shape => {
  if (!isRecord(raw)) throw new Error('"shape" must be an object of gitmoji, types and summaryMax');
  const unknown = Object.keys(raw).find((k) => k !== 'gitmoji' && k !== 'types' && k !== 'summaryMax');
  if (unknown !== undefined) throw new Error(`unknown key "shape.${unknown}"; shape reads gitmoji, types, summaryMax`);
  const { gitmoji, types, summaryMax } = raw;
  if (!isWordList(gitmoji)) throw new Error('"shape.gitmoji" must be a non-empty list of emoji, none blank');
  if (!isWordList(types) || types.some((t) => !/^[a-z][a-z0-9-]*$/.test(t))) throw new Error('"shape.types" must be a non-empty list of lower-case types');
  if (typeof summaryMax !== 'number' || !Number.isInteger(summaryMax) || summaryMax < 1) throw new Error('"shape.summaryMax" must be a whole number of characters, at least 1');
  return { gitmoji, types, summaryMax };
};

/** `{ "shape"?: {…}, "skipHeadPrefixes"?: [...], "guide"?: "…" }`; anything else throws. */
export const parsePrTitleConfig = (text: string): PrTitleConfig => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  const unknown = Object.keys(raw).find((k) => k !== 'shape' && k !== 'skipHeadPrefixes' && k !== 'guide');
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"; pr-title reads shape, skipHeadPrefixes, guide`);
  // Defaulted only when absent: an explicit null is refused below, as for shape and guide.
  const skipHeadPrefixes = 'skipHeadPrefixes' in raw ? raw['skipHeadPrefixes'] : [];
  // An empty prefix would skip every branch.
  if (!Array.isArray(skipHeadPrefixes) || skipHeadPrefixes.some((p) => typeof p !== 'string' || p === '')) throw new Error('"skipHeadPrefixes" must be a list of branch-name prefixes, none empty');
  const guide = raw['guide'];
  if (guide !== undefined && (typeof guide !== 'string' || guide.trim() === '')) throw new Error('"guide" must be a path or URL, a non-empty string');
  return { shape: raw['shape'] === undefined ? undefined : parseShape(raw['shape']), skipHeadPrefixes: skipHeadPrefixes as string[], guide };
};

/** Every character a pattern treats as special, escaped. */
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What the shape check says when the title is not of the shape at all. */
export const formatHint = (shape: Shape): string => `expected "<gitmoji> <type>(scope): <summary>", e.g. "${shape.gitmoji[0] as string} ${shape.types[0] as string}(scope): keep the summary short"`;

/** The shape rules: what is wrong with `title`, or nothing. */
export const titleProblems = (title: string, shape: Shape): string[] => {
  // No `u` flag: the emoji are literal alternatives, and the summary is
  // counted in code points below, not by this pattern.
  const header = new RegExp(`^(?:${shape.gitmoji.map(escape).join('|')}) (?:${shape.types.map(escape).join('|')})(?:\\([^)]+\\))?: (.+)$`);
  const match = header.exec(title);
  if (match === null) return [formatHint(shape)];
  // The one capture group always takes part in a match.
  const summary = match[1] as string;
  const problems: string[] = [];
  const length = [...summary].length;
  if (length > shape.summaryMax) problems.push(`summary is ${length} characters, at most ${shape.summaryMax}`);
  if (summary.endsWith('.')) problems.push('summary ends with a period');
  return problems;
};

/** A commitlint config as `@commitlint/load` gives it, as far as this reads it. */
export interface Loaded {
  readonly rules: unknown;
  readonly parserPreset?: { readonly parserOpts?: unknown } | undefined;
  readonly plugins?: unknown;
  readonly ignores?: unknown;
  readonly defaultIgnores?: unknown;
}

/** `@commitlint/lint`'s default export, as far as this calls it. */
export type Lint = (message: string, rules: unknown, options: unknown) => Promise<{ readonly errors: readonly { readonly name: string; readonly message: string }[] }>;

/** The two commitlint packages: the root's config, loaded, and the linter. */
export interface Commitlint {
  readonly config: Loaded;
  readonly lint: Lint;
}

type Loader = () => Promise<{ readonly load: unknown; readonly lint: unknown }>;

/** Both peers, as dynamic imports: a pariksha without them still runs every other check. */
const importPeers: Loader = async () => {
  const [load, lint] = await Promise.all([import('@commitlint/load'), import('@commitlint/lint')]);
  return { load: load.default, lint: lint.default };
};

export const NO_COMMITLINT = 'needs @commitlint/load and @commitlint/lint (>=20 <21) installed beside pariksha';

/**
 * The repository's commitlint config, as commitlint itself loads it, searched
 * for from `root`; a message when the peers are not installed. A config that
 * does not load throws, with commitlint's reason.
 */
export const loadCommitlint = async (root: string, peers: Loader = importPeers): Promise<Commitlint | string> => {
  let mod: { readonly load: unknown; readonly lint: unknown };
  try {
    mod = await peers();
  } catch {
    // fail-open: the peers are not installed; the caller exits 2 on the message
    return NO_COMMITLINT;
  }
  if (typeof mod.load !== 'function' || typeof mod.lint !== 'function') return NO_COMMITLINT;
  const load = mod.load as (seed: object, options: { cwd: string }) => Promise<Loaded>;
  return { config: await load({}, { cwd: root }), lint: mod.lint as Lint };
};

/** commitlint's errors for `subject` under the config; warnings do not refuse. */
export const commitlintProblems = async (subject: string, commitlint: Commitlint): Promise<string[]> => {
  const { config } = commitlint;
  const result = await commitlint.lint(subject, config.rules, {
    parserOpts: config.parserPreset?.parserOpts ?? {},
    plugins: config.plugins,
    ignores: config.ignores,
    defaultIgnores: config.defaultIgnores,
  });
  return result.errors.map((error) => `${error.message} [${error.name}]`);
};

/** Stands in for the pull request number when none is given: five digits. */
export const NUMBER_STAND_IN = '99999';

/** The subject a squash merge writes: `<title> (#N)`. */
export const squashSubject = (title: string, number?: string): string => `${title} (#${number !== undefined && /^\d+$/.test(number) ? number : NUMBER_STAND_IN})`;

export interface Outcome {
  /** The prefix that skipped the head branch; undefined when it was checked. */
  readonly skipped: string | undefined;
  readonly problems: readonly string[];
}

/** Every problem with `title`, or a skip for a head branch a prefix names. */
export const checkPrTitle = async (title: string, headRef: string | undefined, config: PrTitleConfig, commitlint: Commitlint, number?: string): Promise<Outcome> => {
  const skipped = config.skipHeadPrefixes.find((prefix) => headRef?.startsWith(prefix) === true);
  if (skipped !== undefined) return { skipped, problems: [] };
  const problems = [...(await commitlintProblems(squashSubject(title, number), commitlint)), ...(config.shape === undefined ? [] : titleProblems(title, config.shape))];
  return { skipped: undefined, problems: [...new Set(problems)] };
};

export interface Report {
  readonly code: 0 | 1 | 2;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

const P = 'pariksha pr-title:';

/**
 * The check's answer for PR_TITLE, PR_NUMBER and HEAD_REF in `env`: 0 passed
 * or skipped, 1 refused, 2 no title, or commitlint not there or its config
 * not loaded (nothing was checked).
 */
export const runPrTitle = async (env: Readonly<Record<string, string | undefined>>, config: PrTitleConfig, root: string, load: (root: string) => Promise<Commitlint | string> = loadCommitlint): Promise<Report> => {
  const title = env['PR_TITLE'];
  if (title === undefined || title === '') return { code: 2, stdout: [], stderr: [`${P} PR_TITLE is empty or unset; nothing was checked, so this is not a pass`] };
  const skip = config.skipHeadPrefixes.find((prefix) => env['HEAD_REF']?.startsWith(prefix) === true);
  // A skipped branch needs no commitlint, so its absence does not fail it.
  if (skip !== undefined) return { code: 0, stdout: [`${P} head branch ${env['HEAD_REF'] as string} starts with ${skip}, so its title is not checked`], stderr: [] };
  let commitlint: Commitlint | string;
  try {
    commitlint = await load(root);
  } catch (e) {
    // fail-open: reported, and the exit code returned is 2
    return { code: 2, stdout: [], stderr: [`${P} the commitlint config at ${root} did not load: ${(e as Error).message}; nothing was checked, so this is not a pass`] };
  }
  if (typeof commitlint === 'string') return { code: 2, stdout: [], stderr: [`${P} ${commitlint}`] };
  const outcome = await checkPrTitle(title, env['HEAD_REF'], config, commitlint, env['PR_NUMBER']);
  if (outcome.problems.length === 0) return { code: 0, stdout: [`${P} ok: ${title}`], stderr: [] };
  return {
    code: 1,
    stdout: [],
    stderr: [
      `${P} the title becomes the commit subject when this pull request squash-merges, and it fails the commit rules: ${title}`,
      ...outcome.problems.map((problem) => `  - ${problem}`),
      `Edit the title: the edit re-runs this check (re-running this run reuses the old title).${config.guide === undefined ? '' : ` See ${config.guide}.`}`,
    ],
  };
};
