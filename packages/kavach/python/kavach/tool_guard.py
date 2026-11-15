"""The tool guard: a Claude Code PreToolUse hook for tools other than Bash.

Run as ``python3 <kavach>/python/kavach/tool_guard.py`` with one PreToolUse
event on stdin, for the tools whose calls rules.py reads (its hook's
matcher is ``rules.TOOL_MATCHER``). Exit 0 allows the call, with any warning in a PreToolUse
answer on stdout; exit 2 refuses it, with ``BLOCKED: ...`` on stderr. Any
other end refuses too.

It runs the rules of rules.py written for the event's tool, each in the mode
the consumer's settings give it (config.py, ``rules``): a new rule warns
until they say "refuse". A payload that is not a tool call, settings that
cannot be read and an error in a refusing rule refuse; an error in a rule
that only warns allows, and is logged. Like command_guard.py, it puts its own
folder first on sys.path, so no file in the call's folder can stand in for
one of its modules.
"""

import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))


def isolate():
    """Put this file's directory first on sys.path (command_guard.isolate)."""
    if sys.flags.safe_path:
        sys.path.insert(0, HERE)
    else:
        sys.path[0] = HERE


def refuse(reason):
    sys.stderr.write("BLOCKED: the tool guard %s, so it cannot judge this call.\n" % reason)
    return 2


def fired(rule, mode, message):
    """Log one fire (command_guard.fired): a refusal's row as it ends, a
    warning's now. Logging never changes a verdict."""
    try:
        import refusal_log
        if mode == "refuse":
            refusal_log.label(rule, mode)
        else:
            refusal_log.record("tool", os.environ.get("HOOK_INPUT", ""), "WARNING: " + message, rule=rule, mode=mode)
    except BaseException:
        return


def main():
    isolate()
    try:
        os.environ["HOOK_INPUT"] = os.fsdecode(sys.stdin.buffer.read())
    except BaseException as error:
        return refuse("could not read its hook input (%s)" % type(error).__name__)
    try:
        import config
        loaded = config.load()
    except BaseException as error:
        return refuse("could not load its settings (%s: %s)" % (type(error).__name__, error))
    try:
        import rules
    except BaseException as error:
        return refuse("could not load rules.py (%s)" % type(error).__name__)
    call = rules.read_call(os.environ["HOOK_INPUT"])
    if call is None:
        return refuse("got a payload that is not a tool call")
    try:
        outcome = rules.judge(call, loaded, fired)
    except BaseException as error:
        return refuse("failed (%s: %s)" % (type(error).__name__, error))
    if outcome.refusals:
        sys.stderr.write(rules.refusal(outcome.refusals) + "\n")
        return 2
    if outcome.warnings:
        print(rules.answer([rules.context(fire) for fire in outcome.warnings]))
    return 0


def run():
    """``main``, with each refusal written to the refusal log (refusal_log.py)."""
    isolate()
    try:
        import refusal_log
    except BaseException as error:
        return refuse("could not load refusal_log.py (%s)" % type(error).__name__)
    return refusal_log.guarded("tool", main, lambda: os.environ.get("HOOK_INPUT", ""))


if __name__ == "__main__":
    sys.exit(run())
