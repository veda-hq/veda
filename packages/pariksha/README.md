# @veda-hq/pariksha

परीक्षा, examination. Repository checks: doc drift, rule enforcement,
test-quality ratchets. Part of [Veda](https://github.com/veda-hq/veda).

```sh
npx @veda-hq/pariksha@0.5.2 <check> [flags]
npx @veda-hq/pariksha@0.5.2 --version
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

Only `.ts` and `.tsx` files are judged. Without `--files-from` every tracked
regular file is (not a symlink, not one deleted in the working tree), and a
tree with none in a category exits 2. With it, the listed paths are (one per
line or NUL-separated, relative to the root or absolute; `-` reads stdin, a
file path is relative to the current directory); a listed path that does not
exist or lies outside the root exits 2, and a listed symlink is skipped. The
JSON `--config` (relative to the root) replaces each default it names, and
refuses one that would judge nothing (no categories, an empty pattern, a
category needing no test):
`categories` (name to path regex, first match wins), `required` (category to
test kinds), `tests` (kind to candidate paths, `{dir}` and `{name}`),
`exclude` (path regexes), `aliases` (specifier prefix to a directory under the
importing file's nearest `package.json`), `maxHops` (default 1) and `hint` (a
line printed under a failure).

Needs `typescript` `>=5.4 <6`, the repository's own install first, else one
beside pariksha (an optional peer dependency: only the checks that read code
or tsconfig files load it). TypeScript 7 exports no stable compiler API yet,
so they exit 2 naming the installed version.

## `coverage-exemptions`

```sh
pariksha coverage-exemptions --config <file> [--package <dir>] [--root <dir>]
```

Each vitest config's `coverage.exclude` holds every pattern the product
exempts, and no production tsconfig's `include` brings those files back. The
JSON `--config` (relative to the root) names both lists:

```json
{
  "vitest": { "configs": ["apps/api/vitest.config.ts"], "requiredExcludes": ["**/*.test.ts", "**/__mocks__/**"] },
  "build": { "configs": ["apps/api/tsconfig.build.json"], "forbiddenIncludes": ["__mocks__", ".test."] },
  "loader": "tsx"
}
```

- Each vitest config is imported in its own Node process, in the config's
  folder, after `loader` when one is named (a relative path is the root's
  file; a package name resolves as `node --import` does), so a config that
  imports the product's TypeScript loads as the product's tooling loads it. A
  default export may be an object or a factory, sync or async. The answer
  comes back on fd 3, so nothing a config prints can pose as it, and the
  process exits once it answers. A config that fails to load is a finding,
  with its error; a loader that does not load exits 2.
- Each build config is read as TypeScript reads it (comments allowed); only
  its own `include` is judged, not one it `extends`.
- `--package <dir>` judges only the configs under that folder (a package's
  own run), which must be a normalized folder under the root.
- A listed config that is not a file, a tsconfig TypeScript cannot read, and
  a config naming no configs or empty lists exit 2.

Needs `typescript` for the build configs.

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

## `env-gate-switches`

```sh
pariksha env-gate-switches --config <file> [--mode staged|tree] [--root <dir>]
```

A hook that reads `PUSH_SKIP` from the environment has a bypass anyone can
type: `PUSH_SKIP=1 git push`. This check refuses gate code that READS an
environment variable whose name has a switch word (`X_SKIP`, `SKIP_X`,
`X_PROBE_Y`): writing or deleting one is not a read. The JSON `--config`
(relative to the root) says where gate code is:

```json
{
  "gatePaths": ["^\\.husky/", "^scripts/", "^\\.github/workflows/"],
  "notGateCode": ["\\.test\\.[cm]?[jt]sx?$", "(?:^|/)fixtures?/", "\\.md$"],
  "notAGate": {
    "SETUP_SKIP_MOBILE": { "files": ["scripts/setup.sh"], "reason": "installs no mobile toolchain; checks nothing" }
  },
  "words": ["SKIP", "PROBE"]
}
```

- `gatePaths` (required) and `notGateCode` are path regexes: a file is gate
  code when a gate path matches it and no `notGateCode` entry does.
- `notAGate` allows a switch that turns off something other than a check,
  in the files listed only, with the reason a reviewer reads; the same name
  anywhere else is still refused.
- `words` (default `SKIP` and `PROBE`) are upper-case words; a name made of
  `_`-joined words, one of them a switch word, is a switch.
- Shell (`.sh`, and every file under `.husky/`) is read as bash reads it:
  single quotes, escapes, comments and quoted heredoc bodies expand nothing,
  and a bare name in arithmetic (`(( X_SKIP ))`, `let`, `-eq`, a subscript)
  is a read. A variable the file initialises at the top level before reading
  it is the script's own decision, not a read; one initialised in a branch,
  loop, function, group, subshell, pipeline or the end of a `&&` list, or
  self-defaulted (`X_SKIP="${X_SKIP:-0}"`), is.
- TypeScript and JavaScript are read as a syntax tree, with a type checker
  over the one file: dotted, bracketed, optional, destructured and `in`
  reads count, through `process`, `globalThis.process`, `node:process` and
  any local bound to the environment, with constant keys resolved
  (`env['X_' + 'SKIP']`); a mention in a comment or string does not.
- Python reads are `os.environ[…]`, `os.environ.get(…)` and `os.getenv(…)`
  outside strings and comments (f-string fields are code); workflow YAML
  reads are `$X`, `env.X` and `env['X']` outside comments.

`tree` (the default) reads every tracked file in the working tree, skipping
one deleted there; a tree with no gate code exits 2, since the config would
check nothing. `staged` (for a pre-commit hook) reads the files the index
adds, copies, modifies or renames, as the index holds them. A gate file that
cannot be read, or a git call that fails, exits 2: an unread gate is never
clean. Needs `typescript` only when a TypeScript or JavaScript file is gate
code.

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
