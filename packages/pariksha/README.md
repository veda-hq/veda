# @veda-hq/pariksha

परीक्षा, examination. Repository checks: doc drift, rule enforcement,
test-quality ratchets. Part of [Veda](https://github.com/veda-hq/veda).

```sh
npx @veda-hq/pariksha@0.7.14 <check> [flags]
npx @veda-hq/pariksha@0.7.14 --version
```

Every check exits 0 when the repository passes, 1 when it refuses something
(each finding on stderr, with how to fix it; `absolute-paths`,
`non-synced-resources`, `license-check` and `codeql-baseline` print theirs on
stdout, as the scripts they were ported from did), and 2 on a usage or input
error. `--root <dir>` (default:
the current directory) names the repository. Node 24 or later. MIT; one
ported file is ISC, see `NOTICE`.

## The config file

One committed file, `.pariksha.json`, holds every check's settings, so a hook
or a CI step runs `pariksha <check> --staged` and names no settings file.

```json
{
  "checks": {
    "shell-gates": "config/shell-gates.json",
    "authority-citations": { "authority": ["Dana"], "issuePrefix": ["ACME"] },
    "doc-budgets": { "table": "docs/standards/budgets.md" }
  }
}
```

- **Where.** `.pariksha.json` at the top level of the git repository holding
  the working directory (the working directory itself outside one), or the
  file the `PARIKSHA_CONFIG` environment variable names (relative to the
  working directory). It is never looked for under `--root`, which a hook may
  point at a snapshot of the index: the settings are the checkout's.
- **Entries.** `checks` maps a check's name to its settings: a path, relative
  to the config file's folder, to a file holding what the check's `--config`
  file would hold, or the same settings inline. A path may lead into
  `node_modules`, so a shared package can hold them; a `package.json` change
  then widens a selection as a change to the file would (see Choosing files).
- **Flag-only checks.** `authority-citations` reads `authority` and
  `issuePrefix` (a string, or a list of strings) and `adrDir`; `doc-budgets`
  reads `table` and `section`; `codeql-baseline` reads `baseline`. Each is
  the flag of the same name. `table` and `baseline` are files, read from the
  config file's folder as an entry's path is;
  `adrDir` is the folder citations name, under `--root`.
- **Precedence.** `--config` on the command line wins over the entry, and a
  flag over a field. The entry wins over the check's built-in default.
- **Errors.** A key other than `checks` (and `$schema`), a check that takes
  no settings or does not exist, or an entry that is neither a path nor an
  object exits 2. The message names the key and the pariksha version, so a
  file written for a newer pariksha says so. So does a missing file
  `PARIKSHA_CONFIG` names. With no file and no variable, every check runs on
  its defaults.
- Checks that take no settings (`boundary`, `export-deletions`,
  `python-floor`, `required-settings`, `schema-roots`) never read the file.

## Choosing files

`absolute-paths`, `non-synced-resources`, `coverage-by-type`,
`duplicate-tests`, `flaky-tests` and `repo-rules` judge a list of files. Beside
`--files-from`, each takes one of:

- `--staged`: the files the index adds, changes or renames (by the new path);
- `--base <ref> [--head <ref>]`: the files `head` (default `HEAD`) changes
  since its merge base with `ref`;
- `--all`: every file git tracks.

The files are listed relative to `--root`, as a `--files-from` list names
them, so a check's `include` sees `docs/a.md`, not an absolute path.
Deleted files, symlinks and submodules are never listed. A ref that starts
with `-`, or names no commit, exits 2, and so does a git that fails: a
listing that failed never reads as "no files". When the selection changes
the file the check's settings are read from, the check judges every tracked
file instead: a tightened check meets the code it did not change. That file
is the one `--config` or the entry names; for an inline entry it is
`.pariksha.json` itself. So an edit to one file entry, or to another check's
entry, widens no other check's run. For a settings file git does not track
(outside the checkout, or ignored, as under `node_modules/`), a change to the
top-level `package.json`, which the pin bump that changes it edits, stands in
for one to the file. `duplicate-tests` and `flaky-tests`
never widen: comparing every pair of tests, or rerunning every test, outlasts
a CI step, so they judge the selection as listed.

## `absolute-paths`

```sh
pariksha absolute-paths [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--root <dir>]
```

A document that points at `/Users/me/notes.md` points at something only its
writer has. This refuses a line naming a path on a local machine: `file://`,
`/Users/`, `/home/<name>/`, `/tmp/<x>`, `/var/<x>`, `/private/var`, `~/`, or a
drive (`C:\x`). Not refused: a line inside a fenced block (between lines that
start with three backticks), a path in an inline code span, and a line that
says it is an example (`forbidden`, `example`, `not allowed`, `should not`,
`must not`, in any case). Only the first path on a line is tested for a code
span, and a `/tmp/<x>` or `/var/<x>` path runs to the next `/`, so
`` `/tmp/x` `` alone on a line is refused: the shell check this was ported
from read it so.

The documents are the ones `--files-from` lists, one path per line (a file,
or `-` for stdin; relative paths are read from the root), or with no list
every file git tracks; a listed path that is not a regular file is dropped.
The JSON `--config` (relative to the root) is optional:

```json
{
  "include": "\\.(md|mdx)$",
  "guidance": ["Please use relative paths only.", "See docs/WRITING.md."]
}
```

- `include` (default `\.(md|mdx)$`) is the regex a listed path must match to
  be a document.
- `guidance` (default one line asking for relative paths) is printed after a
  refusal.

The report goes to stdout: `→ Checking …`, `Checking N documentation
file(s)...`, then each finding as `file:line:text`. It exits 1 on a finding,
0 with none or nothing to check, and 2 on a bad config, an unreadable list,
or no list outside a git repository.

## `aggregate-gate-needs`

```sh
pariksha aggregate-gate-needs [--config <file>] [--root <dir>]
```

A merge queue that requires one aggregate status, a workflow's "CI Gate",
lets through any job that gate does not wait on: a job missing from its
`needs:` cannot block a merge however it fails, and an upstream failure turns
into a skip downstream that the gate accepts. Each shows a green required
check. In every `.yml` and `.yaml` workflow, a gate (a job whose `name:`, or
id, matches `gateName`) is refused when its `needs:` leaves out a job other
than another gate or a `nonGating` one, or when it reads a job's result
without declaring it: `needs.<id>` or `needs['<id>']` in the job's `if:`, a
step's `if:`, or any `${{ … }}` in the job, outside quoted literals. Text in
a `run:` script and an action input named `if` are not reads. A non-gating
job (a change detector) need not be gated, but must be declared once read.

The same command refuses a workflow that holds a gate and can also be
dispatched (`workflow_dispatch` in `on:`, as one event, in a list or as a
key), one line per gate under its own id, `dispatch-on-gate-workflow`. A
dispatch run from a branch with an open pull request posts every job's check
on the head commit, the gate among them as skipped, and that replaces the
pull request run's success: a merge queue requiring the gate reads it as
failed and dequeues the pull request. Ad-hoc runs belong in a separate
workflow with no gate-named job.

```json
{ "id": "CI-001", "workflowsDir": ".github/workflows", "gateName": "gate$", "nonGating": ["detect-changes"], "dispatchAllowed": [] }
```

- `id` (default `aggregate-gate-needs`) names the check in its messages: a
  project's rule id, say. The dispatch refusal keeps its own id.
- `workflowsDir` (default `.github/workflows`, relative to the root).
- `gateName` (default `gate$`) is a regex, matched case-insensitively.
- `nonGating` (default none) lists job ids that gate nothing.
- `dispatchAllowed` (default none) lists workflow file names (`release.yml`)
  that may be dispatched beside a gate: one no merge queue requires, such as
  an approval gate in a release workflow.

A workflow that does not parse is reported as a gap, never passed. No
workflow to read exits 1 (`no workflow files found — the lookup failed`),
as the original did; a bad config exits 2. The clean line is unchanged: it
prints only when both refusals find nothing.

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

A chat answer is not a citation: the refusal asks for the authority's comment
on the pull request or issue, and its URL. `ALLOW-AUTHORITY-PHRASE: <reason>`
in the window marks words used without asserting authority, never a claim
reworded to pass; the reason is required. TypeScript, JavaScript, SQL,
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

## `bp-rules`

```sh
pariksha bp-rules <mode> [--config <file>] [--root <dir>]
```

The mechanical half of a best-practice rule corpus: one Markdown file per
rule, with YAML-like frontmatter (`id`, `title`, `category`, `severity`,
`enforcement`, `enforcement_script`, `verified`, `verify_by`, `sources`,
`applies_to`, `status`, `deprecated_at`), and an index document with a table
per section and a Summary table derived from them. Judging a rule stays with
people and agents; this parses, filters, compares dates and counts, each with
one right answer. A rule is enforced when a hook or CI checks it
(`enforcement: eslint-rule` or `validator`) and guidance otherwise; one that
names no tier is guidance. A `README` file in the corpus is not a rule.

```json
{ "rules": "docs/standards/best-practices", "index": "docs/standards/BEST_PRACTICES.md", "idPrefix": "BP" }
```

All three are required (pariksha ships no corpus): the corpus folder and the
index, under `--root`, and the id family, so ids read `BP-SEC-001`. A rule's
section is the first folder under `rules`; index links are relative to the
index's folder.

| Mode | Prints | Exits 1 when |
| ---- | ------ | ------------ |
| `--inventory` | every rule, projected, with counts by tier | |
| `--gaps` | active guidance rules, critical first | |
| `--due [--within <days>] [--today <YYYY-MM-DD>]` | rules whose `verify_by` has passed, falls within the window (30 days), or is missing | |
| `--next-id <PREFIX>` | the next `<idPrefix>-<PREFIX>-NNN` | |
| `--corpus-fingerprint` | a sha1 over every rule file's path and bytes | |
| `--check-wiring [--ids <a,b>]` | each `validator` rule and each rule naming an `enforcement_script`, and the scripts missing under `--root` | a script is missing, or an id names no rule |
| `--regenerate-index` | the index with its rows, `(N rules)` counts and Summary rebuilt, everything else kept | a rule has no section to go in (named on stderr) |
| `--check-index` | the Summary as written against the one the rows give | they differ (with the command that recomputes it) |

Every mode prints JSON except `--regenerate-index`, which prints the index
itself, written as it is so `pariksha bp-rules --regenerate-index >
.tmp/index.md` round-trips byte for byte. Exit 2 on a usage error (no mode,
two modes, an option outside its mode, a `--today` that is no real date),
no settings or bad ones, or a read that fails.

## `codec-registry`

```sh
pariksha codec-registry --config <file> [--base <ref> | --no-base] [--root <dir>]
```

A module that parses markdown with its own regexes passes every example its
author thought of, and misses the setext heading nobody did. So every module
that hand-parses a format must be held by a property suite to the format's
reference parser, and every exported writer/reader pair (`writeX`/`readX`,
`renderX`/`parseX`, `formatX`/`loadX`…) by a suite that feeds real writer
output through the real reader. Discovery reads tracked source under `roots`
as a TypeScript syntax tree (tests, declarations, fixtures and mocks are not
read):

- a hand parser is a regex literal that reads a format's syntax (an ATX
  heading or a fence, a frontmatter delimiter, a tag, an import statement), a
  string literal that delimits one by itself (`---`, a fence, `<script`), a
  comma split in a module that says `csv`, or a tokenizer tracking both quote
  kinds and the backslash in a module about shell commands: one id per module
  and format, `path#format`, in the formats `oracles` names only;
- a pair is an exported producer and consumer of the same stem,
  `path#writeRow->readRow` (an `export { … }` list counts; a class, a constant
  or a type-only export does not), and `path#digest` for a module that calls
  `createHash` beside a numeric `*SCHEMA*` export or a `'schema'` argument.

Each id is registered, exempt with a reason, or listed in the baseline, and
the baseline lists exactly what is still unregistered. The JSON `--config`
(relative to the root):

```json
{
  "baseline": "scripts/codec-registry.baseline.json",
  "roots": ["scripts", "src"],
  "oracles": { "markdown": "mdast-util-from-markdown", "yaml": "js-yaml" },
  "collected": ["^scripts/.+\\.test\\.ts$"],
  "surfaces": ["scripts/**/*.{differential,roundtrip}.properties.test.ts"],
  "library": "fast-check",
  "markers": { "seed": "seed: SEED", "lineEndings": "LINE_ENDINGS", "golden": "assertGolden" },
  "handParsers": [{ "source": "scripts/doc.ts", "formats": ["markdown"], "suite": "scripts/doc.differential.properties.test.ts", "outOfModel": "lists and block quotes", "motivatedBy": "M1234567890" }],
  "pairs": [{ "id": "scripts/rows.ts#writeRow->readRow", "kind": "round-trip", "suite": "scripts/rows.roundtrip.properties.test.ts" }],
  "exempt": [{ "id": "scripts/main.ts#csv", "reason": "a comma list in an env var, not CSV" }],
  "minNoteLength": 21,
  "examples": { "catalogue": { "path": "checks.json", "slice": "C-20" }, "fixtures": { "EDGE-12": { "example": "V3586514538", "test": "scripts/edge-12.examples.test.ts" } } },
  "findingIds": { "motivatedBy": "^M\\d{10}$", "example": "^[MV]\\d{10}$" }
}
```

- A hand-parser suite sits where a `collected` pattern matches it and on a
  `surfaces` glob, imports its module by a relative specifier that resolves
  to it, imports `library` (default `fast-check`), names each format's oracle
  module, holds the `seed` marker, and holds the `lineEndings` marker unless
  `lfOnly` says why the suite runs LF only. `outOfModel` (what the generators
  leave out) is required.
- A pair's `kind` follows from its id and is refused otherwise: a
  `producer->consumer` pair is `round-trip`, a `#digest` is `golden`. A
  `round-trip` suite does what a hand-parser suite does less the oracle and
  line endings; a `golden` one needs only its module and the `golden` marker.
- A suite's imports are read from its syntax tree: import declarations,
  `export … from` and `import('…')` of a literal. A specifier in a comment
  or another string, or a type-only import, is no import.
- `minNoteLength` is the fewest characters (trimmed) an exemption `reason`,
  an `outOfModel` or an `lfOnly` may have: at 21, as here, `"reason": "not
  csv"` is refused and the reason above passes. At 1 only a blank is refused.
- `examples` holds a fixture per check: its suite exists, is collected and
  names the finding id; with a `catalogue`, the fixtures cover exactly that
  JSON's checks for its `slice` (`{ "checks": [{ "id", "slice", "example" }]
  }`, each example opening with `<finding id>:`), and `"catalogue": null`
  checks the fixtures alone.
- `findingIds.motivatedBy` holds every `motivatedBy`, and `findingIds.example`
  every example fixture's id, to its own pattern.
- `surfaces`, `examples`, `findingIds` and each pattern in it are required, so
  a forgotten key never drops a check silently. `null` opts a check out, and
  the run prints it on its own line: `not checked: surfaces, examples`.
- Messages name the kind (`hand parser scripts/doc.ts: …`, `pair
  scripts/rows.ts#writeRow->readRow: …`), never a repository's check ids.

Refused (exit 1): a discovered id that is unaccounted; a registered or exempt
id discovery does not find; a suite that is missing, uncollected, off the
surface or missing any part above; a baseline entry that is registered,
exempt, gone or in the wrong list (each list is held to what discovery finds
of its kind); and a baseline entry the merge base of HEAD and the base did
not have, in any list, unless its file only moved (git's rename detection
over the working tree; the file is the id before its last `#`, so a path may
hold one). Without `--base`, the base is the first of `origin/main`,
`origin/develop`, `origin/master` and `main` that exists.

Growth is read against the merge base, so growth committed on the branch is
refused like growth in the working tree. The merge base's baseline is read
against today's lists: a list it lacks is empty (an entry in it today is
growth) and a list no longer named is ignored. Where the merge base has no
file at `baseline`, the baseline is being introduced and nothing has grown;
so pointing `baseline` at a new path also compares no growth for that run.
`--base HEAD` compares the tree with HEAD alone: committed growth passes and
only uncommitted growth is refused. `--no-base` compares no growth and needs
no base; the run prints `not checked: baseline growth (--no-base)`. `--base`
with `--no-base`, and an empty `--base ""`, are usage errors.

Exit 2, since nothing was checked: a config with an unknown, missing or bad
key, a path that is not a normalized root-relative POSIX path (a backslash or
a NUL included), a pair `kind` its id does not fit, an exemption,
`outOfModel` or `lfOnly` shorter than `minNoteLength`, an id registered twice; a baseline that is missing or not `{ "handParsers":
[ids], "pairs": [ids] }` with no other list; a merge-base baseline whose
lists are malformed; a root holding no tracked file; discovery finding no
hand parser, or no pair, since a kind found nowhere is checked nowhere; no
base without `--no-base`; a git call that fails. Needs `typescript`, as
`coverage-by-type` does.

## `codeql-baseline`

```sh
pariksha codeql-baseline --check <results.sarif> [--baseline <file>] [--root <dir>]
pariksha codeql-baseline --write <results.sarif> [--baseline <file>] [--root <dir>]
```

A CodeQL gate that counts results whose `level` says `error` counts none:
CodeQL leaves `level` out when it equals the rule's default, which is how it
writes every alert. This reads each result's effective level (SARIF 2.1.0
§3.27.10: the result's `level`, else the rule's
`defaultConfiguration.level` from the driver or an extension, else
`warning`) and refuses, with `--check`, every error-level alert the
committed baseline does not hold. The alerts an existing codebase already
has go in the baseline, so they do not block while a new one does.

- **Identity.** An alert is its rule, its file and CodeQL's
  `primaryLocationLineHash` (the line's number when there is none). The hash
  reads the line's content, so an edit elsewhere in the file keeps a known
  alert known. The baseline is a multiset: a second copy of a baselined alert
  is new.
- **Suppressions.** A result with an accepted suppression (a missing
  `status` means accepted, SARIF §3.35) blocks nothing and is never written
  to the baseline. CodeQL writes one for a result under a
  `// codeql[rule-id]` comment only when the analysis includes
  `codeql/javascript-queries:AlertSuppression.ql`.
- **`--write`** regenerates the baseline from a scan, sorted, so an unchanged
  scan writes the same bytes. Write it from a scan of the main branch, never
  by hand. A baseline alert no longer reported is counted on `--check`'s
  first line, as a reminder to regenerate.
- **`--baseline`** (default `.github/codeql/error-baseline.json`) is read
  from `--root`. Its `.pariksha.json` entry is `{ "baseline": "<path>" }`,
  read from the config file's folder.

The verdict goes to stdout, as in the script this was ported from. A SARIF
log with no runs is a broken analysis, never a clean one: exit 1 on
`--check`. A SARIF log or a baseline that cannot be read or is not JSON, a
baseline that is not `{ "alerts": [...] }`, and a log `--write` cannot
write from exit 2. The module (`@veda-hq/pariksha/dist/codeql-baseline.js`)
exports `checkSarif`, `readBaseline` and `ALERT_SUPPRESSION` for a
pre-push scan that judges the same way.

## `coverage-by-type`

```sh
pariksha coverage-by-type [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--root <dir>]
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

## `doc-references`

```sh
pariksha doc-references --config <file> --staged [--checks <ids>] [--root <dir>]
pariksha doc-references --config <file> --base <ref> [--head <ref>] [--checks <ids>] [--root <dir>]
pariksha doc-references --config <file> --all [--update-baseline | --write-baseline] [--checks <ids>] [--root <dir>]
```

A doc that names a file, a script or a function the repository no longer
has reads as true and sends its reader into a broken step. Three checks read
the docs and code comments the config's `files` select:

- `DOC-DRIFT-01`, paths and links. A path in backticks (in prose, a shell
  fence, frontmatter or a code comment), a glob, or `file.ts:12` resolves
  beside the doc, above it, at the root or from a workspace; a cited line
  exists, and a backticked symbol beside it is near that line. Relative
  Markdown links and their `#anchor`s are checked by
  [lychee](https://lychee.cli.rs), offline, which must be on `PATH` (set
  `links` to `null` to leave links out). A path the tracked `.gitignore`
  rules cover is out of scope.
- `DOC-DRIFT-02`, commands. A `pnpm <script>` exists in the scope it runs
  from (a workspace script needs `--filter`; bins in `node_modules/.bin`
  count everywhere), and a verification step does not run a script that
  rewrites the tree (`mutating`). A command a doc shows runs as written:
  `--filter` before the script name, every `--flag` read by the script it
  reaches (through a package script or an interpreter), required argparse
  flags present, enum values and first-positional actions the script
  accepts, and, with `typescriptRunner` set, a `.ts` file started through it.
- `DOC-DRIFT-04`, identifiers. A single-identifier code span in prose
  (`DATABASE_URL`, `parseArgs()`, `OrderService`) occurs as a whole word in
  the tracked code, or in the file the doc cites for it ("`x` in `y.ts`").
  Optional kinds: Prisma `Model.field`, `@@unique([…])`, migration folders and
  `@Roles(…)` values; routes (`GET /stores/:id`) against controller
  decorators; CI jobs ("the `build` job"); packages against workspace names
  and the lockfile.

A line ending in `<!-- doc-ref-ok: <why> -->` (in code, a comment holding
`doc-ref-ok: <why>`; the word is the config's `exemptMarker`) names
something absent on purpose. Placeholders (`<id>`, `NNN`) and illustrative
names (`src/foo.ts`) are never references.

Modes. `--staged` (a commit) reads the index: staged docs and comments,
and any doc naming a path the commit deletes or renames, under
DOC-DRIFT-01 and -02. During a merge, what the merge took unchanged from the
merged branch is that branch's to judge. `--base` (a push, CI) reads the
`--head` tree (default `HEAD`) against its merge base with `--base`: changed
docs, and docs naming a deleted or renamed path, a changed file by
`name:line`, or an identifier, script or `--flag` the diff removed, under
all three checks; a finding the merge base already had is not this push's.
`--all` reads every reference file in the worktree; it alone may lower the
baseline (`--update-baseline`) or seed it (`--write-baseline`). `--checks`
takes a comma-separated subset (`01,02`).

The baseline is a JSON file of per-file counts, `{ "version": 1, "files":
{ "docs/old.md": { "DOC-DRIFT-01": 3 } } }`, for references that predate
the check. A checked file may not exceed its count; a file a change touches
must lower a count it no longer needs; the baseline may only lose entries or
lower counts against the merge base; an entry for a file the change removed
must go. The JSON `--config` (relative to the root):

```json
{
  "baseline": "scripts/doc-references-baseline.json",
  "exemptMarker": "doc-ref-ok",
  "files": {
    "markdown": ["\\.(md|mdx)$"],
    "html": ["^(?:.*/)?docs/.*\\.html$"],
    "code": ["\\.(ts|tsx|js|mjs|sh|py)$"],
    "codeExclude": ["\\.(test|spec)\\.[jt]sx?$"],
    "exclude": ["(^|/)node_modules/", "(^|/)fixtures?/", "^docs/history/"],
    "hashComments": "\\.(sh|py)$"
  },
  "placeholder": "[<>${}%…]|\\.\\.\\.|NNN",
  "paths": {
    "extensions": ["ts", "js", "json", "md", "sh", "py", "yml", "yaml"],
    "examples": { "pattern": "(^|/)(foo|bar|example)(\\.[\\w.]+)?$", "flags": "i" },
    "untracked": [".claude/worktrees/"],
    "workspaces": "^(apps|packages)/[^/]+/package\\.json$",
    "layouts": [{ "pattern": "^evidence/[A-Z]-\\d{2}", "except": "^docs/work/" }]
  },
  "links": { "include": "\\.md$" },
  "scripts": {
    "manifests": ["package.json", "apps/api/package.json"],
    "mutating": { "lint": "lint:ci", "format": "format:check" },
    "verification": { "pattern": "verif|check|gate", "flags": "i" },
    "wrappers": []
  },
  "commands": { "typescriptRunner": "pnpm exec tsx", "nested": ["vitest", "turbo", "git"] },
  "identifiers": {
    "notIdentifiers": ["GitHub", "TypeScript"],
    "searchExclude": ["\\.(md|mdx|html)$", "^docs/", "^pnpm-lock\\.yaml$"],
    "diffExclude": ["*.md", "docs/**"],
    "prisma": { "schemas": "^apps/api/prisma/.*\\.prisma$", "migrations": "apps/api/prisma/migrations", "roles": { "schema": "apps/api/prisma/schema.prisma", "enum": "Role" } },
    "routes": { "controllers": "^apps/api/src/.*\\.controller\\.ts$", "prefixes": "^(api|v\\d+)$" },
    "jobs": { "workflows": "^\\.github/workflows/[^/]+\\.ya?ml$" },
    "packages": { "manifests": "^(?!(?:.*/)?node_modules/)(?:.*/)?package\\.json$", "lockfile": "pnpm-lock.yaml", "ownScopes": ["@acme/"] }
  }
}
```

- `files`: what a tracked path is, first match winning after `exclude`:
  Markdown (and Markdown-like XML), HTML pages, or code whose comments are
  read (`codeExclude` drops tests and fixtures, which name absent paths on
  purpose). `hashComments` is the code whose comments start with `#`.
- `paths`: the extensions a backticked path may end in; `examples` and
  `untracked` names that are never a tracked file; `workspaces`, the
  manifests whose folders (and `src`) a path also resolves from;
  `layouts`, paths that name a folder layout rather than a file outside the
  docs `except` matches.
- `scripts.wrappers`: repository scripts that run the rest of a line as a
  command (`pnpm dev:exec pnpm x`). `commands.nested`: programs a wrapper
  script hands its remaining words to, so they are not its own flags.
- `identifiers.searchExclude`: tracked text that defines no name (prose,
  data, sources that quote wrong names on purpose); binaries and the
  baseline are never read. `diffExclude`: pathspecs the removed-identifier
  diff leaves out.
- `links`, `commands.typescriptRunner`, and each of `identifiers.prisma`
  (and its `migrations` and `roles`), `routes`, `jobs`, `packages` (and its
  `lockfile`) may be `null`, which leaves that part unchecked and says so on
  stdout. Absent, each is refused.

On a pass, stdout has one line, `pariksha doc-references: <n> reference
file(s) checked (<staged|pushed|all>), no new problem; the baseline does not
grow`. Each refusal is a stderr line, `pariksha doc-references:
<file>:<line>: [<check>] <ref>: <reason>`, then what to do. Refused (exit 1):
a reference over its file's count, a count a touched file no longer needs,
baseline growth, and an entry for a removed file. Exit 2: a bad flag set or
config (an unknown, missing or bad key or pattern), a malformed baseline, no
`node_modules/.bin` (DOC-DRIFT-02 would know no bin), a missing or failing
lychee, a `--base` with no merge base, or a failed git call.

## `duplicate-tests`

```sh
pariksha duplicate-tests [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--root <dir>]
```

A test copied rather than written: two tests whose matchers, names and
describe paths score at or above the threshold (default 0.85; across two
files never below 0.95). The score weighs the matcher set (`expect()` and
every `.to…()` call in the test, Jaccard) at 50%, the name at 20% and the
describe path at 30% (edit distance); `describe(X.name)` names its block `X`,
and two tests in no describe block compare their file stems. A pair is not
compared when either test has fewer than three matcher calls, either name is
generic (`should return`, …), the names are opposite cases (an opposite
pair, other HTTP methods or statuses, other uppercase `AND`/`OR`, another
endpoint), or, in one file, either name has a word the other lacks or the
same words come in another order.

Without `--files-from` every tracked file on disk is listed; with it, the
listed paths (one per line or NUL-separated, relative to the root or
absolute; `-` reads stdin). A listed path counts when `include` matches it
relative to the root. A file that cannot be read warns on stderr and is
skipped; a file that does not parse prints `❌ Parse error:` on stderr and
gives no tests. The report goes to stdout. The JSON `--config` (relative to
the root) replaces each default it names:

- `include` (default `\.(test|spec)\.(ts|tsx|js|jsx)$`): which paths are tests.
- `threshold` (default `0.85`).
- `commonNames`: names too generic to compare, lowercased.
- `oppositePairs`: `[word, word]` pairs that mark two names as opposite
  cases (the default holds fifteen, such as `success`/`failure` and
  `valid`/`invalid`). Names are lowercased before they are matched, so a pair
  must be lowercase to match.

Needs `typescript` `>=5.4 <6`, as `coverage-by-type` does. A `.ts` file is
read as TypeScript and the rest as TSX; a `.ts` file that only parses as
TSX is read so, and one with a `<T>value` assertion gives no tests.

## `enforcement-claims`

```sh
pariksha enforcement-claims --config <file> [--root <dir>]
```

A standard that says how it is enforced is believed, and nothing else checks
it: a standard can claim an ESLint rule that was never configured, or one
configured only in a workspace it does not apply to, or a validator nothing
runs, and the corpus reads as enforced while nothing runs. This check holds
each claim to the repository's real configuration. The JSON `--config`
(relative to the root) names every repository-specific path:

```json
{
  "id": "STD-001",
  "standards": "docs/standards",
  "workspaces": [
    { "dir": ".", "probes": ["scripts/probe.ts", "scripts/probe.test.ts"] },
    { "dir": "apps/api", "probes": ["src/probe.ts", "src/probe.test.ts"] }
  ],
  "dispatcher": { "path": "scripts/run-validation.sh" },
  "packageRunner": { "path": "scripts/validate-package.sh", "call": "run_validator", "validatorsDir": "scripts/validators" },
  "stageRoots": { "hooks": [".husky"], "workflows": [".github/workflows"], "actions": [".github/actions"] },
  "runnable": { "prefixes": ["scripts/", ".claude/scripts/", "apps/*/scripts/"], "extensions": ["sh", "ts", "mjs", "js"], "bin": "node_modules/.bin" },
  "workspaceList": { "pnpm": "pnpm-workspace.yaml", "turbo": "turbo.json" },
  "tests": { "file": "\\.test\\.tsx?$", "runner": "\\bvitest\\b|\\s--test\\b" }
}
```

The standards are the `.md` files under `standards`, read recursively; their
YAML frontmatter is the contract:

| Field | Meaning |
| --- | --- |
| `id` | the standard's id, printed with its problems |
| `enforcement` | `eslint-rule` and `validator` are checked; other values (`guidance`, …) claim no gate. A file with none is not a standard |
| `enforcement_config` | for `eslint-rule`, the rules, comma-separated; for `validator`, may cite `<dispatcher file name> <target>` |
| `partial_gates` | rules that gate part of a standard, on any `enforcement`; checked like `enforcement_config` |
| `applies_to` | workspace paths or prefixes, a list or one string |
| `enforcement_script` | for `validator`, the script or test file the claim runs |
| `status: deprecated` | a retired standard claims nothing |

Frontmatter is parsed as YAML (block lists, multiline flow lists and a bare
scalar `applies_to` all read as lists); frontmatter that does not parse is
skipped, not counted.

- **eslint-rule.** Each workspace's flat config is resolved through ESLint
  (`new ESLint({ cwd: dir }).calculateConfigForFile` on each probe, so
  plugins load from the repository), and a rule is on at error or warn; `off`
  is a false claim. A rule name is one token (`eqeqeq`, `no-console`,
  `@scope/plugin/rule`; a parenthetical is dropped), so prose names nothing,
  and a claim naming no rule is refused. `linterOptions.noInlineConfig` may
  be claimed like a rule. Each named rule must be on in EVERY workspace an
  `applies_to` target covers: a prefix covers every workspace under it, and
  a path under none is the root workspace's (`.`).
- **validator.** Where a `dispatcher` is configured, a cited
  `<dispatcher> <target>` must be a case of it, a shell `case` whose lines read `name)` or `a|b)` (any alias
  counts). Then every path the claim names (`enforcement_script`, and the
  paths the target's case names) must exist, and at least one of them must be
  reached from a stage: the files directly in
  each `hooks` folder (not those starting with `_`) and each workflow under
  `workflows`, with the local actions they `uses: ./<actions folder>/<name>`.
  The walk follows a path a command names under a `runnable.prefixes`
  folder (a `*` segment is one folder) with one of its `extensions`, resolved
  from the caller's folder; a `<bin>/<name>` binary in command position (not
  `test -x <bin>/<name>`); a dispatcher call, to that target's case only (the
  dispatcher file is never followed whole); a package runner's `<call> "X"`,
  to `<validatorsDir>/X.sh`; `pnpm [run] <script>`, to the calling
  workspace's script (workspaces from the pnpm file's `packages:`, `dir/*`
  expanded, `!` exclusions removed); and `turbo run <task>`, to every
  workspace's script of that name and the root's when the turbo config names
  `//#<task>`. Shell scripts and hooks are followed; nothing else is
  (TypeScript included). In a workflow or action only a step's `run:` and
  `uses:` are read (not `paths:` filters, `name:` fields or `with:` inputs),
  each run from the step's `working-directory`, else the job's or workflow's
  `defaults.run.working-directory`, else the root; in shell, comment lines and
  `echo`/`printf` lines are not calls. A cited test
  file (`tests.file`) counts as run when a reached script of its workspace
  matches `tests.runner`.

`id` is optional and only labels the output. `dispatcher`, `packageRunner`,
`bin` and `turbo` are optional (absent or `null`: none, so less is reached).
Without a `dispatcher`, a claim's `enforcement_config` is prose, and the
claim is judged by its `enforcement_script` alone: a repository whose stages
call each check directly names the binary or script they call there. Exit 0
prints `pariksha enforcement-claims (<id>): every eslint-rule claim is real
and every validator claim runs at a stage (<eslint-rule> + <validator> of
<standards> rule(s))`. Exit 1 prints one line per problem, ``<file> (<id>):
`<rule or path>` <reason>``, and a count. Exit 2: a bad config (an unknown,
missing or bad key, a path that is not a normalized root-relative POSIX path,
a prefix that is not a folder path, a workspace listed twice), no standard
declaring an enforcement (the scan failed), a missing standards folder,
dispatcher or workspace folder, a workspace whose every probe fails to
resolve a config, or no `eslint`. The stage walk runs only when some live
standard claims `validator`; then a missing pnpm workspace file or turbo
config, a workflow that is not YAML and a `package.json` that is not JSON
exit 2 too.

Needs `eslint` `>=9.24 <10` installed beside pariksha (an optional peer
dependency: only this check loads it).

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
  and a bare name bash reads is a read: in arithmetic (`(( X_SKIP ))`,
  `let`, `-eq`, a subscript), `printenv X_SKIP`, and `-v X_SKIP` in `[ ]`,
  `[[ ]]` or `test`. A variable the file initialises at the top level before
  reading it is the script's own decision, not a read; one initialised in a
  branch, loop, function, group, subshell, pipeline or the end of a `&&`
  list, or self-defaulted (`X_SKIP="${X_SKIP:-0}"`), is.
- TypeScript and JavaScript are read as a syntax tree, with a type checker
  over the one file: dotted, bracketed, optional, destructured (nested too:
  `const { env: { X_SKIP } } = process`) and `in` reads count, through
  `process`, `globalThis.process`, `node:process` and any local bound to the
  environment, with constant keys resolved (`env['X_' + 'SKIP']`); a mention
  in a comment or string does not.
- Python reads are `os.environ[…]`, `.get(…)`, `.setdefault(…)`, `.pop(…)`,
  `'X' in` / `'X' not in os.environ`, the same on `os.environ.copy()` or
  `dict(os.environ)`, and `os.getenv(…)`, with the bytes forms (`environb`,
  `getenvb`): under `os` by any name, through `from os import environ as e`
  / `getenv as g`, and through a name assigned one (`env = os.environ`,
  `read = os.getenv`), outside strings and comments (f-string fields are
  code). A key held in a variable is not resolved. Workflow YAML reads are
  `$X`, `env.X` and `env['X']` outside comments.

`tree` (the default) reads every tracked file in the working tree, skipping
one deleted there; when every tracked gate file is deleted, nothing was read
and it exits 2. `staged` (for a pre-commit hook) reads the files the index
adds, copies, modifies, renames or changes the type of (a symlink replaced
by a file), as the index holds them. In either mode, a repository with no
tracked gate code exits 2, since the config would check nothing, and a gate
file that is a symlink (in the index for staged, in the working tree for
tree) exits 2: its text is a path, and its target goes unchecked. A gate
file that cannot be read (one under a folder the check cannot open
included), a git call that fails, or a failure while reading a file's code
exits 2: an unread gate is never clean. Needs `typescript` only when a
TypeScript or JavaScript file is gate code.

## `eslint-by-workspace`

```sh
pariksha eslint-by-workspace [--config <file>] [--files-from <file>|-] [--root <dir>] [<file>...] [-- <eslint args>...]
```

Lints each file with the ESLint of the workspace that owns it. Flat config
does not cascade: one ESLint run from the root lints a workspace's files under
the root's config, and says nothing. ESLint 9's
`--flag v10_config_lookup_from_file` finds each file's nearest config, but
reads one `eslint-suppressions.json` per run, and a workspace keeps its own.
So the files (named as words, and in the `--files-from` list) are grouped by
owner, and each group runs `eslint --no-warn-ignored <eslint args> <files>`
with that workspace's own binary (`<workspace>/node_modules/.bin/eslint`, else
the root's), from that workspace's folder, its output on pariksha's own
streams. What follows `--` is passed to ESLint as it is. File paths are
relative to `--root`, by default the top level of the checkout it runs in
(outside git, the folder itself), so a run from a workspace folder groups the
same way.

```json
{ "workspaces": ["apps", "packages"], "routes": { "apps/mobile/scripts/": "." } }
```

- `workspaces` (default `apps`, `packages`): folders whose subfolders are
  workspaces. A file in no workspace belongs to the root, `.`.
- `routes` (default none): a path, or a prefix ending in `/`, to the workspace
  that lints it, the longest match first. For a file that lives in a
  workspace but is linted by the root's config.

It exits 1 when any group fails, has no ESLint, or cannot start (every group
still runs), 0 when all pass or nothing is listed, and 2 on a bad config or
list, or with no file and no list.

## `eslint-targets`

```sh
pariksha eslint-targets --range <git range> [--config <file>] [--root <dir>]
```

A delta lint checks the files a change touched, so a change that touches only
configuration (a rule switched on, a suppression dropped, a tsconfig a typed
rule reads) lints nothing, and every file the new configuration fails merges
green. This prints, one per line, the lint targets the range reaches, for a
whole sweep; none is no line.

A target is the root (`.`) or a workspace with an `eslint.config.*` and the
lint `script`. Its inputs are its `eslint.config.*` and every repository file
that config reaches by a relative import, a require or
`path.resolve(__dirname, …)`, transitively; its `eslint-suppressions.json`;
and, for a workspace, each top-level `tsconfig*.json`. Fixed names count
whether or not they exist, and a specifier that resolves to nothing counts
every path it could name, so a deletion still reaches the target it broke.
Rules from an installed package are outside that graph: a range whose
`pinFiles` diff adds or removes a line naming one of `lintPackages` reaches
every target.

```json
{ "workspaces": ["apps", "packages"], "script": "lint:ci", "lintPackages": ["@acme/eslint-rules"], "pinFiles": ["package.json", "pnpm-lock.yaml"] }
```

Every field is optional; those are the defaults, bar `lintPackages` (default
none). It exits 0 with its list, and 2 on a bad range, config or git.

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
Removes-Export: <a>, <b>, <c> — <why they are safe to remove>
Removes-File: <path> — <why the file is gone>
```

A comma list of identifiers before the reason declares each of them, so one
line covers a module's exports and the commit body stays short; anything else
declares its first word only, so a word in the reason never declares a
symbol. `Removes-File` covers every export of a file that no longer exists at HEAD.
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

## `fault-injection-registry`

```sh
pariksha fault-injection-registry --config <file> [--base <ref> | --no-base] [--root <dir>]
```

A CLI whose ledger write fails after it published a plan, or a service whose
best-effort cache write fails after its database commit, behaves in a way no
happy-path test reaches. So every such unit runs under the repository's
fault-injection harness, which fails its dependencies call by call, and its
suite asserts each declared check (an exit contract, containment, rerun
convergence) held to zero violations. Discovery reads the tracked files under
each `discover` group's `roots` that match its `include` and are not tests,
declarations or under a `fixtures/` folder, and keeps those whose text
matches its `marker`. Each found source is registered, exempt with a reason,
or in the baseline, which has one list per group and lists exactly what is
still unregistered. The JSON `--config` (relative to the root):

```json
{
  "baseline": "scripts/fault-injection.baseline.json",
  "discover": {
    "cli": { "roots": ["scripts"], "include": "\\.(ts|mjs)$", "marker": { "pattern": "isCliEntry\\(|process\\.argv\\b|^main\\(", "flags": "m" } },
    "server": { "roots": ["apps/api/src"], "include": "\\.ts$", "marker": { "pattern": "best[- ]effort|fire-and-forget", "flags": "i" } }
  },
  "collected": ["^scripts/.+\\.test\\.ts$", "^apps/api/src/.+\\.test\\.ts$"],
  "harness": {
    "module": "packages/test-utils/src/fault-injection/index.ts",
    "imports": ["@acme/test-utils/fault-injection"],
    "checks": { "ERR-09": "checkExitContract", "ERR-10": "checkContainment", "STATE-11": "checkRerunConvergence" },
    "heldBy": "assertNoViolations"
  },
  "consumers": [{ "source": "scripts/publish.ts", "unit": "main", "checks": ["ERR-09", "STATE-11"], "test": "scripts/publish.faults.test.ts", "uncovered": "the entry block, which only parses flags", "motivatedBy": "M3933356096" }],
  "exempt": [{ "source": "scripts/report.ts", "reason": "writes no file and holds no state" }],
  "exemptIn": ["cli"],
  "minNoteLength": 21,
  "examples": { "catalogue": { "path": "checks.json", "slice": "C-18" }, "fixtures": { "ERR-09": { "example": "M3933356096", "test": "packages/test-utils/src/fault-injection/err-09.examples.test.ts" } } },
  "findingIds": { "motivatedBy": "^[MV]\\d{10}$", "example": "^[MV]\\d{10}$" }
}
```

- The harness module exists and exports each `checks` function and `heldBy`
  as a function. Its exports are read with TypeScript: `export { … } from`,
  `export *` and a local name bound by an import (a default import, or
  `export { default as … }`, follows the module's default export) are
  followed through relative specifiers to the declaration, which must be a
  function (a declaration, or a constant holding an arrow or function
  expression), not a type or another value. A package specifier is not followed, and a name it
  would have to supply is refused, naming what was not followed. The harness
  is never imported or run.
- A consumer's suite exists where a `collected` pattern matches it, imports
  the harness (a relative specifier resolving to `module` or its folder, or
  one of `imports`) and the consumer's source, its imports read from its
  syntax tree as in `codec-registry`, calls each declared check's function and
  `heldBy`, and the name `unit` opens with appears in the source.
- `exemptIn` names the groups an exemption may sit in: an exempt source must
  be discovered in one of them, so a source only another group finds (here a
  best-effort server step) cannot be exempted away.
- `minNoteLength` is the fewest characters (trimmed) an exemption `reason`
  or an `uncovered` may have.
- `examples`, `findingIds`, the opt-out with `null` and the `not checked`
  line work as in `codec-registry`, and each fixture suite also calls its
  check's function.

Refused (exit 1): a discovered source that is unaccounted; an exemption
discovery does not find in an `exemptIn` group; a harness or consumer suite
missing any part above; a stale baseline entry, or one in the list of a group
that does not discover it; and growth against the merge base, read as in
`codec-registry` (the same `--base`, `--base HEAD`,
`--no-base`, first introduction and merge-base lists). Exit 2: a bad config
(an unknown, missing or bad key, a path that is not a normalized
root-relative POSIX path, a check not in `checks`, an `exemptIn` group
`discover` lacks, a reason or `uncovered` shorter than
`minNoteLength`, a source registered twice), a missing or malformed
baseline, a root holding no tracked file, a group discovering nothing, no
base without `--no-base`, a failed git call, or no `typescript`.

## `flaky-tests`

```sh
pariksha flaky-tests [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--runs <n>] [--root <dir>]
```

Runs the test files `--runs` times (default 5, at most 1000) with
`npx vitest run --reporter=json --passWithNoTests`, the files under each
package root together from that root and the rest from the repository root,
and judges every run's JSON report strictly (a report that breaks Vitest's
contract, or a clean exit with no report or one saying `success: false`, is
not trusted). The verdicts, each exiting 1 but the last:

1. a run exited non-zero without collecting a test case (an unloadable file,
   a crashed runner): the runner output is printed, and any flaky test seen
   in the other runs below it;
2. a test passed in some runs and failed in others: flaky;
3. every run failed, or a test failed in every run: not flaky, but broken;
4. every run passed: `✅ No flaky tests found across N test cases.`

The files are listed as for `duplicate-tests`. The JSON `--config` (relative
to the root) replaces each default it names:

- `include` (default `\.(test|spec)\.(ts|tsx|js|jsx)$`): which paths are tests.
- `packageRoots` (default none): directories, relative to the root, whose
  files Vitest runs from that directory, with its config.
- `exclude` (default none): globs passed to Vitest as `--exclude`.

## `license-check`

```sh
pariksha license-check --config <file> [--report <file.json>] [--root <dir>]
```

Every installed package's licence must equal a name on the allow list, or
the package must be allowed by name, with a reason. A checker that accepts a
licence when an allowed name is a substring of it passes `FSL-1.1-MIT` on
`MIT` and `MIT-0` on `MIT`; here a licence passes only when it equals an
allowed name. An SPDX expression passes when one `OR` branch passes, and a
branch when every `AND` term does (`AND` binds tighter; brackets group); a
malformed one is refused. A name may hold spaces (`Apache 2.0`).

The inventory is `pnpm licenses list --json --recursive`, run at `--root`:
every workspace's installed dependencies, dev ones included, read from the
store pnpm already has. `--report` reads a saved copy of that output instead,
from the working directory. pnpm reads only the `license` field and reports
`Unknown` for a package that declares none: such a package is refused unless
`Unknown` is on the allow list or the package is allowed by name. A package
pnpm lists under two licences must pass both.

```json
{
  "allow": ["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"],
  "packages": {
    "some-tool": "source-available build tool; its licence permits this use",
    "old-package@1.0.9": "declares no licence; its LICENSE file is MIT"
  }
}
```

- `allow` (required, not empty) lists the licence names, compared exactly.
  pariksha ships no allow list: with no settings the check exits 2.
- `packages` (default none) maps a package to the reason it is allowed
  whatever its licence: `name` for every version, `name@version` for that
  version only.

The verdict goes to stdout, as in the script this was ported from: one line
when every licence passes, else a count and one line per package with its
licence. pnpm failing, a report that cannot be read, text that is not JSON
or not pnpm's shape, and an inventory with no package judged nothing: exit 2.

## `masked-exit-codes`

```sh
pariksha masked-exit-codes [--config <file>] [--staged] [--root <dir>]
```

A gate that keeps reporting success after it stopped checking passes
everything: a hook that runs a commit-message linter and then `exit 0`, a
review step whose failures read as "no issues found", a baseline read with
`2>/dev/null || true`. `|| true` has honest uses (an optional tool, grep's
"no matches"), so this refuses only the shapes that silence a gate command's
verdict:

1. `exit 0` at the end of a script that ran a gate, with no branch on the
   gate's status;
2. `|| true`, a `||` handler that does not exit non-zero, or `2>/dev/null`
   with the status unchecked, on a gate command, also in a script the line
   hands a shell (`eval '…'`, `bash -c '…'`, what `echo`/`printf` pipes
   into `sh`) and inside `$( … )`;
3. in a file `pipefailScope` matches, `echo`/`printf` of a variable piped
   into a reader that stops early (`grep -q`, `-m`, `-l`, `head`): under
   pipefail the writer can fail after the match, which reads as a miss.

The files are those git tracks under the root ending `.sh` or under a hook
directory, outside `node_modules/`, read from the working tree, or the index
with `--staged`. Comments, quoted text, heredoc bodies and continuation lines
are read as bash reads them. The JSON `--config` (relative to the root) is
optional:

```json
{
  "id": "SH-001",
  "gateCommands": ["eslint", "tsc", "vitest", "prettier --check", "commitlint", "run-validation.sh"],
  "hookDirs": [".husky/"],
  "pipefailScope": ["^\\.husky/", "^scripts/lib/.+\\.sh$"]
}
```

- `id` (default `masked-exit-codes`) names the check in its messages.
- `gateCommands` (default `eslint`, `tsc`, `vitest`, `prettier --check`,
  `commitlint`, `cubic review`, `gitleaks`, `actionlint`, `shellcheck`,
  `depcruise`, `stryker`) are the commands whose status is a verdict; one of
  several words must appear whole. Keep it narrow: a broad list fires on
  every optional-tool probe.
- `hookDirs` (default `.husky/`) are path prefixes whose files are shell
  whatever their name.
- `pipefailScope` (default `^\.husky/`) are path regexes: the files that run
  under `set -o pipefail`.

A clean run prints `✅ <id>: no masked exit codes (N shell file(s) scanned)`
to stdout; each finding goes to stderr with its line and why, and exits 1.
No shell file at all exits 1 (`the file lookup failed`), as the original
did; a bad config or a failed git call exits 2.

## `non-synced-resources`

```sh
pariksha non-synced-resources [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--root <dir>]
```

A link to a file that was never committed works for its writer and for
nobody else. Every `[text](dest)` and `![alt](dest)` on a line of a document
(inside code blocks too) is read, except `http(s)://`, `mailto:` and `#`
links. The destination loses its `#fragment` and `?query`, then is the text
inside `<…>` or the text before a space (a title); one starting with `/` is
read from the repository's top folder. It is refused when its folder does
not exist, when it lands outside the repository, when nothing is there, or
when the name on disk differs in case (macOS opens `./README.MD` as
`./readme.md`; Linux and CI do not). An image over 1 MiB is warned about,
never refused. Paths are joined and split as the shell check this was ported
from joined them (`dirname`, `basename`, `cd && pwd`), so what counts as
inside the repository is unchanged.

The documents, the config (`include`, `guidance`) and the report on stdout
are as for [`absolute-paths`](#absolute-paths); a document listed by absolute
path has its links read from its own folder. With `--files-from`, a
repository is needed only when there is a document to read; without it, the
documents come from `git ls-files`, so a root that is not a repository exits
2 even when it holds no document.

## `own-provenance`

```sh
pariksha own-provenance --config <file> [--root <dir>]
```

What stands in for pnpm's release age on the repository's own scope. A
repository that exempts its own packages from `minimumReleaseAge` (nobody
else watches those releases, so the day's wait buys nothing) names the scope
here. Every package of it that the lockfile resolves must carry npm
provenance saying the repository's release workflow built it from the tag of
its own version (`refs/tags/v<version>`), for the very tarball the lockfile
installs. A release published any other way, from a stolen token, a fork or
another workflow, fails.

The statement's workflow fields are written by whoever ran `npm publish`, so
they alone prove nothing. What binds them is the Sigstore bundle around the
statement, verified offline: the DSSE signature, the certificate's chain to
Sigstore's public-good Fulcio, its signed certificate timestamp and Rekor
entry, and the certificate's identity (its SAN names the release workflow at
the version's tag; its issuer is GitHub Actions). The trust anchors are
`baselines/sigstore-trusted-root.json`, shipped with pariksha: Sigstore's
public-good `trusted_root.json`, whose sha256 (`6494e21e…0b66`) matched the
`trusted_root.json` entry of Sigstore's TUF targets v14 on 2026-11-14. When
Sigstore rotates a key, new releases fail until the file is refreshed (take
`targets/trusted_root.json` from `sigstore/root-signing` and check its sha256
against the latest `targets.json` on `tuf-repo-cdn.sigstore.dev`).

```json
{ "scope": "@acme/", "repository": "https://github.com/acme/tools", "workflow": ".github/workflows/release.yml" }
```

- `scope`, `repository` and `workflow` are required; pariksha ships none.
- `lockfile` (default `pnpm-lock.yaml`) and `trustedRoot` (default the one
  pariksha ships) are paths under `--root`.

It fails closed. An own key it cannot read fails: a prerelease, a tarball or
git resolution, a shape it does not know. So do a lockfile that resolves no
package of the scope, a registry it cannot reach or that stalls past 30
seconds, an answer with no SLSA provenance, and an integrity that is not a
SHA-512 digest.

`@sigstore/bundle` (>=5 <6), `@sigstore/protobuf-specs` (>=0.5 <0.6) and
`@sigstore/verify` (>=4.1 <5) are optional peers: install them beside
pariksha. The output keeps the `own-provenance:` prefix of the script it was
ported from. Exit 0 when every own package is the repository's signed build,
naming them on stdout; 1 when one is not or could not be checked (each reason
on stderr, then a line saying why the scope must pass), the lockfile or the
trusted root cannot be read, or the peers are missing; 2 with no settings or
bad ones.

## `pnpm-settings`

```sh
pariksha pnpm-settings [--config <file>] [--root <dir>]
```

pnpm 11 stopped reading the `pnpm` field of package.json without a warning
(pnpm/pnpm#11536): an `overrides` or `patchedDependencies` left there gives a
green install in which every security pin has reverted and every patch has
stopped applying. A green install proves nothing, so this reads the resolved
`pnpm-lock.yaml` (the last of its YAML documents, which pnpm 12 writes after
its own) and refuses:

1. a setting pnpm 11 ignores still in `package.json#pnpm`;
2. an override in `pnpm-workspace.yaml` the lockfile does not record, records
   differently, or still records after it was removed;
3. the same for a patch, a patch file that is not on disk, or one whose
   sha256 is not the one the lockfile records;
4. a resolved version inside the range an override excludes
   (`tar@<=7.5.20`), or, for a bare-name override (`tar: '>=7.5.21'`),
   outside the range it forces. Prereleases count: `7.5.20-beta.1` is inside
   `<=7.5.20`;
5. a `minimumReleaseAgeExclude` entry that is not one exact version the
   lockfile still resolves, or whose list has no comment right above it, no
   `EXPIRES: <ISO-8601>` line, or an expiry already past. `ownScopes` entries
   are standing and exempt.

```json
{ "id": "CFG-005", "ownScopes": ["@your-scope/*"] }
```

- `id` (default `pnpm-settings`) names the check in its messages.
- `ownScopes` (default none) lists `minimumReleaseAgeExclude` entries asked
  for no expiry or exact version: a project's own scopes, released by its own
  CI.

Ranges are read by pariksha's own matcher, a port of the `semver` package's
range reading (strict mode, prereleases included): comparator sets joined by
`||`, comparators joined by spaces, and the same sugar (`^`, `~`, `1.x`,
`*`, partial versions such as `<8`, hyphen ranges). A range `semver` would
refuse is not passed: it is printed as a selector not version-checked.
`semver`'s loose mode is not read. Notes and failures go to stderr, the clean
line to stdout; a missing input file is a failure (exit 1), a bad config or
an unreadable `package.json` exits 2.

## `pr-title`

```sh
PR_TITLE=<title> [PR_NUMBER=<n>] [HEAD_REF=<branch>] pariksha pr-title [--config <file>] [--root <dir>]
```

A repository that squash-merges keeps the pull request title as the commit
subject, with ` (#N)` appended, and never the branch's own commits. So the
title must pass the rules a commit subject does. It is held to:

1. the repository's commitlint config, found from `--root` and loaded by
   commitlint itself, so the check cannot drift from the config every commit
   is linted with. It lints the subject the squash writes, `<title> (#N)`,
   with `PR_NUMBER` as `N` (a five-digit stand-in without one), so a title
   that passes cannot become a subject over `header-max-length`. Warnings do
   not refuse;
2. with `shape` in the settings, the shape a commit-msg hook may enforce on
   top: one of the listed emoji, a space, one of the listed types, an
   optional `(scope)`, `: `, then a summary of at most `summaryMax`
   characters (code points) that does not end with a period.

The title, number and head branch come from the environment, as a workflow
passes them (`PR_TITLE: ${{ github.event.pull_request.title }}`): a title in
an argument would be one shell quote away from running. A workflow runs it on
`edited` as well as on pushes, since CI does not rerun on a title edit.

```json
{
  "shape": { "gitmoji": ["✨", "🐛", "♻️", "♻"], "types": ["feat", "fix", "refactor"], "summaryMax": 70 },
  "skipHeadPrefixes": ["mergify/merge-queue/"],
  "guide": "docs/COMMIT_GUIDE.md"
}
```

- `shape` (default none: commitlint alone) lists each emoji exactly as
  written, so list one with and without U+FE0F to accept both.
- `skipHeadPrefixes` (default none) are head branches whose title is not
  checked, such as a merge queue's drafts, whose titles are the queue's.
- `guide` (default none) is named on the refusal's last line.

`@commitlint/load` and `@commitlint/lint` (>=20 <21) are optional peers:
install them beside pariksha. Exit 0 when the title passes or its branch is
skipped, saying so on stdout; 1 when it fails, each problem on stderr; 2 when
`PR_TITLE` is unset or empty, the settings are bad, the peers are missing,
or the commitlint config does not load.

## `python-floor`

```sh
pariksha python-floor --python <interpreter> --floor-file <path> [--exclude <regex>] [--selector <path>] [--root <dir>]
```

Every tracked Python source runs on the Python the repository declares. The
floor drifts unseen: CI runners ship a new Python, and a PEP 604 union or a
fresh stdlib import reads as ordinary code until it fails on an older
interpreter, inside whatever was running it. Sources are `*.py` files, and
heredocs and single-quoted `python3 -c '...'` payloads in `*.sh` files and
under `.husky/`, read from the index (the commit being made, not the working
tree). Each is refused for:

1. syntax the floor cannot parse (`ast` with `feature_version` at the floor);
2. a stdlib module added after the floor, or removed at or before it;
3. on a floor below 3.10, a PEP 604 `X | Y` that is evaluated.

A source it cannot read (an unknown encoding, a symlink, conflict stages) is
refused, never skipped.

- `--python` names the interpreter, at or above the floor; pariksha never
  chooses or bundles one. Below the floor it refuses to judge (exit 2).
- `--floor-file` is the file, relative to the root and tracked, holding one
  `MAJOR.MINOR` (`#` comments allowed).
- `--exclude` (default none) is a Python regular expression matched from the
  start of each path; what it matches is not checked. One that does not
  compile exits 2.
- `--selector` (default none) names what picks an interpreter at or above
  the floor in this repository, for the message given when `--python` is
  below it.

The check is a stdlib-only script shipped in the package
(`python/python-floor.py`), run as `<interpreter> python/python-floor.py`;
its stdout (the clean line), stderr (findings) and exit code are passed
through unchanged. An interpreter that cannot be started, or that is stopped
by a signal, exits 2. Two input errors exit 1, as the script always has: a
floor file that is not in the index, not a regular file there, or not one
`MAJOR.MINOR` (one line on stderr), and a `--root` outside a git repository
(a Python traceback).

## `regression-controls`

```sh
pariksha regression-controls --config <file> [--staged] [--root <dir>]
```

A targeted regression control answers one finding with four tests: a bad
case (the historical test, shown blind to the fault), a fixed case, a near
miss and a guard flip. Those tests are the proof, and a rename, a deletion or
a skip ends it silently while every suite still passes. This check keeps a
registry of controls whole. The JSON `--config` (relative to the root) is
the registry:

```json
{
  "gates": {
    "unit": ["^src/(?!.+\\.integration\\.test\\.ts$).+\\.test\\.ts$"],
    "integration": ["^src/.+\\.integration\\.test\\.ts$"]
  },
  "requiredFindings": ["F-1042"],
  "controls": [
    {
      "id": "pool-cap",
      "finding": "F-1042",
      "family": "concurrency",
      "file": "src/queue/boot.integration.test.ts",
      "gate": "integration",
      "guard": "max: POOL_MAX in src/queue/scheduler.ts",
      "cases": {
        "bad": "bad: the sequential probe stays under the cap with the cap removed",
        "fixed": "holds no more connections than the cap, under concurrent sends",
        "nearMiss": "holds no more connections than the cap, under concurrent sends",
        "guardFlip": "guard flip: the same burst drives a pool without the cap past it"
      }
    }
  ]
}
```

- Each of `bad`, `fixed`, `nearMiss` and `guardFlip` is the title of a live
  case in `file`: the string first argument of an `it(…)`, `test(…)`,
  `it.each(rows)(…)` or `test.each(rows)(…)` call, read from the syntax
  tree, so a title left in a comment, a string or a `describe` names no case.
  One title may serve two kinds.
- `file` uses no skip: `.skip`, `.todo`, `.only`, `.skipIf` or `.runIf` on
  any receiver, node:test's `{ skip: … }`, `{ todo: … }` or `{ only: … }`,
  and what the text cannot show (`it['skip']`, `describe[mode]`,
  `const s = it.skip`, `const { only } = test`, a case's options naming one
  anywhere).
- `guard` ends ` in <path>`, and that production file exists.
- `gates` maps each gate to path patterns, one of which must match `file`:
  the test files that gate's runner collects. A control naming a gate not in
  `gates` is refused.
- `requiredFindings` lists findings some control must answer, so dropping a
  control is a change to the registry's own list.
- Ids are unique. `$comment` and `$schema` are allowed beside the keys.

`gates` and `requiredFindings` are required: a forgotten key would drop its
check silently. `null` opts a check out, and the run says what it did not
check (`not checked: gates, requiredFindings`). The files are read
under the root from the working tree, or from the index with `--staged`
(several at once, through one `git cat-file --batch`; a hook's
`GIT_INDEX_FILE` is honoured). With `--staged` the registry is read from the
index too when it lies under the root and the index holds it, so a commit is
judged on the registry it records.

A clean run prints `pariksha regression-controls: N control(s) whole, M
required finding(s) answered` to stdout. Refused (exit 1): a title that is
not a case, a skip, a missing test or guarded file, a guard without a path,
an unknown gate or one that does not collect the file, a duplicate id, a
required finding no control answers. Exit 2: a bad registry (not JSON, an
unknown or missing key (`gates` and `requiredFindings` included), an empty
`controls`, a `file` that is not a
normalized root-relative path, a gate pattern that is not a regular
expression), `--staged` outside a git repository, a failed git call, or no
`typescript`. Needs `typescript` `>=5.4 <6`, as `coverage-by-type` does.

## `repo-rules`

```sh
pariksha repo-rules [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--root <dir>]
```

Small rules, each a mistake a coding agent made and a lesson recorded, refused
where the mistake is written. The selection (every tracked file by default)
names the files judged; a rule that depends on another file (turbo.json, a
hook a script is reached from) also judges its dependants when that file is
selected. A refusal prints each finding as `file:line: rule: detail`, then
each fired rule's lesson once: what goes wrong and the fix.

| Rule | Refuses |
| ---- | ------- |
| `actions-path-leading-slash` | a workflow `paths` or `paths-ignore` pattern starting with `/`, which matches nothing |
| `falsy-ternary-expression` | `a && 0 \|\| b` (or `''`, `false`, `null`) in a workflow or action: it always gives `b` |
| `job-level-if-not-step` | a job whose every step has an `if:` and the job none: it still starts and bills |
| `job-timeout-minutes` | a job a merge queue waits on (`merge_group`, `pull_request`, `pull_request_target`; setting `triggers`) with no `timeout-minutes`; reusable-workflow jobs are skipped |
| `pg-isready-over-socket` | a compose healthcheck or workflow service `--health-cmd` running `pg_isready` without `-h`/`--host` |
| `long-line-not-rgignored` | a line over 1 MB (setting `maxLineBytes`) in a file no `.gitignore`, root `.rgignore` or `.ignore` covers |
| `raw-nul-in-source` | a raw NUL byte in a source or text file (setting `extensions`) |
| `codeql-suppression-comment-form` | a `codeql[a, b]` comma list, or code before a `codeql[...]` comment on its line |
| `vitest4-inert-pool-config` | `poolOptions` in a Vitest config; `VITEST_MAX_WORKERS` handed to a turbo run while turbo.json lists it in no env list |
| `eslint-ignores-worktrees` | a root ESLint flat config that does not ignore `.claude/worktrees/**` |
| `lockfile-single-doc-parse` | a single-document YAML parse (`load`, `parse`, `safe_load`) whose argument reads `pnpm-lock.yaml`, directly or through a variable |
| `pre-merge-commit-merge-head` | a `pre-merge-commit` hook, a lefthook `pre-merge-commit` command, or a script either names, reading `MERGE_HEAD` |
| `mcp-matcher-server-id` | a Claude Code hook matcher naming `mcp__<generated id>__<tool>` |
| `rollup-state-gate` | code reading `statusCheckRollup.state` (gh, JS, jq, GraphQL) |
| `deleted-path-still-pinned` | a test file quoting a path the selection deletes or renames (`--staged` or `--base` only) |
| `turbo-inputs-cover-reads` | a source a test task with `inputs` hashes naming a tracked file those inputs miss (setting `tasks`, regular expressions over task names, default `test`) |

Settings, in `.pariksha.json` `checks.repo-rules` or the `--config` file:

```json
{
  "rules": {
    "job-timeout-minutes": { "triggers": ["merge_group"] },
    "raw-nul-in-source": { "allow": { "test/fixtures/nul.ts": "the fixture of the mistake" } },
    "pg-isready-over-socket": { "off": "no Postgres here" }
  }
}
```

`off` (with its reason) stops a rule; `allow` maps a file to the reason it is
not judged. An unknown rule or key, an empty reason, or `off` beside another
setting exits 2; an allowance for a file git does not track exits 1, naming
it, since it hides nothing and should go.

## `required-settings`

```sh
pariksha required-settings --require <file> [--settings <file>] [--root <dir>]
```

A setting a project depends on, such as Claude Code's `advisorModel`, is one
committed line, and one edit deletes it without any test noticing. The
requirements file lists each key (a dotted path for a nested one) with the
value it must hold and why:

```json
{ "advisorModel": { "value": "fable", "why": "sessions work with the advisor on" } }
```

A list the project only adds to, such as a permission list, takes
`"includes"` instead of `"value"`: the key must be a list holding each entry,
among any others.

The check refuses a settings file (default `.claude/settings.json`) that lacks
a key, holds another value, or lacks a required list entry, compared as JSON,
naming the key, what is wrong and the reason. A missing settings file is a
refusal; a requirements file it cannot read or parse, or one listing no key,
exits 2.

In both files it also refuses a rule in `permissions.allow`, `deny` or `ask`
that Claude Code does not match as written
([permissions](https://code.claude.com/docs/en/permissions)): in the settings
whether or not a requirement names it, in the requirements file as an exit 2.

- A path rule on `Write`, `NotebookEdit` or `MultiEdit`, such as
  `Write(./**)`. Claude Code checks file edits against `Edit(path)` rules
  only, and `Edit(path)` covers every file-editing tool. A bare `Write`
  names the whole tool and passes.
- A `Bash(…)` rule ending in `:*` with another `*` before it, such as
  `Bash(*git push* :*)`. Claude Code reads `:*` as a prefix only at the end
  of a rule with no other wildcard; on Claude Code 2.1.326 that rule let
  `git push origin :feature-x` through. Write `:**` for a colon followed by
  anything: Claude Code 2.1.326 reads two adjacent stars as one wildcard,
  and prints one informational line for the rule.

`baselines/claude-settings.json` (`@veda-hq/pariksha/baselines/claude-settings.json`)
is the permission baseline every repository agents work in keeps:

- allow: edits inside the checkout (`Edit(./**)`, which Claude Code also
  applies to `Write`, `NotebookEdit` and `MultiEdit`); selected git commands (`status`,
  `diff`, `log`, `show`, `branch`, `ls-remote`, `worktree list`) and gh
  commands (`pr view`, `pr list`, `pr checks`, `run view`, `run list`,
  `issue list`, and `pr comment`, which posts: agents leave their evidence
  and thread replies on their own pull requests); a draft pull request
  (`git push -u origin`, `gh pr create --draft`, `gh pr ready`); the desktop
  app's pull request tools (`mcp__ccd_pr__bind_pr`, `get_status`,
  `set_monitor`); reading a browser page; and `send_message` to the session
  that started this one;
- deny: `Bash(*--no-verify*)`;
- ask: every push that rewrites or deletes published history (`--force`,
  `-f`, `--mirror`, `--delete`, `-d`, `--prune`, a `+` refspec or an
  empty-source one such as `:feature-x` (`Bash(*git push* :**)`), and the
  abbreviations git accepts), a forced branch delete
  (`git branch -D`, `-df`, `-fd`, and any `-d`/`--delete` with
  `-f`/`--force` in either order: the two globs `*-d*-f*` and `*-f*-d*`
  also ask for a plain `-d` of a branch whose name holds `-f`, which errs
  on the side of asking), and the
  dependency commands `pnpm add`, `remove`, `update`, `npm install`,
  `uninstall`, `update`, `yarn add` and `remove`. Ask beats allow, so these
  hold inside the allowed `git push -u origin` and `git branch`. An edit of a
  manifest is an edit like any other; the commands are what is asked.

Point `--require` at it in the package's install. A repository's own rules
go in its own requirements file beside it. Permission globs are a coarse backstop: they cannot
tell `git commit -n` from `git log -n 5`, nor see `git -C dir push --force`.
Parsing those is the job of a command guard such as kavach's `git_safety`.
`permissions.defaultMode: "auto"` is not in it: Claude Code ignores `auto` in a
project's settings and then also skips the user's own `defaultMode`, so it
belongs in user settings only.

## `schema-roots`

```sh
pariksha schema-roots [--files-from <file>|-] [--root <dir>] [<file>...]
```

The Anthropic API refuses a tool's `input_schema`, or a structured output's
schema, with `allOf`, `anyOf` or `oneOf` at its root, answering 400:
"input_schema does not support oneOf, allOf, or anyOf at the top level". The
request fails before the first tool call, so an agent built on that schema
dies at its start every time. This reads the JSON files it is given and refuses each such
schema:

- the value under `input_schema`, `inputSchema`, `output_schema`,
  `outputSchema` or `json_schema`, and the `schema` inside a `json_schema`,
  at any depth, in objects and arrays (a request's `tools` list, say);
- the `schema` of an object whose `type` is `json_schema`, a structured
  output format;
- the root of a file named `*.schema.json`.

A combinator below a schema's root is allowed, and a schema found is not read
further: a property inside it named `input_schema` is a property. Each
finding goes to stderr as `<file>: <json path>: top-level <keyword>`, with
the fix: express the condition in code after the call returns.

The files are the ones named on the command line and the ones `--files-from`
lists, one path per line (a file, or `-` for stdin); relative paths are read
from the root. Only `.json` files are read, so a list of changed files can
hold others; YAML is not read. No file to read passes. The first `.json`
file that cannot be read or is not plain JSON (one with comments, say) exits
2, naming it, and no finding is printed; so does a list that cannot be read.

## `shell-gates`

```sh
pariksha shell-gates [--config <file>] [--staged | --all | --base <ref> | --files-from <file>|-] [--only <checks>] [--root <dir>]
```

A shell script that works on its writer's Mac can fail on Linux CI, and a
git hook that picks up whatever `node` is on PATH can run a check under the
wrong runtime. This runs three gates over the shell files a change writes:

1. ShellCheck, a binary on PATH (install it: <https://www.shellcheck.net>),
   once per pass, by default `--severity=warning`, then `--severity=info
   --include=SC2086,SC2013,SC2015` (an unquoted expansion, `for x in $(cat
   f)`, `a && b || c`). Its targets are `*.sh`, `*.bash`, the hooks
   directory's direct children without an extension, and extensionless
   files whose first line is a sh, bash, dash or ksh `#!`. Staged mode
   writes the index's copy of each to a temporary directory and judges
   that; base mode judges the HEAD commit's copy of what the branch changed
   since its merge base with `<ref>`; `--all` judges the working tree; files
   mode passes the listed paths as they are.
2. The hook preamble, over the hooks directory's direct children without an
   extension. A hook must source `selectScript` and call `selectFunction`
   (with `|| exit 1`, or a branch that exits) before it runs a runtime
   (`runtimes`, by default `node`, `npx`, `pnpm`, `npm`, `tsx`, `corepack`,
   `yarn`), here or in a function it calls; an opt-out (`[ "$X" = 0 ] &&
   exit 0`) comes before that selection; it never edits PATH or drives
   nvm, fnm or mise itself; it never `exec sh <hook>`s (that ignores the
   target's shebang); and an INT, TERM, HUP or QUIT trap's handler ends in
   `exit`, or bash resumes after it and a cancelled hook carries on.
3. The pitfalls, over every shell target: `grep -E` or `egrep` with `\s`,
   `\S`, `\d` or `\D` (not POSIX ERE: BSD grep matches nothing); GNU-only
   `xargs -d`/`-r`; `xargs` without `-0` fed a file list; file operands
   after `xargs`, or a list expansion to grep, without `--`; `<( … )` in a
   file `validatorPaths` matches; a literal `/tmp/<name>` (use `mktemp`);
   an unguarded `/opt/homebrew` or `/Users/` literal, a fixed `-avd
   <name>`, a personal device name; `NVM_DIR` set without honouring an
   existing one; `lockf` without `-k`; `$(( … ))` over a value from `read`
   or `date` without `10#` (`08` is bad octal); `dirname "$0"` beside
   `BASH_SOURCE`; `git worktree list` parsed without `--porcelain`; and
   `grep -o` over a JSON `"key":`. Comments, quoted text and heredoc bodies
   are read as bash reads them.

The preamble and pitfalls judge the same kind of target, less `exclude`
and symlinks: `--staged` (the default) the staged copies, `--base` the
files changed since the merge base with `<ref>` (read from the working
tree), `--all` every tracked one, `--files-from` the listed paths (one per
line or NUL-separated; a file, or `-` for stdin). A change under
`gateInputs` (staged, or on the branch) re-judges every target, and a
staged change to a `shellcheck.inputs` path makes ShellCheck judge the
whole index. `--only preamble,pitfalls` runs
only those checks, and no ShellCheck. The JSON `--config` (relative to the
root) is optional:

```json
{
  "hooksDir": ".husky/",
  "exclude": ["node_modules/", ".husky/_/", "vendor/"],
  "gateInputs": ["scripts/validations/shell/"],
  "preamble": { "id": "SHELL-06", "selectScript": "scripts/lib/select-node.sh", "selectFunction": "select_node" },
  "pitfalls": { "id": "SHELL-03", "validatorPaths": ["^scripts/validations/"] },
  "shellcheck": { "inputs": ["scripts/run-validation.sh"], "install": "run the machine setup (or: brew install shellcheck)" },
  "guidance": ["", "   SHELL-06 and SHELL-03 are described in docs/shell.md."]
}
```

- `hooksDir` (default `.husky/`, ending in `/`) is the git hooks directory.
- `exclude` (default `node_modules/`, `.husky/_/`) are path prefixes never
  judged by the preamble and pitfalls; a `/node_modules/` segment never is.
- `gateInputs` (default none) are path prefixes of the gate's own inputs.
- `preamble` (default none, which leaves only the pitfalls to run):
  `selectScript` and `selectFunction` are required; `id` defaults to
  `hook-preamble`, `runtimes` to the list above.
- `pitfalls`: `id` (default `shell-pitfalls`) and `validatorPaths` (path
  regexes, default none).
- `shellcheck`: `passes` (lists of flags after `--norc`; `[]` runs no
  ShellCheck), `inputs` (default none) and `install`, the text a missing
  ShellCheck message gives.
- `guidance` (default a pointer to this section) is printed after the
  findings.

ShellCheck's own report comes first, then `✅ Shell gates: N file(s) pass
<checks>`, or `❌ Shell gates: N finding(s) in M file(s)` on stderr with
each finding as `file:line  <id> <rule>` and its message, then the
guidance. It exits 1 on any ShellCheck or rule finding, or when ShellCheck
is not installed; 2 on a bad config, two modes, an empty list, or a
selection or git failure, since nothing was checked.

## `baseline-ratchet`, a module

```ts
import { atMergeBase, fileAt, mergeBaseOf, parseRenames, renamedSinceMergeBase, trackedFiles } from '@veda-hq/pariksha/baseline-ratchet';
```

Not a check but the git reads a repository's own list-shaped ratchet needs,
so its baseline can only shrink: refuse an entry the merge base's copy does
not have, and read an entry that only moved as the same debt under a new
name. Typed (the package ships declarations).

| Export | Gives |
| ------ | ----- |
| `trackedFiles(root, env, pathspecs)` | the tracked paths under `pathspecs` that still exist in the working tree |
| `mergeBaseOf(root, base?, env?)` | the merge base of HEAD and `base` as a full sha; `null` when `base` is `''` (a first push, no base branch) |
| `fileAt(root, commit, path, env?)` | `path` as committed at `commit`; `null` only when the commit does not have it |
| `atMergeBase(root, path, base?, env?)` | `path` as the merge base has it; `null` when it does not, or with no base |
| `renamedSinceMergeBase(root, base?, env?)` | new path → old path for each file git sees renamed since the merge base, the working tree and index included; empty with no base |
| `parseRenames(nameStatus)` | the renames in `git diff --name-status -z` output (a copy is not one) |

`base` defaults to `BASE_BRANCH` from the environment, else `origin/main`;
`env`, the environment git runs with, to `process.env`. A base that is named
but does not resolve, and any other git failure, throws with git's reason
rather than reading as an empty baseline.

## markdownlint rules

```jsonc
// .markdownlint-cli2.jsonc
{
  "customRules": ["@veda-hq/pariksha/markdownlint"],
  "config": { "default": false, "pariksha-markdown": true }
}
```

Not a check but a module: markdownlint custom rules for Markdown that reads
fine as source and renders mangled, where no built-in rule fails it for that
reason. `@veda-hq/pariksha/markdownlint` is an ES module whose default export
is the rules array, which markdownlint-cli2's `customRules` loads by package
name; `require()` of it returns the array too. Every rule carries the tag
`pariksha-markdown`, so the config above turns on these rules and nothing
else. They run on markdownlint's micromark tokens (`parser: "micromark"`)
and import nothing. Most read prose only, skipping code blocks, HTML blocks
and code spans; the fence and code-span rules read those,
`pariksha-replacement-character` reads every line, and
`pariksha-duplicate-adjacent-line` skips code and HTML blocks but compares
whole lines, code spans included.

| Rule | Fails |
| ---- | ----- |
| `pariksha-alert-marker-inline` | `> [!NOTE] body` on one line: GitHub renders the callout only with the marker alone |
| `pariksha-link-space-before-paren` | `[text] (./a.md)`: the space renders the link as text (targets that look like a URL, path, anchor or file only; task boxes `[ ]` and `[x]` pass) |
| `pariksha-code-span-crosses-line` | a code span that closes on a later line, or a path span ending in `/` continued in the next line's span |
| `pariksha-fence-unclosed` | a code fence that never closes |
| `pariksha-fence-empty` | a fence with nothing but blank lines in it |
| `pariksha-fence-swallows-heading` | a `# Heading` inside a fence of a language where it cannot be code: the fence above lost its close |
| `pariksha-table-row-orphaned` | a paragraph made only of `\| … \|` rows: a blank line cut them off their table |
| `pariksha-duplicate-adjacent-line` | a line of ten or more characters, with a letter, repeating the previous non-blank prose line (table rows may repeat) |
| `pariksha-replacement-character` | U+FFFD, bytes lost in an encoding round-trip |
| `pariksha-emphasis-mangle` | `store*id`: a single `*` between letters, where `_` was re-read as emphasis |
| `pariksha-dunder-mangle` | `**DEV**`: a formatter rewrote `__DEV__` as bold |
| `pariksha-lettered-step-indent` | `b.` indented unlike the `a.` above it, so it renders under another parent |
| `pariksha-paired-dollars` | two unescaped `$` in one paragraph (outside code spans): Prettier pairs them as inline math and reprints the paragraph |

Options are lists, each replacing its default:

| Option | Rule | Default |
| ------ | ---- | ------- |
| `alert_types` | `pariksha-alert-marker-inline` | `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION` (matched case-insensitively) |
| `link_target_extensions` | `pariksha-link-space-before-paren` | `md`, `mdx`, `html`, `htm`, `ts`, `tsx`, `js`, `json`, `yaml`, `yml`, `png`, `svg`, `jpg`, `jpeg`, `pdf` |
| `dunder_words` | `pariksha-dunder-mangle` | `DEV`, `proto`, `esModule`, `typename`: names never an English word in bold |
| `no_hash_languages` | `pariksha-fence-swallows-heading` | `ts`, `tsx`, `typescript`, `js`, `jsx`, `javascript`, `json`, `jsonc`, `sql`, `css`, `swift`, `kotlin`, `java`, `go`, `rust`, `prisma` (matched case-insensitively; not `graphql` or `html`, where a `# ` line is a comment or text) |

```jsonc
{
  "config": {
    "default": false,
    "pariksha-markdown": { "dunder_words": ["DEV", "proto", "esModule", "typename", "dirname"] },
    "pariksha-fence-swallows-heading": { "no_hash_languages": ["ts", "py"] }
  },
  "customRules": ["@veda-hq/pariksha/markdownlint"]
}
```

Options set under the tag reach every rule, so every rule accepts all four
names. A rule's own key replaces the tag's object for that rule (markdownlint
takes the last key that names a rule, whole), so above
`pariksha-fence-swallows-heading` keeps the default `dunder_words`, which it
does not read. The same goes for an option of one rule set under another
rule's key: a rule cannot tell its own object from the tag's, so it accepts
every name some rule reads. Otherwise a configuration markdownlint cannot have
meant is refused, not ignored: an option name no rule reads (an array set as
the configuration reaches the rules as its indexes, `"0"`, and is refused as
such), a list option that is not a non-empty array of strings (to turn a rule
off, set it to `false`), or an entry that could never match (an extension with
its dot, a dunder word with its underscores, a language with a space). Each
rule that reads the bad configuration throws, naming itself and the option, so
markdownlint-cli2 reports up to thirteen errors on line 1 of each file and the
run fails; with `"severity": "warning"` in the configuration they are reported
as warnings instead.
