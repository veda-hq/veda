# @veda-hq/kavach

कवच, armour. Guards for coding agents: each tool call an agent makes is
judged before it runs. Part of [Veda](https://github.com/veda-hq/veda).

## Three guards and a rule-check engine

| Guard | Refuses | Entry point |
| --- | --- | --- |
| Worktree boundary | Any write outside the agent's own git worktree: a Bash command, an Edit or a Write; and, while a push runs, any write into it (below). Read-only commands pass from any checkout. | `python3 python/kavach/worktree_guard.py` |
| Command guard | Git-hook bypasses (`--no-verify`, `core.hooksPath`…), history-destroying pushes, and the project's own command rules (settings below). It also runs the Bash rules that hold a lesson (below), and warns of a message the shell would change. | `python3 python/kavach/command_guard.py` |
| Tool guard | The rules that hold a lesson for tools other than Bash: Write, Edit, RemoteTrigger, the desktop app's sync tool and Workflow (below). | `python3 python/kavach/tool_guard.py` |
| Rule checks | The project's own checks, written in TypeScript, refusing or warning with the rule's reason. | `kavach-rule-checks` (`dist/rule-checks/cli.js`) |

The Python guards read one Claude Code `PreToolUse` event on stdin. Exit
0 allows; exit 2 refuses, with `BLOCKED: <reason>` on stderr. Every other end
(a crash, a missing module, unreadable settings) refuses: Claude Code lets a
hook's exit 1 through, so a guard that fails must not allow. The rule-check
engine is the opposite by design: a check that crashes lets the call go
ahead with a warning, so a broken rule never stops every session.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "python3 node_modules/@veda-hq/kavach/python/kavach/worktree_guard.py" }] },
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "python3 node_modules/@veda-hq/kavach/python/kavach/command_guard.py" }] },
      { "matcher": "Write|Edit|MultiEdit|RemoteTrigger|mcp__ccd_host__sync_with_base_branch|Workflow",
        "hooks": [{ "type": "command", "command": "python3 node_modules/@veda-hq/kavach/python/kavach/tool_guard.py" }] }
    ]
  }
}
```

Python 3.12 or later, standard library only. Node 24 or later. MIT.

## What "read-only" means

A Bash command passes from any checkout when the worktree boundary can prove
every part of it writes nothing: pipes, `sort`, `uniq`, `awk` and `sed`
without writing options or programs, input redirection, `2>/dev/null`,
`tee /dev/null`, `$(...)` and `<(...)` whose bodies are themselves read-only,
`for` loops over literal words, `xargs` running a read-only command, `[`,
`test`, read subcommands of `git` and `gh` (`gh api` with GET only), `git
grep`, `ls-tree` and `cat-file` with their listing options (never `grep -O`,
`--textconv` or `--filters`, which run programs), `shasum`, `base64` to
stdout, `openssl x509` printing a certificate, and `curl` printing what it
fetches (display options only, `-o` only to `/dev/null`, `-X` only `GET` or
`HEAD`, a `-w` with no `%output`), where no default config exists or `-q`
(`--disable`) comes first, and neither `SSLKEYLOGFILE` nor `QLOGDIR` is set
in the environment. A default config is `.curlrc`, `curlrc` or
`.config/curlrc` under `$CURL_HOME`, `$XDG_CONFIG_HOME`, `$HOME` or the
passwd home. Any `curl`, read-only or not, is
unproven with `-K`/`--config`, with a `-w` that writes or reads a file, or in
a command that assigns `CURL_HOME`, `XDG_CONFIG_HOME` or `HOME` (a config may
set its `output`), or `SSLKEYLOGFILE` or `QLOGDIR` (files curl writes). A
`git log`, `show`, `diff`, `diff-tree` or `rev-list` pickaxe passes attached
(`-S'text'`, `-G'regex'`) as it does spaced. `claude --version` (`-v`, `-V`,
either one alone or followed by `--verbose`) passes where no `BUN_` variable
and no `NODE_OPTIONS` is set in the environment or on its line: Claude Code
prints its version before it loads anything, but `BUN_OPTIONS=--preload`
(the native build) or `NODE_OPTIONS=--require` (an npm install) runs a
program first. Any other `claude` starts the full CLI. When it
cannot prove a command, it treats it as writing, and from outside an owned
worktree that refuses. An expansion that could become an option (`git log
$X`, where `X=--output=/elsewhere`) leaves the command unproven.

`pnpm exec` and `pnpm run` run in the folder one selector before them names:
`--dir`/`-C <folder>`, or `--filter`/`-F` with a folder (`./apps/server`)
or one workspace package's name, with or without its scope. So a path after
the subcommand is read from that folder (`pnpm --filter server exec tsx
../../.tmp/x.ts` writes inside the worktree). A second selector, `-r`, a
pattern (`@scope/*`, `server...`) or a name more than one package has leaves
paths read from the command's own folder.

`corpus/corpus.json` is the adversarial test set: commands that write outside
the worktree, bypass hooks or force-push, each executed in real bash to prove
it does what its row says, and near-miss commands that must pass. Each guard
must refuse every attack row and pass every near-miss.

## A session's own folders

Besides its worktree, a session may write three places outside every
checkout. The first is its agent memory, from any checkout. The other two
are its own folders, from its owned worktree only:

- **Its scratchpad**, `<base>/claude-<uid>/<project>/<session_id>/scratchpad`.
  The base is `CLAUDE_CODE_TMPDIR`, or `/tmp`, as Claude Code 2.1.325 builds
  it, and `session_id` comes from the `PreToolUse` payload.
- **The side-session notes folders the desktop app granted it**,
  `~/Library/Application Support/Claude/side-session-notes/local_<uuid>/`. A
  side session's folder is named after the session that started it, so the
  guard reads the app's record of the session,
  `claude-code-sessions/<account>/<org>/<host session>.json`:
  - The record counts only when the hook's environment names the host
    session (`CLAUDE_CODE_HOST_SESSION_ID`), exactly one record is found, and
    its `cliSessionId` is the payload's `session_id`.
  - The folders it grants (`sessionPermissionUpdates`, `addDirectories`)
    count, and so does the session's own folder, where the sessions it starts
    leave it notes.

Each folder must already be a real directory, with no symlink at it or on
the way from its root, and outside every git work tree. Targets compare
resolved, so a `..` or a symlink that leads out reaches nothing. The record
is the app's own format: a missing, unreadable or mismatched one grants
nothing.

Another session's folders stay refused. So does everything else under the
temp folder, `$TMPDIR` and the app's support folder.

## Links

A link makes every later write through it a write where it leads, and a link
the command itself makes does not exist yet when the guard looks. So `ln`,
and `cp` in link mode (`-s`, `-l`, `--symbolic-link`, `--link`), count what
each link leads to as written. A symbolic link's relative source is read from
the folder the link lands in. A hard link's, or `ln -r`'s, is read from the
working directory. A link to anything outside the session's places is refused,
even one nothing would write through, such as `ln -s /usr/bin/python3
.tmp/py`, or a worktree's `.local` link to the main checkout's. Copy the file,
or run the program by its path, instead.

Within one command, a write at or through an entry that an earlier part may
have made into a link is unprovable and refused. That covers a new link
(`ln -s ../.. a && touch a/../x`), and a moved or copied symlink or folder
whose relative links now lead elsewhere (`mv deep/S S && touch S/x`). Make
the link in one call and write through it in the next: by then it exists, and
the path resolves to where it leads.

## Pushes

A push writes the refs and objects of the repository it names, and runs that
repository's hooks. So `git push` and `git send-pack` run only to a remote URL
(`https://`, `http://`, `ssh://`, `git://`, or scp-like `host:path`), or to
this repository itself: `.`, the worktree, the main checkout or its `.git`.
Any other destination is refused as unproven: a local path or a `file` URL
(read from the top of the work tree, as git reads it), a remote helper, or a
path inside the worktree, where git follows a `.git` file anywhere. So is a
URL whose host is this machine, which reaches a repository here through sshd,
`git daemon` or a local web server: `localhost` or a `.localhost` name, this
machine's hostname, or a loopback or unspecified address in any spelling
(`127.1`, `[::1]`). The host is read from the text alone. The limit: a name
that reaches this machine only through DNS, `/etc/hosts` or ssh config, or an
address of this machine other than loopback, counts as remote.

A remote's URLs are read from git's config, with every `insteadOf` and
`pushInsteadOf` rewrite, and a `git push` with no repository reads every
remote. Every worktree shares the main checkout's config, so writing a push
destination into it is judged as the push would be: `git remote add` and
`set-url`, `git config` of a remote's `url` or `pushurl` or a branch's
`remote` or `pushRemote`, and `git fetch` or `git pull --set-upstream`.
Writing a remote URL, a remote's name, or this repository runs; writing a
local path, or a host that is this machine, is refused. The config is
read before the line runs, so a push after another write on its line, other
than `git add`, `commit`, `push` or `tag`, is refused, and so is a push beside
any write on a line with `&` or `|`: push in a call of its own.

## Runners

A package runner that passes program text to a shell is refused as unproven:
`pnpm exec sh -c '…'`, `npx bash -c '…'`, `mise exec -- sh -c '…'`, a shell
under a runner reading its standard input (`printf … | pnpm exec sh`), and
each runner's own shell mode (`pnpm exec -c` or `--shell-mode`, `npm exec` and
`npx` `-c` or `--call`, `mise exec -c` or `--command`, `yarn exec`,
`bun exec`). A runner option the guard does not list in that slot is refused
too, since it may take the next word. The guard does not read that program as
a line of its own: the
runner puts its own bin folders first on `PATH`, and `--dir` or `--filter`
moves the folder the shell runs in. A script file a runner runs
(`pnpm exec bash .tmp/x.sh`, `pnpm exec tsx .tmp/x.ts`) still runs, and what
it writes is out of the guard's sight, as for any repository code.

## What a refusal says

Each refusal names the way out. "mutation targets could not be resolved"
goes on to name what in the command the guard could not read (a redirection
into a file, a heredoc, a pipeline, a `;`/`&&` chain, `$(...)` or backticks,
an interpreter running a file such as `node <file>`, a program it does not
know), then the alternative: one plain command per call, files written with
the Edit or Write tools, and anything more as a script under the worktree's
`.tmp/` run through the repository's package runner (`pnpm exec tsx
.tmp/x.ts`). A write outside the worktree says where it aimed (the main
checkout, another worktree or its git folder, the repository's git folder, a
system temp folder) and where it belongs instead. The leading words of each
refusal are unchanged, so searches of older logs still match.

## Settings

`KAVACH_CONFIG` names a JSON file; unset, every project rule is off. A file
that cannot be read, is not JSON, or has an unknown key refuses every call.

```json
{
  "worktree": {
    "trustedCommands": [
      { "script": "scripts/worktree.py", "pattern": "python3 scripts/worktree\\.py (?:status|retire --pr [1-9][0-9]*)" }
    ],
    "readOnlyCommands": [
      { "pattern": "pnpm (?:health:check|(?:ls|list|why)(?: [A-Za-z0-9@][A-Za-z0-9@/._-]*)*(?: --depth [0-9]+)?)",
        "env": { "AGENT_REMOTE": ["true"] }, "reason": "the script and pnpm's listing commands only read" }
    ],
    "reviewedCLIs": [
      { "program": "niyam",
        "subcommands": {
          "review-thread": { "pathOptions": ["--body-file"] },
          "brief": { "pathOperands": true },
          "keep-going --stop": {}
        },
        "reason": "writes only under the git toplevel (niyam 0.6.17 audited)" }
    ],
    "ownCheckout": {
      "env": { "AGENT_REMOTE": ["true"] },
      "reason": "a hosted session clones the repository for itself, with no worktree",
      "protectedPaths": [".claude/hooks/", ".claude/settings.json", ".claude/settings.local.json", ".claude/kavach.json", "node_modules/"]
    }
  },
  "command": {
    "protectedVariables": ["AGENT_REMOTE"],
    "protectedVariablesReason": "it marks a hosted session; leave it as the session set it",
    "pairedChanges": [
      { "changes": "schema.sql", "requires": "changesets/", "reason": "a schema change needs its changeset" }
    ],
    "shellExpansion": "warn",
    "shellExpansionRefusesFrom": "2026-11-21"
  },
  "rules": {
    "pipe-masks-exit": "refuse",
    "cd-out-of-worktree": { "mode": "warn", "refusesFrom": "2026-11-23" }
  }
}
```

- `trustedCommands`: a script in the repository that may run from the agent's
  own worktree although its writes cannot be read off its command line. The
  pattern must match the whole command; trust only command lines of plain
  words (a whole line with any shell metacharacter is never trusted by its
  pattern alone).
- `readOnlyCommands`: a command line you reviewed as only reading, though
  the guard cannot prove it (a package runner's script, say). It runs with no
  owned worktree, from a checkout's root only, and only while the hook's own
  environment holds one of the listed values for every variable in `env`,
  which is required. The pattern is matched as a trusted command's is. Keep
  the list to commands that write nothing however they are called, and
  name each option a pattern allows: a runner's own options after the
  subcommand (`pnpm ls -C elsewhere`, `--pnpmfile`) move or widen what runs.
- `reviewedCLIs`: a CLI whose writes you reviewed, run from the agent's own
  worktree with free-text arguments. List one only when every write it
  makes lands under the git toplevel or on a path its command line names.
  Each key of `subcommands` is the subcommand's leading words
  (`keep-going --stop` is two), and what follows them is open; so name a
  subcommand only when all of its options are reviewed, and name the
  version you audited in `reason`. `pathOptions` names the options whose
  value is a path (`--opt v`, `--opt=v`; list every spelling the CLI
  accepts), and `pathOperands` makes every operand a path; each such path
  must resolve inside the worktree. Every other word is data, quoted text
  included. The line runs from the worktree root as one command of literal
  words: the program named bare first, single-quoted text, or
  double-quoted text with no `$`, backtick or backslash. A redirection, pipe,
  chain, variable prefix, glob, `~`, `$(...)` or backticks make it no
  reviewed CLI's, whatever `command.shellExpansion` says, and a line that
  opens with a listed program but does not fit is refused, saying why. A
  program this guard judges itself (`git`, `rm`, `pnpm`, a shell, an
  interpreter, a wrapper) is never reviewed. While a push runs, the line
  waits, as a trusted command does. The guard sees only the command line:
  a symlink the agent planted inside the worktree still moves what the CLI
  writes by itself, as it does for any reviewed runner.
- `ownCheckout`: where an agent's own checkout is a plain clone rather than
  a linked worktree (a hosted session that clones the repository for
  itself), that clone counts as the agent's own. That holds only while the
  hook's own environment holds one of the listed values for every variable
  in `env`, which is required, and only for the clone named by
  `CLAUDE_PROJECT_DIR`, the one the session started in: a session that
  changes directory into another clone gains nothing there. Every other rule
  still applies inside it. Linked worktrees are judged as before. Name
  variables only the agent's host sets, never ones a developer exports on a
  laptop, or a laptop's main checkout opens too.

  A worktree session finds the files its guards run from in the main
  checkout, outside its worktree; a clone's session finds them inside its
  own checkout. So inside an owned clone these stay refused: its git folder,
  the guard's settings file (`KAVACH_CONFIG`) and its own code, and each
  path in `protectedPaths` (relative to the clone's root; a folder covers
  everything below it). List there the hook scripts and settings your
  guards run from (a local settings file can turn hooks off too) and the
  folder they are installed in. A target that holds one of them (`rm -rf
  .claude`, `mv .claude elsewhere`) is refused as well. Paths compare by
  file identity as well as by name, so another case spelling or a symlink
  reaches nothing.

  git and package managers write paths their command lines do not name, so
  inside an owned clone they are judged by what they can write:
  - git runs only subcommands that never write the work tree (`add`,
    `commit`, `push`, `fetch`, `branch`, `tag`, the reads and the plumbing
    that writes only the git folder), without an option that runs a program
    (`--upload-pack`, `--receive-pack`, `--exec`, `grep -O`).
  - `checkout -- <path>`, `restore`, `rm` and `mv` run when each path they
    name misses every fence; `.` names the whole checkout, which holds them.
    `git apply` runs when the paths its own `--numstat` lists miss every
    fence. A branch switch (`checkout <commit>`, `switch`, and `-f` back to
    `HEAD`) runs when `git diff` finds the fenced paths alike in the target
    and the work tree. These three are judged by the checkout as it is now,
    so each runs only as a command of its own. `reset` runs without
    `--hard`, `--merge` or `--keep`; `read-tree` without `-u`; `config` only
    to read.
  - Everything else refuses: `merge`, `pull`, `rebase`, `cherry-pick`,
    `revert`, `am`, `stash`, `clean`, `sparse-checkout`, `switch --orphan`,
    `clone`, an alias, and any option or subcommand not in this guard's own
    tables (git's abbreviations included). `git` with anything before it
    (`env git`, `GIT_DIR=… git`) refuses too.
  - Of package installs, only `pnpm install --frozen-lockfile
    --ignore-scripts --ignore-pnpmfile` runs, alone on its line: it
    reinstalls what the lockfile pins, and runs no lifecycle script and no
    pnpmfile. Fence the manifest, the lockfile and what steers an install
    (`pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.cjs`) in `protectedPaths`.
    Every other install, update or removal by pnpm, npm, yarn or bun, and
    `npx`, `bunx` and `corepack`, refuses.
  - Another program that would run git or a package manager (`xargs git`,
    `pnpm exec git`, `timeout 60 pnpm install`) refuses.

  The limit: a package script, a test or any other repository code a
  command runs writes what it likes, and the guard sees only the command
  line. A session that edits `scripts/check.mjs` and runs `pnpm check`, or
  writes `.tmp/x.ts` and runs `pnpm exec tsx .tmp/x.ts`, can reach every
  fence through it. So can a `trustedCommands` script, which runs before
  these checks. A kavach older than this setting refuses every
  call on the unknown key, so add it only once the pinned kavach knows it.
- `protectedVariables`: environment variables a command may not assign, declare or
  export.
- `pairedChanges`: a commit that may record a path ending in `changes` must
  also certainly record a path containing `requires`. With no entries the
  rule is off, and a commit whose repository the guard cannot resolve is no
  longer refused for that reason alone (`--no-verify` and the rest still are).
  Keep a CI check behind it: the guard reads one command line, not the files
  other programs change.
- `shellExpansion`: `"warn"` (the default) or `"refuse"`, the mode of the
  rule on trial below. `shellExpansionRefusesFrom` (a day, `YYYY-MM-DD`) is
  only shown in its warning; nothing switches on that day. A kavach older
  than this rule refuses every call on these unknown keys, so add them only
  once the pinned kavach knows them.
- `rules`: the mode of each rule that holds a lesson (below), by its id:
  `"warn"`, `"refuse"`, or `{ "mode": ..., "refusesFrom": "YYYY-MM-DD" }`
  (the day is only shown in the warning). A rule not named warns. The
  shell-expansion rule may be named here as `commit-message-shell-expansion`
  instead of by `command.shellExpansion`, but not by both. An id the pinned
  kavach does not know refuses every call, as an unknown key does.

## Rules that hold a lesson

Each rule is a mistake agents kept repeating, caught at the call that makes
it. A new rule starts by warning, since a wrong refusal would stop every
session at once: in `"warn"` the call runs and the agent reads the reason
(the same PreToolUse answer as the shell-expansion rule's, below; several
warnings share one answer), and once the project sets `"refuse"` the guard
exits 2 with it. Every fire, in either mode, is a row of the refusal log
naming the rule and the mode, so a trial's rows can be read for wrong fires
before the switch. While a rule warns, an error in its own detection allows
the call and logs a row naming the error's type; refusing, it fails closed.

| Rule | Guard | Fires on |
| --- | --- | --- |
| `pipe-masks-exit` | command | A pipeline ending in `tail` or `head` joined by `&&` to `git push` (`pnpm test \| tail && git push` pushes after a failure), unless the line sets `pipefail`. |
| `cd-out-of-worktree` | command | A literal top-level `cd` or `pushd` to a folder outside the session's checkout (the git work tree of the call's folder; a clone nested inside it counts as inside), naming a peer worktree when it is one. The shell keeps that folder, and the guards then refuse every write, the `cd` back included. A `cd` in a subshell or a pipeline, `cd -` and a computed target are not judged. |
| `stryker-inplace` | command, tool | `stryker` run with `--inPlace`, and a Write or Edit that sets `inPlace: true` in a Stryker config (`stryker[.<name>].conf[ig].{js,mjs,cjs,ts,mts,cts,json}`). |
| `checkout-discards-uncommitted` | command | `git checkout -- <path>`, `git checkout <ref> -- <path>`, `git checkout --ours\|--theirs <path>` and `git restore <path>` (not `--staged` alone) when `git status` shows the path with uncommitted changes. |
| `commit-body-ref-line-length` | command | A `git commit` whose message (`-m` paragraphs, or the `-F` file) has a body line over 100 characters holding `#<number>`: commitlint reads it as a footer and fails `footer-max-line-length`. |
| `case-fold-path-collision` | tool | A Write to a name absent from its folder that differs only by letter case from a file there: on a case-insensitive filesystem it overwrites that file. |
| `routine-sources-shape` | tool | A RemoteTrigger `create` or `update` whose `job_config.ccr.session_context.sources` has an entry without a `git_repository` object, which the API accepts and drops. |
| `sync-base-on-origin` | tool | The desktop app's `mcp__ccd_host__sync_with_base_branch` with no `base` (it then merges the branch the worktree was first cut from, which may be deleted), or a `base` with no `refs/remotes/origin/<base>` in the checkout. |
| `workflow-name-in-worktree` | tool | `Workflow({name})` without `scriptPath` from a linked worktree whose `.claude/workflows/<name>.*` differs from the main checkout's, which is what runs. |

The last two tools' names and fields are as recorded from real calls; the
session that wrote these rules was not offered them, so they are tested on
fixtures only. Keep them warning until a fire shows the live payload.

The tool guard runs only for the tools its matcher gives it, so list them:
`Write|Edit|MultiEdit|RemoteTrigger|mcp__ccd_host__sync_with_base_branch|Workflow`
(`rules.TOOL_MATCHER`). Like the command guard, it refuses a payload it
cannot read and settings it cannot load.

## A rule on trial: messages the shell changes

In bash and zsh a double-quoted (or unquoted) message is expanded before git
reads it: ``git commit -m "fix `parse`"`` runs `parse` and commits "fix ",
`$(...)` does the same, and an interactive shell replaces `!word` from its
history. commitlint reads only the header, so the loss ships. The command
guard finds backticks, `$(...)` and `!word` (a `!` before a blank, `=`, `(`,
a closing quote or the end is left alone) in the value of `git commit` and
`git tag`'s `-m`/`--message`, and of `--body`/`-b` on `gh pr create`,
`comment`, `edit` and `review` and `gh issue create`, `comment` and `edit`.
Single quotes, an escaped `` \` ``, `-F <file>` and `--body-file` are fine,
and so is a value that is wholly one command substitution
(`-m "$(cat file)"`, `--body "$(git log -1 --format=%s)"`): its author meant
the expansion, so nothing is lost. A substitution or backticks inside other
text (`-m "fix $(foo) bar"`) still fire, except `$(cat <<'EOF' ... EOF)`,
the heredoc whose text arrives whole (with an unquoted delimiter only while
its body runs nothing). This rule lets that heredoc pass; the worktree
boundary still refuses any heredoc, so from a worktree use `-F <file>`.

A new refusal starts by warning, since a wrong one would stop every session
at once. In `"warn"` the command runs, and the guard answers on stdout:

```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse",
  "additionalContext": "kavach warning (refuses from 2026-11-21): the shell expands the backticks `parse` inside this double-quoted -m before git sees it, ..."}}
```

In `"refuse"` it exits 2 with the same reason. Either way each fire is a row
of the refusal log naming the rule (`commit-message-shell-expansion`) and the
mode, so the trial's fires can be read for wrong ones before it refuses. Any
other refusal of the same command comes first. While it warns, an error in
the rule's own detection allows the call and logs a warning row naming the
error's type; refusing, it fails closed, as every other check always does.

## While a push runs

A push's checks read the worktree it was started from, and an edit made
while they run either fails the push at its end or leaves it checking what
was not pushed. So while a push runs, the worktree boundary refuses writes
into that worktree: any Bash command it cannot prove read-only, run there
(a trusted command included), and any Edit, Write or NotebookEdit of a path
git does not ignore. Reads still run, and the file tools can still write
files git ignores (drafts, scratch); a Bash command that writes one is still
refused. The refusal names the push's pid and start. Commands that only reach
the network, such as `gh pr comment`, wait too: the guard cannot tell what an
unproven command writes.

It knows a push is running from the marker the project's pre-push hook
writes. Write it when a real push starts and clear it on every exit:

```sh
kavach-rule-checks push-marker write "$(git rev-parse --absolute-git-dir)" "$$"
trap 'kavach-rule-checks push-marker clear "$(git rev-parse --absolute-git-dir)" "$$"' EXIT
```

Each push gets its own marker, `kavach-push-in-progress.<pid>.json` in the
worktree's own git folder, naming its pid and start. A marker whose pid has
ended or now belongs to a later process blocks nothing, so a killed push
leaves no lock behind, and a push in another worktree never blocks this one.
Without the marker, nothing here changes.

## Refusal log

Each refusal of the Python guards appends a row (time, guard, tool, first
line of the reason, start of the command) to
`<git common dir>/kavach/refusals.jsonl`; a rule on trial adds a row for
each warning too, and names itself in its rows (`rule`, `mode`). It is best effort and never changes
a verdict; `KAVACH_REFUSAL_LOG_OFF=1` turns it off. The rule-check engine
keeps its own fire log (`--fires-dir`).

## Rule checks

```sh
kavach-rule-checks --checks rules/checks.ts --registry rules/registry.json   # the hook
kavach-rule-checks count --registry rules/registry.json --json               # rules with no enforcer
kavach-rule-checks latency --rounds 5                                        # time the Bash hooks
```

A checks module exports `CHECKS`, a list of `Check` (`@veda-hq/kavach/rule-checks`):
an id, the events and tools it applies to, and a function returning a
refusal, a warning or nothing. A Bash command passes one named check when it
ends with `# rule-pass <id>: <reason>`; the pass is logged.

Checks build on the engine's parts, each with its types: `rule-checks/shell-words`
(a command's simple commands and words), `rule-checks/live-runs` (a push or
preflight running in the checkout), `rule-checks/edit-text` (a file's text
after an Edit or Write), `rule-checks/spawn` (git and other programs) and
`rule-checks/fire-log` (the fire log's types).

A refusal names the rule's memory notes, or, when its registry row lists
`lessons` (where the notes' lessons live now), those: `Lesson: <list>`, or
`Lesson: none beyond this check` for an empty list.
