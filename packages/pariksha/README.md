# @veda-hq/pariksha

परीक्षा, examination. Repository checks: doc drift, rule enforcement,
test-quality ratchets. Part of [Veda](https://github.com/veda-hq/veda).

```sh
npx @veda-hq/pariksha@0.3.3 <check> [flags]
npx @veda-hq/pariksha@0.3.3 --version
```

Every check exits 0 when the repository passes, 1 when it refuses something
(each finding on stderr, with how to fix it), and 2 on a usage or input
error. `--root <dir>` (default: the current directory) names the repository.
Node 24 or later. MIT.

## `authority-citations`

```sh
pariksha authority-citations [--mode staged|tree] [--authority <a,b>]
  [--issue-prefix <A,B>] [--adr-dir <dir>] [--root <dir>]
```

A coherent fabrication passes every internal check: an agent that deletes a
public API and calls the deletion "an owner decision" is consistent with
itself. So a line that invokes an authority (`owner decision`,
`founder decided`, `product rule`, `approved by` / `decided by` /
`authorized by` / `mandated by` / `per` an office, a `--authority` name or an
`@handle`) must cite, within three lines, something only that authority could
have produced:

- resolved: a commit id naming a commit here, or `ADR-NNNN` /
  `<adr-dir>/NNNN` naming an existing `NNNN-*.md` other than the claiming file
  (default `docs/adr`);
- shape-checked: an issue id with a `--issue-prefix` (`ABC-123`), a GitHub
  pull request or issue URL, or `PR #123`.

`ALLOW-AUTHORITY-PHRASE: <reason>` in the window marks words used without
asserting authority; the reason is required. TypeScript, JavaScript, SQL,
Prisma, shell and Markdown files are read, outside `node_modules`, `dist`,
`build`, `coverage`, `generated`, `.tmp` and `.local`.

`staged` (the default, for a pre-commit or pre-merge-commit hook) judges only
the lines the commit adds; on a merge, only lines new against every parent,
so text a merged branch already carried is not judged again. `tree` judges
every tracked file. When git cannot read the change it exits 2.

## `boundary`

```sh
pariksha boundary [--root <dir>] [--deny <file>]
pariksha hash <word>
```

Refuses any file git tracks, by its path or its text, that names a word on
the repository's deny list.

- The deny list (default `.veda/deny.sha256`, relative to the root) holds one
  SHA-256 hash of a lowercase word per line; blank lines and `#` comments are
  ignored. `pariksha hash <word>` prints the line for a word.
- Words are runs of ASCII letters and digits, compared case-insensitively:
  `foo-bar`, `foo_bar` and `@Foo/bar` all contain the word `foo`.
- Binary files (any NUL byte) are skipped. Untracked files are not read.
  Line 0 in a finding is the file's path.

## `coverage-by-type`

```sh
pariksha coverage-by-type [--config <file>] [--files-from <file>|-] [--root <dir>]
```

A source file in a category needs the tests its category names: by default a
service, hook, utility or context a unit test, a repository a unit and an
integration test, a component or screen a UI (`.test.tsx`) test. A suite named
after its subject that never imports it is no test of it, so a candidate
counts only when it loads the subject at runtime, directly or through one
module it imports (a barrel, a collaborator). `import type`, a clause whose
every binding is type-only, and `typeof import()` load nothing and do not
count; `import()`, `require()`, `importActual` and `requireActual` do.

Without `--files-from` every tracked file is judged; with it, the listed paths
(one per line or NUL-separated, relative to the root; `-` reads stdin). The
JSON `--config` (relative to the root) replaces each default it names:
`categories` (name to path regex, first match wins), `required` (category to
test kinds), `tests` (kind to candidate paths, `{dir}` and `{name}`),
`exclude` (path regexes), `aliases` (specifier prefix to a directory under the
importing file's nearest `package.json`), `maxHops` (default 1) and `hint` (a
line printed under a failure).

Needs `typescript` `>=5.4 <6` installed beside it (an optional peer
dependency: only this check reads it). TypeScript 7 exports no stable compiler
API yet, so it exits 2 naming the installed version.

## `doc-budgets`

```sh
pariksha doc-budgets --table <file> [--section <name>] [--root <dir>]
```

Keeps the documents agents read on every turn inside a byte budget. The
budgets are one Markdown table, under `## Budgets` (or `--section`) in the
`--table` file:

```md
## Budgets

| Doc         | Budget |
| ----------- | -----: |
| `CLAUDE.md` | 9,000  |
```

Refuses a file over its budget, a budgeted file that does not exist, and a
row that is not `` | `path` | bytes | ``, since nothing would enforce it.
The table file is read on every check too, so it must budget itself: a row
for its own path (relative to `--root`) is required.

## `export-deletions`

```sh
pariksha export-deletions [--base <ref>] [--root <dir>]
```

An agent that removes a public function can remove its callers and their
tests too: everything typechecks and passes, so only a statement of intent
tells a correct removal from a coherent mistake. This check compares
`<base>...HEAD` and refuses an exported declaration (`export const`,
`function`, `class`, `interface`, `type`, `enum`) that is gone from every
TypeScript and JavaScript file at HEAD, unless a commit body in the range
declares it:

```text
Removes-Export: <symbol> — <why it is safe to remove>
Removes-File: <path> — <why the file is gone>
```

`Removes-File` covers every export of a file that no longer exists at HEAD.
A symbol still used anywhere (a move, a rename with its callers, a re-export)
is never reported; a mention in a comment does not count as a use. Bare
`export { a, b }` lists and files under `node_modules`, `dist`, `build`,
`coverage` and `generated` are not read. Without `--base`, the base is the
first of `origin/main`, `origin/develop`, `origin/master` and `main` that
exists. It reads the whole repository from any directory inside it, and
renames, colour, external diff tools and textconv in a user's git config
do not change what it reads. With no base, or when git cannot read the
range (no merge base, a shallow clone), it exits 2: nothing was checked,
so it is not a pass.
