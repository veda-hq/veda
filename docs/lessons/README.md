# Lessons

Traps that coding agents hit in repositories like the ones Veda serves, each with its symptom
and its fix. A lesson with a `<!-- when: ... -->` line at its end is also shown to an agent at its
moment by sarathi's lesson handler (`packages/sarathi/README.md`, "Lessons at their moment"),
which ships these files. One file per topic:

- [Claude Code](claude-code.md): classifier, hooks, context cost, desktop app, cloud, sessions.
- [Git and GitHub](git-github.md): worktrees, pushes, commit messages, hooks, PR state, the API.
- [GitHub Actions](github-actions.md): billing, runners, gates, path filters, refs, code scanning.
- [Node, pnpm and TypeScript](node-pnpm-typescript.md): pnpm, Turborepo, tsx, lint, libraries.
- [Review bots and merge queues](review-bots.md): an AI reviewer, its cost and findings, Mergify.
- [Stryker mutation testing](stryker.md): safe runs, speed, misreported mutants, diff gates.
- [Testing](testing.md): clocks, load flakes, Vitest, processes, fixtures, Postgres, Docker.
