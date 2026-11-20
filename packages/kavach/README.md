# @veda-hq/kavach

कवच, armour. Guards for coding agents: each tool call an agent makes is
judged before it runs. Part of [Veda](https://github.com/veda-hq/veda).

## Three guards and a rule-check engine

| Guard | Refuses | Entry point |
| --- | --- | --- |
| Worktree boundary | Any write outside the agent's own git worktree: a Bash command, an Edit or a Write; any write to the paths the project protects inside it, such as its git hooks (`protectedPaths`, settings below); and, while a push runs, any write into it (below). Read-only commands pass from any checkout. | `python3 python/kavach/worktree_guard.py` |
| Command guard | Git-hook bypasses (`--no-verify`, `core.hooksPath`…), history-destroying pushes, a variable or setting that makes a program run text or a file the guard does not read (`NODE_OPTIONS`, `PYTHONPATH`, npm's and pnpm's settings, below), and the project's own command rules (settings below). It also runs the Bash rules that hold a lesson (below), and warns of a message the shell would change. | `python3 python/kavach/command_guard.py` |
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

A proven read also passes from a folder no git repository holds, where the
guard finds no checkout at all, such as `pwd`, `cat *.md` or a bare
`cd <worktree>`, the way back for a shell left there. Everything else from such a folder is
refused, Edit and Write included, quoting git's reason and naming the folder.

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
repository's hooks. So `git push` and `git send-pack` run only to a URL on a
host the settings list (`https://`, `http://`, `ssh://`, `git://`, or
scp-like `host:path`; `worktree.pushHosts`, by default `github.com`), or to
this repository itself: `.`, the worktree, the main checkout or its `.git`.
Any other destination is refused as unproven: a local path or a `file` URL
(read from the top of the work tree, as git reads it), a remote helper, a
path inside the worktree, where git follows a `.git` file anywhere, or a host
the list does not name. A name may reach this machine through DNS
(`localtest.me`), `/etc/hosts` or an ssh config alias, and so a repository
here through sshd, `git daemon` or a local web server; the guard asks neither
DNS nor ssh. A host that is this machine stays refused even when listed:
`localhost` or a `.localhost` name, this machine's hostname, or a loopback or
unspecified address in any spelling (`127.1`, `[::1]`). The host is matched
exactly, in lower case, without its user, its port or a trailing dot (so
`github.com.` in a URL is `github.com`; the list itself takes no trailing
dot). A URL is read as written
and after each rewrite that matches it, so an alias that `insteadOf` turns
into a listed host (`gh:o/r`) is refused until the alias is listed too, and a
`git push` with no repository, which reads every remote, is refused while any
remote names a host the list does not; `git push origin <branch>` reads only
`origin`. The limit: an ssh config
that already points a listed host at this machine is not read. A session
cannot write `~/.ssh/config`, which is outside its worktree.

A remote's URLs are read from git's config, with every `insteadOf` and
`pushInsteadOf` rewrite, and a `git push` with no repository reads every
remote. Every worktree shares the main checkout's config, so writing a push
destination into it is judged as the push would be: `git remote add` and
`set-url`, `git config` of a remote's `url` or `pushurl` or a branch's
`remote` or `pushRemote`, `git fetch --set-upstream` and
`git pull --set-upstream`, and `git remote rename`, which moves the renamed
remote's URLs to its new name.
Writing a URL on a listed host, a remote's name, or this repository runs;
writing a local path, or a host the list does not name, is refused. The config is
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
moves the folder the shell runs in.

So is a runner that passes program text to an interpreter, as the bare
spelling is: `pnpm exec node -e '…'`, `npx node -p '…'`,
`mise exec -- python3 -c '…'`, and the inline options of `perl`, `ruby`,
`lua`, `php`, `bun`, `tsx` and `ts-node`, with or without a version
(`npx node@20 -e`) or a path (`pnpm exec /usr/bin/node -e`). So is a `data:` URL given to `--import`, `--loader` or
`-r`, and `python3 -m`, since a module may run text (`-m timeit '<code>'`).
An interpreter with no script reads its standard input
(`printf … | pnpm exec node`, `python3 -`, `node -- -`, `bun run -`), so it
is refused too. Each interpreter's options are read against the ones the
guard lists for it. Any other short option is refused, and so is any other
long option unless it carries its value after `=` (`--max-old-space-size=4096`),
since it may take the next word (`node -r ./x -e …`). The interpreter's name
is read wherever it sits on the runner's line, except after a subcommand
that names packages, found past the runner's own options
(`pnpm add -D tsx`, `pnpm --filter x add -D tsx`, `mise install node`).

Any other program a runner starts is judged as the same words would be
without the runner, in the folder it runs them in: `pnpm exec touch .tmp/x`
writes `.tmp/x`, and `pnpm exec deno eval …`, `pnpm exec osascript -e …`,
`pnpm exec xargs …` or `mise exec -- fish -c …` are refused, as `deno eval …`
is. That covers `pnpm exec`, pnpm's implicit form (`pnpm uname -s`, for a
word that is neither a pnpm command nor a script of the package), and
`mise exec`. `npx`, `npm exec` and `pnpm dlx` (whose `-c` is a shell mode
too) run a program only from a bin folder or a package they fetch, so under
them any program that is not an installed bin, a shell or a listed
interpreter is refused (`npx touch .tmp/x`).
A program that is a package bin, installed in a `node_modules/.bin` the
runner looks in first, is the repository's code and runs (`pnpm exec dvara`,
`npx tsc`, with tsc installed): pnpm looks in the package's folder (the nearest package's
from where it runs; the folder itself under `--dir`) and the workspace
root's, and npm in every folder above. So these are refused: a package bin
that is not installed (`pnpm exec stryker` with no stryker in the
dependencies, where pnpm would run whatever `PATH` holds), any bin `npx`,
`npm exec` or `pnpm dlx` would fetch, whatever its name, since the bin is
the package's code (`npx -y cowsay`, `pnpm dlx prettier`,
`npx -p <pkg> touch`, `pnpm create vite`; npm 11 did not fall back to `PATH`
for a name it did not find), a program named by its path
(`pnpm exec ./node_modules/.bin/x`, as `./node_modules/.bin/x` is), a
wrapper before an interpreter (`pnpm exec env CI=1 node x.js`, read as
`env CI=1 node x.js` is; `CI=1 pnpm exec node x.js` runs), a setting every
later run reads (`pnpm config set`, `pnpm set`, `npm config set`), npm's
`init <x>`, `create <x>` and `explore`, a `--dir` the guard cannot place or
two selectors, and a runner option the guard does not list, since it may
take the next word. A listed interpreter on a script file that a runner
fetches (`pnpm dlx tsx x.ts`) still runs, unless the line gives `--package`
(`npx -p <pkg> node x.js` runs one of that package's bins, so even
`npx -p tsx tsx x.ts` is refused). Across
packages (`pnpm -r <word>`), a word that is a script of any selected package
is a script, as pnpm 12.9 ran it only where it is one; the workspace root is
not selected unless `--include-workspace-root` is given, and under a filter
the guard cannot resolve, only a script of every package counts.

A tool argument to `mise exec` (`mise exec node@24 -- …`, `mise x npm:cowsay -c …`)
puts that tool's bins ahead of `PATH` (`mise exec node@24.21.0 -- which node`
printed mise's node), so the program's name proves nothing, as under
`npx -p <pkg>`. It is refused, as is an `exec` option the guard does not
list. `mise exec -- go test ./...` runs, with the tools `mise.toml` names.

yarn's and bun's own forms are not read this way (neither is installed here
to probe). Their `exec` is refused, and so is `yarn dlx`, which fetches the
package it runs (yarn's documentation).

A script file a runner runs (`pnpm exec bash .tmp/x.sh`,
`pnpm exec tsx .tmp/x.ts`, `pnpm exec node .tmp/x.js`) still runs, as does
a package bin. What they write is out of the guard's sight, as for any
repository code, and so is what an installed tool that runs text does with
it (`pnpm exec zx --eval`, with zx in the dependencies). So these refusals
stop ways of writing a program on the command line, not the program itself.

## Environment that runs a program

The command guard refuses a command that sets a variable handing a program
text, or a library, to run, whatever program follows: `NODE_OPTIONS`
(`--import=data:…` runs its text before any node program, `vitest` and
`pnpm check` included), npm's and pnpm's node-options setting as a variable
(`npm_config_node_options`, `pnpm_config_node_options`, in any case) or an
option (`pnpm --config.node-options=…`, `npm --node-options=…`), `PERL5OPT`
(`-M` runs code), `BASH_ENV`, `DYLD_INSERT_LIBRARIES` (Homebrew's `jq`, a
command read as only reading, loaded one), `LD_PRELOAD` and `BUN_OPTIONS`.
It reads an assignment, `env`, `export`, `declare` and the rest as
`protectedVariables` does, in every checkout, with no settings needed. Every
value is refused, `NODE_OPTIONS=--max-old-space-size=4096` too: put such a
setting in a package script. Not listed, since probing found no program
text they run: `PYTHONSTARTUP` (read only when interactive) and
`NODE_OPTIONS`'s `--eval`, which node refuses there.

It refuses, the same way, the variables that make a program run a file the
guard does not read:

- `SHELLOPTS=xtrace` with `PS4='$(…)'`, which runs in every bash and every
  package script; `PS4` alone does so under `bash -x` or `set -x`.
- `ZDOTDIR` and `HOME`: zsh sources their `.zshenv`, and npm reads
  `$HOME/.npmrc`.
- `XDG_CONFIG_HOME`: pnpm reads node-options and a global pnpmfile from its
  `pnpm/` folder.
- `PYTHONPATH` and `PYTHONUSERBASE`: a `sitecustomize.py` or
  `usercustomize.py` there runs in every python, and a module there shadows
  the one a program imports.
- `RUBYOPT` (`-r<file>`) and `RUBYLIB`.

**npm's and pnpm's settings are refused as a class:**

- any `npm_config_*` or `pnpm_config_*` variable, in any case, `-` or `_`;
- any pnpm `--config.<key>`, camelCase included (`--config.nodeOptions`);
- npm's `--node-options`, `--userconfig`, `--globalconfig` and
  `--script-shell`, and pnpm's `--pnpmfile` and `--global-pnpmfile`.

One pass found four keys that run code:

- node-options;
- script-shell, which runs every package script through the file it names;
- userconfig and globalconfig, whose file can hold node-options;
- pnpmfile and global-pnpmfile, which pnpm runs on install.

Only settings that run nothing pass, in any spelling:
`manage-package-manager-versions`, `loglevel`, `color`, `update-notifier`,
`fund`, `audit` and `progress`. So
`npm_config_manage_package_manager_versions=false pnpm -v` runs. npm also
takes a setting after its verb and expands any prefix it can place, so in
a worktree an npm or npx line is refused when it gives node-options,
userconfig, globalconfig or script-shell anywhere before a `--`, spelled in
full or as a prefix (`npm run x --userc <file>`, `--node-o=…`, `--scr`,
`--globalc`: npm 11 ran each).

These cost a consumer `HOME=<tmp>` for test isolation and
`PYTHONPATH=src pytest`; put such a setting in a package script.

A setting or file written inside the checkout (`.npmrc`'s `node-options`, a
`.zshenv`, a `sitecustomize.py` on the default path, `mise.toml`) is
repository content, as a script is.

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
    },
    "protectedPaths": [".githooks/", "scripts/guards.sh", "node_modules/"],
    "protectedPathsReason": "the git hooks run them on every commit and push; the owner changes them",
    "pushHosts": ["github.com", "gitlab.com"]
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
- `protectedPaths`: paths relative to the checkout's root (a folder covers
  everything below it) that stay refused in every checkout an agent owns:
  its Claude-managed worktree, and an owned plain clone, where they join
  `ownCheckout.protectedPaths`. List the files your own git hooks run. Where
  `core.hooksPath` points at a tracked folder, each worktree runs its own
  copy of the hooks, of the scripts and settings they read, and of the
  guards installed in its `node_modules`. A session that could edit them
  could make its own commits and pushes skip their checks.
  `protectedPathsReason` is required with the paths. It goes into every
  refusal, so say there why the paths are protected and how they get
  changed instead (the owner edits them, or allows one session by taking
  the path off the list in the settings the hooks load; those settings are
  every session's, so a path off the list is open to all of them until it
  is back).

  An Edit, Write or NotebookEdit of a listed path is refused, and so is a
  Bash command whose targets land in one (`sed -i`, `cp`, `touch`, `chmod`,
  `ln`, `rm`, through `sh -c` or `pnpm exec` too) or hold one (`rm -rf
  .githooks`, `mv .githooks off`). A command that names the checkout's root
  as what it writes (`rm -rf .`, `chmod -R a-x .`, `find . -delete`, `cp
  file .`) is refused too, in an owned clone as well: name the paths
  instead (`cp file ./file`). A mutating command run from a folder that
  holds one (`scripts/`, when `scripts/guards.sh` is listed) counts that
  folder as a target, so run it from the root. Paths compare as in an owned
  clone: by file identity too, so another case spelling or a symlink
  reaches nothing. A listed folder of links does not cover what they point
  to: pnpm's `node_modules/<pkg>` is a link into `node_modules/.pnpm/`, so
  list `node_modules/` whole. In a worktree, the
  git subcommands that write the paths they name are judged by those paths,
  as in an owned clone: `checkout [<ref>] -- <path>` (and
  `checkout <path>`, where no commit has that name), `restore`, `rm`, `mv`
  and `apply`. So `git rm .githooks/pre-push` and `git restore .` are
  refused, and `git rm --cached` and `git restore --staged` run. Reads run
  as before. Resolving a merge conflict in a listed file is the owner's
  too: the session can write neither side into it.

  The limit, beyond the owned clone's: in a worktree, every other git
  subcommand and every package install stays open, since merging, rebasing,
  switching branches and installing are a worktree's daily work. `merge`,
  `pull`, `rebase`, `cherry-pick`, `stash`, `reset --hard`, a branch switch
  and the index plumbing (`update-index`, `checkout-index`) can still bring
  a committed change to a listed path into the work tree. The plainest:
  git runs no hook that is absent, so switching to a commit without the
  hooks folder (`git switch --detach <commit>`) and pushing from there
  skips every local check. `pnpm install`
  rewrites `node_modules` from the lockfile. Package scripts, tests and
  other repository code write what they like, and so does a
  `trustedCommands` script, which runs before these checks. Environment
  variables a hook reads (one that tells it an agent is pushing) are
  `command.protectedVariables`' job. The guard keeps a session
  from editing the hooks; it does not stop a session set on getting around
  them. Keep the required checks on the server. The settings file the
  hooks load should live outside the session's worktree, as a desktop
  session's main checkout is; otherwise a session can take a path off the
  list. A kavach older than this setting refuses every call on the
  unknown key, so add it only once the pinned kavach knows it.
- `pushHosts`: the hosts a push, or a URL written into git's config for one,
  may name (Pushes, above). Each is a bare host name or IPv4 address, with no
  user, port or scheme, matched exactly in lower case. The list replaces the
  default, `["github.com"]`, so name `github.com` too if you push there, and
  each ssh alias you push through (`github.com-work`). An empty list refuses
  every network push. A kavach older than this setting refuses every call on
  the unknown key, so add it only once the pinned kavach knows it.
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
before the switch. A finding whose call would leave the session where a
warning cannot help in time refuses in either mode, and its row says `refuse`. While a rule warns, an error in its own detection allows
the call and logs a row naming the error's type; refusing, it fails closed.

| Rule | Guard | Fires on |
| --- | --- | --- |
| `pipe-masks-exit` | command | A pipeline ending in `tail` or `head` joined by `&&` to `git push` (`pnpm test \| tail && git push` pushes after a failure), unless the line sets `pipefail`. |
| `cd-out-of-worktree` | command | A literal top-level `cd` or `pushd` to a folder outside the session's checkout (the git work tree of the call's folder; a clone nested inside it counts as inside), naming a peer worktree when it is one. The shell keeps that folder, and the guards then refuse every write until a `cd` back. A target folder in no git repository refuses whatever the rule's mode: from there the worktree guard runs reads only. When the shell is already in a checkout the worktree guard takes as no session's own (another repository, or a main checkout other than the `worktree.ownCheckout` clone), a `cd` into one it does take as a session's own (a worktree under `.claude/worktrees`, or the `worktree.ownCheckout` clone) passes: that is the way back. A `cd` in a subshell or a pipeline, `cd -` and a computed target are not judged. |
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
