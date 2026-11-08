# @veda-hq/pariksha

परीक्षा, examination. Repository checks: doc drift, rule enforcement,
test-quality ratchets. Part of [Veda](https://github.com/veda-hq/veda).

```sh
npx @veda-hq/pariksha@0.3.0 <check> [flags]
npx @veda-hq/pariksha@0.3.0 --version
```

Every check exits 0 when the repository passes, 1 when it refuses something
(each finding on stderr, with how to fix it), and 2 on a usage or input
error. `--root <dir>` (default: the current directory) names the repository.
Node 24 or later. MIT.

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
exists; with none, nothing is checked.
