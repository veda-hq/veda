# Veda

Generic, public tooling for repositories that coding agents work in: the
guards that keep an agent inside its bounds, the repository checks, the git
hooks that run cheap checks at commit and expensive ones once at push, the
mutation-testing gate, lint rules, and a Claude Code plugin that carries them.

Veda knows nothing of the products that use it. Each product keeps its own
rules, baselines and presets in its own repository and pins a Veda release;
Veda's packages take that configuration as input.

## Packages

Each is published to npm under `@veda-hq`, at exact versions, signed with
provenance from this repository's release workflow. Names are Sanskrit; each
package's description says its job in plain English.

| Package | Meaning | Job | Status |
| --- | --- | --- | --- |
| [`@veda-hq/pariksha`](packages/pariksha) | परीक्षा, examination | Repository checks: doc drift, rule enforcement, test-quality ratchets | v0.3.2: authority-citations, boundary, doc-budgets, export-deletions |
| [`@veda-hq/kavach`](packages/kavach) | कवच, armour | Agent guards: refuses unsafe or out-of-bounds agent commands | v0.3: worktree boundary, command guard, rule-check engine, adversarial corpus |
| `@veda-hq/dvara` | द्वार, gate | Git hooks: cheap checks at commit, expensive ones once at push | planned |
| `@veda-hq/agnipariksha` | अग्निपरीक्षा, trial by fire | Mutation gate: wiring and policy on top of Stryker | planned |
| [`@veda-hq/eslint-plugin-shuddhi`](packages/eslint-plugin-shuddhi) | शुद्धि, purification | Generic ESLint rules | v0.2: error handling, input parsing, NestJS and Prisma boundaries, test lint |
| `sarathi` (Claude Code plugin) | सारथि, charioteer | Carries the guards, session hooks, agents and skills; installed as `sarathi@veda` from this repository's marketplace | planned |

The work rules for repositories that track work in GitHub Issues live in their
own repository, `veda-hq/niyam` (नियम, rule).

Every package must show it still catches something before it is published: a
check that has refused no real mistake in its last 30 days of use is not
carried over.

## The boundary check

`pariksha boundary` refuses any file git tracks, by its path or its text,
that names a word on the repository's deny list. The list,
`.veda/deny.sha256`, holds SHA-256 hashes of lowercase words, so a repository
can refuse a name without writing it down. Words are runs of letters and
digits, compared case-insensitively.

```sh
npx @veda-hq/pariksha@0.1.0 boundary              # this repository
npx @veda-hq/pariksha@0.1.0 boundary --root ../x  # another one
npx @veda-hq/pariksha@0.1.0 hash someword         # a line for the deny list
```

Every veda-hq repository runs it; this one runs it from source in CI. Others
call the shared workflow at a release:

```yaml
jobs:
  boundary:
    uses: veda-hq/veda/.github/workflows/boundary.yml@v0.1.0
    with:
      pariksha-version: 0.1.0
```

## Rules this repository keeps

- **A package's own repository is guarded by the last released version of its
  guards**, never by the copy being changed: a broken change must not be able
  to switch off the check that should catch it.
- **Veda never depends on a product.** The boundary check above enforces it.
- **Exact versions everywhere**, and new third-party versions install only
  once they are a day old (`pnpm-workspace.yaml`).

## Developing

Node 24 (`.nvmrc`) and pnpm (`packageManager`). `pnpm install`, then
`pnpm check`: for each package, typecheck, tests (coverage at least 95% of
lines and functions, 90% of branches), build, smoke. CI also lints the
workflows with actionlint and scans the whole history with Gitleaks and
TruffleHog.

## Releasing

1. Bump the version of each package being released, on main.
2. Tag `vX.Y.Z` on main and push the tag. The release workflow checks that
   the tag is on main and names at least one package's version, runs
   `pnpm check`, publishes every package at that version that is not on npm
   yet, and makes the GitHub release with the packed packages attached.

## Licence

[MIT](LICENSE).
