"""The command guard: a Claude Code PreToolUse hook for Bash tool calls.

Run as ``python3 <kavach>/python/kavach/command_guard.py`` with one PreToolUse
event on stdin. Exit 0 allows the command; exit 2 refuses it, and stderr
(``BLOCKED: ...``) is fed back to the agent. Any other end refuses too.

It blocks git-hook bypasses, history-destroying pushes and what the
consumer's settings (config.py, from the file KAVACH_CONFIG names) add: a
command that sets a protected variable, and a commit that records one path
of a paired change without the other. Each is read from the repository the
command actually targets.

Two checks, and the command runs only when both allow it: bash_guard.py
first, then git_safety.py, which reads the code the first cannot (below)
and runs against the adversarial corpus in ``corpus/``, every row of which
is also executed in real bash and git.

Limits of bash_guard.py, accepted: it is a static reading of one command
line, not a shell. It cannot see code it would have to run: ``eval``,
``bash -c '...'``, functions and aliases, ``$(...)`` that computes a path,
``env -C``, or shell state set by an earlier Bash call (an exported GIT_DIR,
a cd, ``set -P``) beyond the hook input's cwd. git_safety.py reads eval,
``bash -c``, aliases, ``$(...)``, backticks, heredocs and pipes into a shell
for hook bypasses, forced pushes and paired-change commits. Within one line
bash_guard.py models git's own index writers (add, reset, an earlier
commit…), but not files changed by other programs (rm, cp, ``>``
redirection). Where a path is shell-computed it fails closed; where the
command hides git inside another program it cannot. So the consumer should
keep its own CI check behind the paired-change rule: one that fails any pull
request whose ``requires`` side does not match its ``changes`` side. Heredoc
bodies and quoted strings are stripped before the text checks, so flags are
only caught as real arguments, not inside commit messages or echoed text.

Both checks are imported, not fed on stdin, so Python keeps their compiled
cache: code on stdin recompiles on every call. sys.path[0] is this file's
directory instead of the cwd, so no file in the command's directory can
stand in for a module of the guard or of the standard library (``os`` and
``sys`` are loaded before this file runs). Any failure blocks, a module
missing or any error raised in it: Claude Code lets a hook's exit 1
through, so a crash would wave the command on. Still open: an interpreter
that cannot start, or one killed by a signal. Only a check's integer 0 or 2
is a verdict.

The hook's stdin is read here, byte for byte, never passed on through a
child's environment: Linux caps one environment string at 128 KiB and macOS
all of exec's strings at about 1 MiB, and over the cap the exec fails, which
Claude Code lets through. Both checks read HOOK_INPUT from os.environ, so
the entry sets it there, decoded as the environment decodes it so a payload
that is not UTF-8 still arrives. A failed read leaves the input unknown,
however much of it arrived, so it blocks. Settings that cannot be read
(config.ConfigError) block as well: a guard that misread its settings must
not allow.
"""

import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))


def isolate():
    """Put this file's directory first on sys.path, where Python put the
    script's directory (run as a file) or the cwd (``-c``, ``-m``). Under
    ``-P`` or ``-I`` Python put neither there, so the directory goes in front."""
    if sys.flags.safe_path:
        sys.path.insert(0, HERE)
    else:
        sys.path[0] = HERE


def verdict(check, run, missing, module):
    """0 or 2 from one check. Any other end of it blocks and says why."""
    try:
        run()
    except SystemExit as end:
        # Only its two verdicts pass: the integers 0 (allow) and 2 (block). A bare
        # sys.exit() (None) gives neither, and Python exits 1 for 2.0.
        if type(end.code) is int and end.code in (0, 2):
            return end.code
        reason = "exited with %r instead of a verdict" % (end.code,)
    except BaseException as error:
        if isinstance(error, (ModuleNotFoundError, FileNotFoundError)) and (
            getattr(error, "name", None) == module or getattr(error, "filename", None) == module
        ):
            reason = "could not load " + missing
        else:
            reason = "failed (%s: %s)" % (type(error).__name__, error)
    else:
        reason = "finished without a verdict"
    sys.stderr.write("BLOCKED: %s %s, so it cannot judge this command.\n" % (check, reason))
    return 2


def settings():
    """The consumer's config.Config, or None once it has said why it blocks."""
    try:
        import config
    except BaseException as error:
        if isinstance(error, ModuleNotFoundError) and error.name == "config":
            reason = "could not load config.py"
        else:
            reason = "could not load its settings (%s: %s)" % (type(error).__name__, error)
        sys.stderr.write("BLOCKED: the command guard %s, so it cannot judge this command.\n" % reason)
        return None
    try:
        return config.load()
    except config.ConfigError as error:
        reason = "has unusable settings (%s)" % (error,)
    except BaseException as error:
        reason = "could not load its settings (%s: %s)" % (type(error).__name__, error)
    sys.stderr.write("BLOCKED: the command guard %s, so it cannot judge this command.\n" % reason)
    return None


def cannot_name_git():
    """A command git_safety.py has nothing to read: no "git" in any case,
    nothing that could spell it (quoting, an escape, an expansion, a glob or
    a brace), and nothing that could feed a shell a program another command
    wrote (a pipe, a redirection, a process substitution): `echo fhs otrg
    --enqbd | tr a-z b-z | bash` runs `git push --force`. The fast exit in
    bash_guard.py, narrowed."""
    import json, re
    try:
        command = json.loads(os.environ["HOOK_INPUT"])["tool_input"]["command"]
    except Exception:
        return False
    return isinstance(command, str) and not re.search(r"(?i)git|[\\\x27\"$`*?\[{|<>(]", command)


def main():
    isolate()
    try:
        os.environ["HOOK_INPUT"] = os.fsdecode(sys.stdin.buffer.read())
    except BaseException as error:
        sys.stderr.write(
            "BLOCKED: the git-command check could not read its hook input (%s), so it cannot judge this command.\n"
            % type(error).__name__
        )
        return 2
    loaded = settings()
    if loaded is None:
        return 2
    if verdict("the git-command check", lambda: __import__("bash_guard"), "bash_guard.py", "bash_guard") == 2:
        return 2
    if cannot_name_git():
        return 0
    return verdict(
        "the shell-code check",
        lambda: __import__("git_safety").hook_main(loaded),
        "git_safety.py",
        "git_safety",
    )


def run():
    """``main``, with each refusal written to the refusal log (refusal_log.py)."""
    isolate()
    try:
        import refusal_log
    except BaseException as error:
        sys.stderr.write(
            "BLOCKED: the command guard could not load refusal_log.py (%s), so it cannot judge this command.\n"
            % type(error).__name__
        )
        return 2
    return refusal_log.guarded("command", main, lambda: os.environ.get("HOOK_INPUT", ""))


if __name__ == "__main__":
    sys.exit(run())
