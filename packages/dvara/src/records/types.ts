// What the record rules share: the findings they report and the tree they ask
// about. Every rule is pure: the tree arrives as functions, so the same rule
// checks the index at pre-commit and a commit in CI.

/** The rules a baseline may name. */
export type RuleId = "EVIDENCE-01" | "EVIDENCE-02";

export const RULE_IDS: readonly RuleId[] = ["EVIDENCE-01", "EVIDENCE-02"];

export interface Finding {
  readonly rule: RuleId;
  /** The rule's own check that found it; the rule's id when it has one check. */
  readonly check: string;
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  readonly message: string;
  /** false: the finding is new by construction and no baseline holds it. */
  readonly ratchet?: false;
}

/** What a rule may ask of the tree it checks. */
export interface TreeContext {
  /** The object type of each id the store has (commit, tree, blob, tag). */
  readonly typesOf: (shas: readonly string[]) => ReadonlyMap<string, string>;
  /** The file at the branch's merge base: null when added, undefined when no branch. */
  readonly baseText: (path: string) => string | null | undefined;
}

/** One rule: the findings in the file at `path` whose text is `text`. */
export type Rule = (path: string, text: string, tree: TreeContext) => Finding[];
