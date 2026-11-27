---
name: slice-review
description: A fresh-eyes review of a niyam slice before `niyam propose` - one read-only subagent that never saw the conversation gets the slice's body, the files it names and its contract, and reports what is wrong, missing or unclear; the proposing agent answers each finding. Use before proposing a slice for the owner's approval.
---

# Review a slice with fresh eyes

The session that writes a slice knows what it meant, so it reads its own
**You will see:**, **Why:** and **Guards:** as complete. The advisor sees
the whole transcript, so it shares that framing; a review bot reads with
fresh eyes, but only the code, and only after the push. The owner approves
the slice as written, and the agent then builds what it says. So before
`niyam propose`, one reader that never saw the conversation reads the slice
as the owner will: with only what it says and the files it names.

The step takes one idea from the Elephant-Goldfish Model (a reviewer with
zero conversational history) [1] and the doubt-driven rule of passing the
artifact and its contract, never the claim, with an adversarial brief that
asks for issues only [2].

## When

Before `niyam propose` for a slice: a new one, or one whose **You will
see:**, **Why:** or **Guards:** changed in substance since its last review.
Not for a State's drop, a fix's State, or a run of `propose` on a slice
already reviewed and unchanged.

## 1. Extract

Give the reviewer the artifact and its contract:

- the slice's title and body, verbatim, as it will be filed;
- the paths of the files it names, for the reviewer to read itself;
- where the repository lists its guard files (in veda, `CLAUDE.md`'s
  "Merging" section and the `"guard"` list in `.github/niyam.json`);
- the contract in the brief below, as it stands.

Leave out the conversation, your reasons for thinking the slice is ready,
the options you dropped, and the work item's discussion. If the reviewer
needs a fact to judge the slice, the slice should say it: a fact you would
have to add to the prompt is a finding already, so add it to the slice.

## 2. Doubt

One subagent, one pass. Use the `Explore` type: it is read-only, and
Claude Code's own `Explore` loads neither `CLAUDE.md` nor memory. Where a
hook runs the call as a separate session instead, `CLAUDE.md`, the memory
index and the user's instructions reach the reviewer. Those are the
repository's rules, not the session's reasoning, so the review still counts;
note what ran. Paste this brief with its slots filled:

```text
Adversarial review. Below is a work slice that an agent will ask its owner
to approve. Once approved, the agent builds what it says, and the approval
covers nothing it leaves out. You never saw how it was written. Read it as
the owner will: with only what is here and in the files it names.

Find what is wrong, missing or unclear:
- a line under **You will see:** that the owner could not check once the
  work is merged, or that would hold even if the work were never done;
- an unstated assumption: a fact, file or behaviour the slice relies on
  but never says;
- a **Why:** that does not justify this change, or that claims the owner
  asked without quoting where and when;
- a guard file the work must change that **Guards:** does not name, or a
  named path that does not exist;
- scope: work the slice implies but does not name, or names but does not
  need;
- a cost, or what happens if the owner declines, left unsaid where it
  matters.

Read each named file whole before judging what the slice says about it.
Change nothing, and read nothing outside this repository. Do not validate,
summarise or praise. Report at most five findings, most serious first,
each as one numbered line:
[blocker|major|minor] "<the slice's words you attack>": what is wrong;
what would fix it.
If you find nothing, say "Nothing found" and list what you checked.

CONTRACT
- **You will see:** what the owner can see once the slice is merged
  (behaviour, output, a number, a file); each line checkable then.
- **Why:** why the change is wanted: the owner's words with date and
  place, or the problem it fixes with its evidence.
- **Guards:** every guard file the pull request will change. A guard file
  it changes but does not name fails the pull request, and a name added
  after the owner's approval counts for nothing.
- Guard files are listed in: <where the repository lists them>.

FILES THE SLICE NAMES
<paths>

SLICE
<title and body, verbatim>
```

## 3. Answer

Re-read the slice against each finding; the reviewer can be wrong for want
of context. For each one, fix the slice, or say why not: it misread the
contract, the fact it lacked belongs in the slice (then add it), or fixing
it costs more than it saves. Put the findings and your answer to each on
the page `niyam propose --page` names, under "Fresh-eyes review", so the
owner sees them; "Nothing found" goes there too. Then file or edit the
slice and propose.

Do not run the review again for a cleaner result: one pass is the step. A
second pass is for a slice whose sections changed in substance after the
first.

## Sources

Read 2026-11-27.

1. google/elephant-goldfish-model at 46933754e63c0424daa9c270d7e0734245d79560,
   `skills/egm-lite/SKILL.md` (stateless spec review) and
   `agents/implementation_readiness.md` (Goldfish isolation):
   https://github.com/google/elephant-goldfish-model
2. addyosmani/agent-skills at e997ac5b9a74eab332d5e9793bb38a38c8cfdd74,
   `skills/doubt-driven-development/SKILL.md`:
   https://github.com/addyosmani/agent-skills/blob/main/skills/doubt-driven-development/SKILL.md
