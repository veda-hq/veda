// EVIDENCE-02: committed text cites no path or reference that stops meaning
// anything once the session that wrote it ends.
//
// A denylist only: whether a repository path resolves is another check's. This
// rule refuses what is non-durable by construction, in every text file that is
// not source code: `file://` URLs, a home directory (`/Users/<name>`,
// `/home/<name>`), sandbox temp roots, literal `.git/` paths, install commands
// of a package manager the repository does not use, and agent-process markers.
import type { PackageManager, RecordsConfig } from "../config.ts";
import { isCodePath } from "./scope.ts";
import type { Finding, Rule } from "./types.ts";

interface Pattern {
  /** The check's name, reported beside the rule's id. */
  readonly check: string;
  readonly re: RegExp;
  readonly what: string;
  /** Skip a match its clause says not to do ("never npm install"). */
  readonly negatable?: true;
  /** A match an allowed path covers is no finding. */
  readonly path?: true;
}

/** Each manager's install commands; a global install is not a dependency. */
const INSTALL: Readonly<Record<PackageManager, string>> = {
  npm: String.raw`npm\s+(install|i|ci|add)`,
  yarn: String.raw`yarn\s+(install|add)`,
  pnpm: String.raw`pnpm\s+(install|i|add)`,
};

const installPattern = (manager: PackageManager): Pattern => {
  const others = (Object.keys(INSTALL) as PackageManager[]).filter(
    (m) => m !== manager,
  );
  return {
    check: "install-command",
    re: new RegExp(
      String.raw`\b(${others.map((m) => INSTALL[m]).join("|")})\b(?!\s+(-g|--global)\b)`,
    ),
    what: `${others.join("/")} install: this repository installs with ${manager} only`,
    negatable: true,
  };
};

/**
 * Everywhere a reader may follow text: prose, data and configuration. Code
 * is not this rule's to read: a path there is a fixture, or a URI scheme the
 * code handles.
 */
const patterns = (manager: PackageManager | null): Pattern[] => [
  {
    check: "file-url",
    // `file://<placeholder>/…` is already anonymised by its writer.
    re: /\bfile:\/\/(?!<)/i,
    what: "a file:// URL resolves only on the machine that wrote it",
    path: true,
  },
  {
    check: "home-path",
    re: /(?<![\w.~-])\/Users\/(?!Shared\b)[A-Za-z0-9._-]+/,
    what: "a /Users/<name> home path names one machine and its operator",
    path: true,
  },
  {
    check: "home-path",
    // The hosted CI runner's home is the same on every run.
    re: /(?<![\w.~-])\/home\/(?!runner\b)[a-z_][a-z0-9._-]*\//,
    what: "a /home/<name> path names one machine and its operator",
    path: true,
  },
  {
    check: "temp-root",
    re: /(?<![\w.-])\/(private\/tmp|private\/var|var\/folders)\//,
    what: "a sandbox temp root is gone after the session",
    path: true,
  },
  {
    check: "git-path",
    re: /(?<![\w-])\.git\/(hooks|worktrees|objects|refs|index|config|info|logs|modules|HEAD)\b/,
    what: "a literal .git/ path is not the repository layout (worktrees move it)",
    path: true,
  },
  ...(manager === null ? [] : [installPattern(manager)]),
  {
    check: "agent-marker",
    re: /\b(I am|I'm|as) Agent[\s-]*\d+\b/i,
    what: "an agent-process marker is session narration, not a record",
  },
];

const NEGATION =
  /\b(never|not|no|don't|do not|instead of|rather than|refuse[sd]?|forbid(s|den)?|ban(s|ned)?)\b/i;

/** Whether the clause a match sits in says not to do it. */
const negated = (text: string, at: number): boolean => {
  // A negation covers its own clause only: in "never npm install; run yarn
  // install", the second instruction stands.
  const clauses = text.slice(0, at).split(/[;.!?]|\bbut\b/i);
  return NEGATION.test(clauses.at(-1) ?? "");
};

const scan = (
  file: string,
  text: string,
  list: readonly Pattern[],
  allowed: readonly RegExp[],
): Finding[] => {
  const found: Finding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    // One finding per line: `file:///Users/…` is one non-durable reference.
    for (const pattern of list) {
      // No pattern carries the `g` flag (`exec` would then keep state
      // across lines), so each scan takes a global copy.
      const match = [
        ...line.matchAll(new RegExp(pattern.re.source, `${pattern.re.flags}g`)),
      ].find(
        (m) =>
          !(pattern.negatable && negated(line, m.index)) &&
          !(pattern.path && allowed.some((a) => a.test(line.slice(m.index)))),
      );
      if (!match) continue;
      found.push({
        rule: "EVIDENCE-02",
        check: pattern.check,
        file,
        line: i + 1,
        message: `${pattern.what}: "${match[0]}"`,
      });
      break;
    }
  });
  return found;
};

/** EVIDENCE-02 under these settings: `allowPaths` and `packageManager`. */
export const durablePaths = (
  records: Pick<RecordsConfig, "allowPaths" | "packageManager">,
): Rule => {
  const list = patterns(records.packageManager);
  return (file, text) =>
    isCodePath(file) ? [] : scan(file, text, list, records.allowPaths);
};
