---
id: BP-ARCH-015
title: 'Authority claims must resolve to a real artifact'
category: architecture
severity: critical
enforcement: validator
enforcement_script: 'packages/pariksha/src/authority-citations.ts'
enforcement_config: 'pariksha authority-citations --mode staged, in a pre-commit hook'
verified: 2026-08-21
verify_by: 2027-02-21
sources:
  - '2026-08-21 PR #269 incident: a fan-out agent deleted a public cart API and labelled it a "PRODUCT RULE (owner decision, 2026-08-21)"; no such decision existed. Typecheck, tests and a 100% mutation score all passed.'
applies_to: ['apps', 'packages', 'scripts', 'docs']
---

# Authority Claims Must Resolve to a Real Artifact

## Rule

<!-- ALLOW-AUTHORITY-PHRASE: the phrase list below is the rule's subject -->

A line that invokes an authority — `owner decision`, `founder decision`,
`product rule`, `approved by <authority>`, `decided by <authority>`,
`per <authority>` — MUST carry a citation within 3 lines that anchors outside
the artifact making the claim.

Accepted citations, in two tiers:

| Form                                                       | Checked how                            |
| ---------------------------------------------------------- | -------------------------------------- |
| Commit SHA (7–40 hex)                                      | **Resolved** — `git cat-file -e <sha>` |
| `ADR-NNNN` / `docs/adr/NNNN-…`                             | **Resolved** — the ADR is committed    |
| Linear id `ABC-123` / `XYZ-45`                            | Shape only — a hook has no network     |
| `https://github.com/<o>/<r>/(pull\|issues)/<n>`, `PR #123` | Shape only — a hook has no network     |

A prose comment is not a citation. **A markdown file is not a citation** — a doc
an agent could have written is the fabrication restated one level down. An ADR
is the one exception, and only once it is committed: at a commit, the ADR must
already be in `HEAD` and still be on disk, so a commit that adds an ADR cannot
also add its first citation; they land in two commits. (Amending the ADR's
own commit afterwards folds them into one: `HEAD` held the ADR when the
citation was checked.)
On a merge, `HEAD` is the branch being merged into, so a line the merge itself
writes cannot cite an ADR only the merged branch carries. The whole-tree mode
reads the ADR folder on disk. Review an ADR's own history as you would the
claim.

Lines that use the words without asserting authority carry
`ALLOW-AUTHORITY-PHRASE: <reason>` within the same 3-line window. The reason is
required — a bare marker is an unexplained opt-out.

An ADR may not cite **itself**: the claim and its evidence would be the same
artifact, which is the self-certification this rule exists to reject. Any other
file citing that ADR is fine.

## Rationale

A claim of authority asserted inside an artifact is unverifiable from inside
that artifact. It must anchor in something outside it that the authority
produces: their commit, a PR approval, a Linear transition.

On 2026-08-21 (PR #269) an agent deleted a public API and wrote
`PRODUCT RULE (owner decision, 2026-08-21 …): Declining was considered and rejected`. No such decision existed. The change typechecked, every test passed,
and the Stryker mutation score stayed at 100% — because **every automated gate
measures internal consistency, and a coherent fabrication is internally
consistent**. The same fan-out removed the callers and added a test asserting the
API's absence, so the tree agreed with itself perfectly. Only the owner knowing
they had not made that decision caught it.

This rule is the one gate that reaches outside the claim: it asks whether the
cited artifact exists at all. It checks existence, not authorship: a SHA
resolves to any commit in the repository, an ADR to any committed file in the ADR folder,
and issue and PR ids are checked for shape alone. What it buys is a pointer a
reviewer can follow, to who made the commit, who wrote and accepted the ADR,
who moved the issue, where a bare claim gives them nothing to check.

## Examples

```ts
// ❌ BAD — the incident. ALLOW-AUTHORITY-PHRASE: rule example
// PRODUCT RULE (owner decision, 2026-08-21): Declining was considered and rejected

// ❌ BAD — points at a file any agent can write. ALLOW-AUTHORITY-PHRASE: rule example
// owner decision: see docs/decisions/gifts.md

// ❌ BAD — ADR-9999 is not committed, so it does not resolve. ALLOW-AUTHORITY-PHRASE: rule example
// founder decision: gate blocks on surviving mutants (ADR-9999)
```

The ✅ forms below need no pragma: the SHA and the ADR pass once they resolve in
the repository that holds them, and the issue id passes by its shape. The SHA,
issue and ADR here are illustrations and do not resolve in this repository.

```ts
// ✅ GOOD — the owner's own commit, which a reviewer can look up.
// The scope unit is the FILE (owner decision 2026-08-20, 3f9c2e1a).

// ✅ GOOD — a Linear transition only the owner can perform.
// owner decision: rebuild rather than patch the returns flow (ABC-447)

// ✅ GOOD — an ADR committed under docs/adr/ before this line.
// Diff-scoped, zero-survivor mutation gate, per the owner — see ADR-0039.
```

Descriptive prose is untouched: `campaigns are decided by the brand` and
`WHICH path to read is decided by the DIFF STATUS` describe mechanism, not
permission, so the authority word list (`owner`, `founder`, `CTO`, `CEO`,
`management`, `leadership`, the names a repository configures, `@handle`) is what separates them.

## Consequences

- A decision that has not been recorded anywhere cannot be cited — which is the
  point. If there is no artifact, the decision has not been made yet.
- Authors pay one lookup per claim: find the SHA, ADR, or issue id.
- Fabricated authority stops being free: a claim must point at something a
  reviewer can look up. A SHA or ADR that points at nothing is refused; an issue
  or PR id that names nothing passes, since only its shape is checked.
- Two citation tiers are honest about their strength — SHA and ADR are resolved
  (the commit or file exists), Linear and GitHub ids are shape-checked because a
  git hook has no network. Neither tier proves who made the artifact.

## Enforcement

`pariksha authority-citations` (`src/authority-citations.ts`), called as
`pariksha authority-citations --mode staged` from a repository's pre-commit
hook. The repository names its authorities and issue prefixes in its
`.pariksha.json` entry. It scans only lines the commit **adds**, so pre-existing text is
never re-litigated; on a merge commit a line counts as added only when it is
new against every parent, so merging main never re-judges main's text.
`--mode tree` scans everything for baseline reporting. When git cannot read the
staged change it exits 2. Its tests live with the package.

## Related Rules

- [BP-ARCH-017](./export-deletion-justification.md) — deleting a public export
