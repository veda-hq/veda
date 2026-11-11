// Each hook's stage names, in the order they run, and the check a passing run
// must pass: every stage it marks is in its hook's list, in the list's order.
// The lists are `stages` in the config, or the JSON file `stageList` names
// (inside an installed package, say), read when the run ends: a pre-commit
// that installs dependencies first finds the file its install put there.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.ts";

export type StageLists = Readonly<Record<string, readonly string[]>>;

/** The stages dvara marks itself, which no list names. */
export const OWN_STAGES: ReadonlySet<string> = new Set([
  "startup",
  "runtime-selection",
]);

/** A name a stage file line can carry: not empty, no tab or line break (records.ts splits on them). */
const isStageName = (name: unknown): boolean =>
  typeof name === "string" && name !== "" && !/[\t\r\n]/.test(name);

/** Each hook's names, from `value`; anything else is an error naming `field`. */
export const parseStageLists = (value: unknown, field: string): StageLists => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${field} must map each hook to its stage names`);
  const entries = Object.entries(value).map(
    ([hook, names]): [string, readonly string[]] => {
      if (!Array.isArray(names) || !names.every(isStageName))
        throw new Error(`${field}.${hook} must be a list of stage names`);
      return [hook, names];
    },
  );
  // fromEntries defines each key as its own, `__proto__` included.
  return Object.fromEntries(entries);
};

/** `hook`'s own list, never one inherited from Object's prototype (`toString`). */
export const listFor = (
  lists: StageLists,
  hook: string,
): readonly string[] | undefined =>
  Object.hasOwn(lists, hook) ? lists[hook] : undefined;

/**
 * The lists a run is checked against: the file `stageList` names, else
 * `stages`, else null (no lists: nothing is checked). A file that cannot be
 * read or parsed is an error naming it.
 */
export const readStageLists = (
  root: string,
  config: Pick<Config, "stages" | "stageList">,
): StageLists | null => {
  if (config.stageList === null)
    return Object.keys(config.stages).length > 0 ? config.stages : null;
  const path = resolve(root, config.stageList);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `dvara: cannot read the stage list ${path}: ${(error as Error).message}. Is the package that ships it installed?`,
    );
  }
  try {
    return parseStageLists(JSON.parse(text), "the stage list");
  } catch (error) {
    throw new Error(`dvara: ${path}: ${(error as Error).message}`);
  }
};

/**
 * Why `marked` breaks `hook`'s list, or null when it keeps to it. A stage may
 * be marked again where it stands (a loop), and a name may appear more than
 * once in a list; each mark takes the first place at or after the last one's.
 */
export const stageViolation = (
  hook: string,
  marked: readonly string[],
  lists: StageLists,
): string | null => {
  const names = marked.filter((name) => !OWN_STAGES.has(name));
  if (names.length === 0) return null;
  const list = listFor(lists, hook);
  if (list === undefined)
    return `${hook} marked stage "${names[0]}", but the stage list has no ${hook} list`;
  let at = 0;
  for (const [index, name] of names.entries()) {
    const found = list.indexOf(name, at);
    if (found >= 0) {
      at = found;
      continue;
    }
    if (!list.includes(name))
      return `${hook} marked stage "${name}", which its stage list does not have`;
    return `${hook} marked stage "${name}" after "${names[index - 1] ?? ""}", out of its stage list's order`;
  }
  return null;
};

export interface StageVerdict {
  /** Why the passing run is refused, or null. */
  readonly refusal: string | null;
  /** What the run could not check, printed and kept; or null. */
  readonly warning: string | null;
}

const PASS: StageVerdict = { refusal: null, warning: null };

/**
 * What the stage list says of a passing run of `hook` that marked `marked`.
 * With no stage of its own marked nothing is read. A list that cannot be read
 * refuses a hook in `required`, since a check that cannot run must not pass
 * there; any other hook passes with a warning saying it was not checked.
 */
export const stageVerdict = (
  hook: string,
  marked: readonly string[],
  lists: () => StageLists | null,
  required: readonly string[],
): StageVerdict => {
  if (marked.every((name) => OWN_STAGES.has(name))) return PASS;
  let read: StageLists | null;
  try {
    read = lists();
  } catch (error) {
    const message = (error as Error).message;
    return required.includes(hook)
      ? { refusal: message, warning: null }
      : {
          refusal: null,
          warning: `${message} ${hook}'s stages were not checked.`,
        };
  }
  if (read === null) return PASS;
  const violation = stageViolation(hook, marked, read);
  return violation === null
    ? PASS
    : { refusal: `dvara: ${violation}.`, warning: null };
};
