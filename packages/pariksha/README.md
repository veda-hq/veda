# @veda-hq/pariksha

परीक्षा, examination. Repository checks: doc drift, rule enforcement,
test-quality ratchets. Part of [Veda](https://github.com/veda-hq/veda).

```sh
npx @veda-hq/pariksha@0.5.18 <check> [flags]
npx @veda-hq/pariksha@0.5.18 --version
```

Every check exits 0 when the repository passes, 1 when it refuses something
(each finding on stderr, with how to fix it; `absolute-paths` and
`non-synced-resources` print theirs on stdout, as the shell checks they were
ported from did), and 2 on a usage or input error. `--root <dir>` (default:
the current directory) names the repository. Node 24 or later. MIT; one
ported file is ISC, see `NOTICE`.

## `absolute-paths`

```sh
pariksha absolute-paths [--config <file>] [--files-from <file>|-] [--root <dir>]
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

```json
{ "id": "CI-001", "workflowsDir": ".github/workflows", "gateName": "gate$", "nonGating": ["detect-changes"] }
```

- `id` (default `aggregate-gate-needs`) names the check in its messages: a
  project's rule id, say.
- `workflowsDir` (default `.github/workflows`, relative to the root).
- `gateName` (default `gate$`) is a regex, matched case-insensitively.
- `nonGating` (default none) lists job ids that gate nothing.

A workflow that does not parse is reported as a gap, never passed. No
workflow to read exits 1 (`no workflow files found — the lookup failed`),
as the original did; a bad config exits 2.

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
pariksha duplicate-tests [--config <file>] [--files-from <file>|-] [--root <dir>]
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
- **validator.** A cited `<dispatcher> <target>` must be a case of the
  dispatcher, a shell `case` whose lines read `name)` or `a|b)` (any alias
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

`id` is optional and only labels the output. `packageRunner`, `bin` and
`turbo` are optional (absent or `null`: none, so less is reached). Exit 0
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
pariksha flaky-tests [--config <file>] [--files-from <file>|-] [--runs <n>] [--root <dir>]
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
pariksha non-synced-resources [--config <file>] [--files-from <file>|-] [--root <dir>]
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

`baselines/claude-settings.json` (`@veda-hq/pariksha/baselines/claude-settings.json`)
is the permission baseline every repository agents work in keeps:

- allow: edits inside the checkout; selected git commands (`status`,
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
  `-f`, `--mirror`, `--delete`, `-d`, `--prune`, a `+` or empty-source `:`
  refspec, and the abbreviations git accepts), a forced branch delete
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
markdownlint-cli2 reports up to twelve errors on line 1 of each file and the
run fails; with `"severity": "warning"` in the configuration they are reported
as warnings instead.
