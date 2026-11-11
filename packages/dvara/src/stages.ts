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
  const lists: Record<string, readonly string[]> = {};
  for (const [hook, names] of Object.entries(value)) {
    if (!Array.isArray(names) || !names.every(isStageName))
      throw new Error(`${field}.${hook} must be a list of stage names`);
    lists[hook] = names;
  }
  return lists;
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

/**
 * Why a passing run of `hook` that marked `marked` is refused, or null. With
 * no stage marked nothing is read; an unreadable list refuses the run, since
 * a check that cannot run must not pass.
 */
export const stageRefusal = (
  hook: string,
  marked: readonly string[],
  lists: () => StageLists | null,
): string | null => {
  if (marked.every((name) => OWN_STAGES.has(name))) return null;
  let read: StageLists | null;
  try {
    read = lists();
  } catch (error) {
    return (error as Error).message;
  }
  if (read === null) return null;
  const violation = stageViolation(hook, marked, read);
  return violation === null ? null : `dvara: ${violation}.`;
};
