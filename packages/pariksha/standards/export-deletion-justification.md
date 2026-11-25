---
id: BP-ARCH-017
title: 'Deleting a public export requires a stated justification'
category: architecture
severity: high
enforcement: validator
enforcement_script: 'packages/pariksha/src/export-deletions.ts'
enforcement_config: 'pariksha export-deletions, in a pre-push hook'
verified: 2026-09-17
verify_by: 2027-03-17
sources:
  - "2026-08-21 PR #269 incident: an agent deleted a public API from a cart module; a third agent then wrote a test asserting the API's absence, so typecheck, tests and mutation score all stayed green"
applies_to: ['apps', 'packages', 'scripts']
---

# Deleting a Public Export Requires a Stated Justification

## Rule

When a branch removes an exported declaration (`export` then `const`, `let`,
`var`, `function`, `class`, `interface`, `type`, `enum`, `const enum` or
`namespace`, with `default`, `declare`, `async` or `abstract` allowed between)
and its name appears in **no source file of the post-change tree** (build
output, vendored code, docs and comment lines do not count), the removal MUST
be declared with a trailer in any commit body on the branch:

```
Removes-Export: clearGiftSelection — superseded by resetCart(); no
  remaining callers (ABC-447)
```

When the whole file is deleted, one trailer naming its path covers every export
it held:

```
Removes-File: .claude/scripts/triage-router.ts — deleted with the pipeline
  that was its only consumer
```

The file form applies only to a file that no longer exists at the branch head.
A file that survived with fewer exports still declares each symbol; that is the
incident's own shape and the file form must not be able to hide it.

A symbol that moved file or was re-exported elsewhere still resolves in the
tree, so those refactors are silent. A rename is not: the old name is gone, so
it needs a `Removes-Export:` naming it, even with every call site updated. The
presence search covers source files only and skips comment lines — otherwise a
changelog entry or a `// removed clearGiftSelection` note would read as
"still present" and suppress the very finding this check exists to raise. Bare
re-export lists (`export { a, b }`) are out of scope — they shuffle constantly
and name nothing new.

Two known gaps follow from this:

- Removing `export { internal as publicApi } from './internal.js'` goes
  unreported even when `publicApi` leaves the public surface.
- Test files are source files, so a test that still names the removed symbol,
  such as one asserting its absence, keeps it "still present" and the check
  stays silent. That is the incident's own last step, so read a new test that
  names a removed export as you would an undeclared deletion.

## Rationale

"An agent quietly removes a public method" is the shape of both an accident and
a bad judgement call, and the automated gates cannot tell either from a correct
refactor. In the 2026-08-21 PR #269 incident the deleted export was
`clearGiftSelection`. The deletion typechecked, every test passed, and the
mutation score stayed at 100% — because the same fan-out also removed the
callers and added a test asserting the API's absence. The tree was perfectly
self-consistent about an API that should still have existed.

Internal consistency cannot distinguish "correctly removed" from "coherently
fabricated". A human statement of intent can, and it costs one line.

**Why the still-present filter is what makes this viable.** Reporting every
removed `export` line would fire on every refactor and be ignored within a week.
Requiring that the symbol be gone from the entire tree reduces the check to
genuine disappearances: measured against PR #269 — hundreds of changed files —
it produced **zero** findings.

The trailer is a claim of intent, not of authority. A removal justified as
somebody's decision must additionally satisfy
[BP-ARCH-015](./authority-claim-citations.md).

## Examples

```ts
// Before, on main:
export const clearGiftSelection = () => {};
export const addToCart = () => {};
```

| Branch change                                        | Verdict                    |
| ---------------------------------------------------- | -------------------------- |
| Both exports kept                                    | ✅ silent                  |
| `clearGiftSelection` moved to `gift.ts`     | ✅ silent — still resolves |
| `clearGiftSelection` deleted, no trailer         | ❌ undeclared deletion     |
| `clearGiftSelection` deleted + `Removes-Export:` | ✅ declared                |
| whole file deleted + `Removes-File:` naming it       | ✅ declared, every export  |
| `clearGiftSelection` deleted + `Removes-File:`   | ❌ file still exists       |

```
refactor(cart): drop the gift reset API

Removes-Export: clearGiftSelection — superseded by resetCart(); no
remaining callers (ABC-447)
```

## Consequences

- Deleting a public API becomes a sentence someone has to write and a reviewer
  can disagree with, instead of a green diff.
- Moves and re-exports pay nothing: the still-present filter keeps them
  silent. A rename pays one trailer.
- A symbol deleted together with its only consumer in the same branch still
  requires the trailer. That is intended — it is the incident's exact shape,
  unless a test still names the symbol (see the known gaps above).
- A symbol that never existed on the base branch is not covered: it was never
  public, so its removal is a within-branch edit, not an API change.

## Enforcement

`pariksha export-deletions` (`src/export-deletions.ts`), called from a
repository's pre-push hook with `--base` set to the push's base: the check
compares the branch against its base and reads commit bodies for trailers,
neither of which a pre-commit hook can do. Its tests live with the package.
With no `--base`, it takes the first of `origin/main`, `origin/develop`,
`origin/master` and `main` that names a commit; when none does it exits 2
(nothing was checked), where the shell check it replaced passed by skipping.

## Related Rules

- [BP-ARCH-015](./authority-claim-citations.md) — authority claims must cite
