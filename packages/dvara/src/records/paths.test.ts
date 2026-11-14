import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULTS, type RecordsConfig } from "../config.ts";
import { durablePaths } from "./paths.ts";
import type { TreeContext } from "./types.ts";

const tree: TreeContext = {
  typesOf: () => new Map(),
  onHistory: () => null,
  baseText: () => undefined,
};

const check = (
  path: string,
  text: string,
  records: Partial<RecordsConfig> = {},
) =>
  durablePaths({ ...DEFAULTS.records, packageManager: "pnpm", ...records })(
    path,
    text,
    tree,
  );

describe("EVIDENCE-02: durable paths", () => {
  it("finds each non-durable reference", () => {
    for (const [path, line] of [
      ["docs/x.md", "I am Agent 07 and I finished."],
      ["docs/x.md", "the hook at .git/hooks/pre-push"],
      ["docs/x.md", "the hook at ./.git/hooks/pre-push"],
      ["docs/x.md", "the hook at repo/.git/hooks/pre-push"],
      ["docs/x.md", "files under /private/var/folders/x"],
      ["docs/x.md", "home /home/someone/code"],
      ["docs/x.md", "home is /home/someone"],
      ["docs/x.md", "home is /home/someone."],
      ["docs/x.md", "home (/home/someone), then"],
      ["docs/x.md", "home `/home/someone`"],
      ["docs/x.md", "home is /home/some.one, then"],
      ["docs/x.md", "fetched into .git/FETCH_HEAD"],
      ["docs/x.md", "see .git/packed-refs"],
      ["docs/x.md", "Run `yarn add lodash`."],
      ["docs/x.md", "Never run npm install; run yarn install instead."],
      ["docs/x.md", "Never run npm install, but use yarn install."],
      ["docs/notes/run.txt", "cd /Users/someone/code"],
      ["docs/notes/run.json", '{"cwd": "/Users/someone/code"}'],
    ] as const)
      assert.equal(check(path, `${line}\n`).length, 1, `${path}: ${line}`);
  });

  it("reads no source file, whatever it names", () => {
    for (const path of ["docs/notes/run.mjs", "src/x.ts"])
      assert.deepEqual(
        check(path, "const root = '/Users/someone/code';\n"),
        [],
      );
  });

  it("leaves session scratch paths and durable ones alone", () => {
    for (const line of [
      "see .worktrees/abc/x",
      "log at /tmp/run.log",
      "under .local/state",
      "see .tmp/x.log and [log](../../.tmp/run.log)",
      "See `server/.env`.",
      "see feature/x-y and HEAD~3",
      "frame node_modules/react-dom/cjs/react-dom-client.development.js:8030:22",
      "    at file://<worktree>/node_modules/x.js:1:1",
      "The cache lives in `/home/runner/.cache/pnpm`.",
      "The runner's home is /home/runner.",
      "Nothing in the `.git/` folder is committed.",
      "Shared files sit in /Users/Shared/x.",
      "Run `npm install -g some-cli`.",
      "Never run `npm install` here.",
    ])
      assert.deepEqual(check("docs/x.md", `${line}\n`), [], line);
  });

  it("lets a negation cover its own clause", () => {
    assert.deepEqual(
      check("docs/x.md", "Use pnpm install instead of npm install.\n"),
      [],
    );
  });

  it("allows a machine path the config names, and no sibling of it", () => {
    const allowPaths = [/^\/private\/tmp\/shared\/turbo(?![\w.-])/];
    assert.deepEqual(
      check("docs/x.md", "Set `/private/tmp/shared/turbo` once.\n", {
        allowPaths,
      }),
      [],
    );
    for (const path of [
      "/private/tmp/shared/turbo-old/",
      "/private/tmp/shared/x",
      "/private/var/shared/turbo",
      "/var/folders/shared/turbo",
    ])
      assert.equal(
        check("docs/x.md", `at ${path}\n`, { allowPaths }).length,
        1,
        path,
      );
    // An allowed path covers itself only: a second one on the line still counts.
    assert.deepEqual(
      check("docs/x.md", "/private/tmp/shared/turbo, then /private/tmp/x\n", {
        allowPaths,
      }).map((f) => f.message),
      ['a sandbox temp root is gone after the session: "/private/tmp/"'],
    );
    // An install command is no path: an allowed pattern does not cover it.
    assert.equal(
      check("docs/x.md", "run npm install\n", { allowPaths: [/^npm/] }).length,
      1,
    );
  });

  it("finds one reference per line, on CRLF lines too", () => {
    assert.deepEqual(
      check(
        "docs/x.md",
        "see file:///Users/someone/x\r\nok\r\nat /home/someone/x/\r\n",
      ).map((f) => [f.line, f.message]),
      [
        [
          1,
          'a file:// URL resolves only on the machine that wrote it: "file://"',
        ],
        [
          3,
          'a /home/<name> path names one machine and its operator: "/home/someone/"',
        ],
      ],
    );
    assert.deepEqual(check("docs/x.md", "no path here\n"), []);
  });

  it("reports each check as one exact finding", () => {
    for (const [line, check_, message] of [
      [
        "see file:///etc/x",
        "file-url",
        'a file:// URL resolves only on the machine that wrote it: "file://"',
      ],
      [
        "at /Users/someone/x",
        "home-path",
        'a /Users/<name> home path names one machine and its operator: "/Users/someone"',
      ],
      [
        "at /home/someone/code",
        "home-path",
        'a /home/<name> path names one machine and its operator: "/home/someone/"',
      ],
      [
        "it ran as /home/someone.",
        "home-path",
        'a /home/<name> path names one machine and its operator: "/home/someone"',
      ],
      [
        "at /private/var/folders/x",
        "temp-root",
        'a sandbox temp root is gone after the session: "/private/var/"',
      ],
      [
        "the .git/hooks/pre-push hook",
        "git-path",
        'a literal .git/ path is not the repository layout (worktrees move it): ".git/hooks"',
      ],
      [
        "read .git/FETCH_HEAD after the fetch",
        "git-path",
        'a literal .git/ path is not the repository layout (worktrees move it): ".git/FETCH_HEAD"',
      ],
      [
        "run npm install",
        "install-command",
        'npm/yarn install: this repository installs with pnpm only: "npm install"',
      ],
      [
        "I am Agent 07.",
        "agent-marker",
        'an agent-process marker is session narration, not a record: "I am Agent 07"',
      ],
    ] as const)
      assert.deepEqual(check("docs/x.md", `Title\n${line}\n`), [
        {
          rule: "EVIDENCE-02",
          check: check_,
          file: "docs/x.md",
          line: 2,
          message,
        },
      ]);
  });

  it("refuses the install commands of every manager but the configured one", () => {
    const messages = (packageManager: RecordsConfig["packageManager"]) =>
      ["npm install", "yarn add x", "pnpm add x", "pnpm i"].map((line) =>
        check("docs/x.md", `${line}\n`, { packageManager }).map(
          (f) => f.message,
        ),
      );
    assert.deepEqual(messages("npm"), [
      [],
      ['yarn/pnpm install: this repository installs with npm only: "yarn add"'],
      ['yarn/pnpm install: this repository installs with npm only: "pnpm add"'],
      ['yarn/pnpm install: this repository installs with npm only: "pnpm i"'],
    ]);
    assert.deepEqual(messages("yarn"), [
      [
        'npm/pnpm install: this repository installs with yarn only: "npm install"',
      ],
      [],
      ['npm/pnpm install: this repository installs with yarn only: "pnpm add"'],
      ['npm/pnpm install: this repository installs with yarn only: "pnpm i"'],
    ]);
    // None configured: install commands are not this rule's to judge.
    assert.deepEqual(messages(null), [[], [], [], []]);
  });

  it("knows every install verb of each manager, and no other verb", () => {
    const found = (line: string, packageManager: "npm" | "pnpm") =>
      check("docs/x.md", `${line}\n`, { packageManager }).map((f) =>
        f.message.split(": ").at(-1),
      );
    for (const [line, packageManager] of [
      ["npm i lodash", "pnpm"],
      ["npm ci", "pnpm"],
      ["npm add lodash", "pnpm"],
      ["yarn install", "pnpm"],
      ["pnpm install", "npm"],
    ] as const) {
      const verb = line.split(" ").slice(0, 2).join(" ");
      assert.deepEqual(found(line, packageManager), [`"${verb}"`], line);
    }
    for (const line of ["npm init", "npm info x", "yarn ci", "pnpm ci"])
      assert.deepEqual(
        found(line, line.startsWith("pnpm") ? "npm" : "pnpm"),
        [],
        line,
      );
  });
});
