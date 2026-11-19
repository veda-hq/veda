# needs-you

A Claude Code plugin: a band above the message box listing what this chat is
waiting on from you. Part of [Veda](https://github.com/veda-hq/veda). It is a
plugin only, installed from this repository's marketplace; nothing is
published to npm.

## What it shows

One line per thing the chat waits on, oldest first, three at a time (`show
all` lists the rest):

| Line | When it shows | Its buttons | When it goes |
| --- | --- | --- | --- |
| A question at the end of a turn | The turn ends with a next-step question (the desktop app's wrap-up `ask`) | Its reply buttons: pressing one sends that label as your reply | You reply, by a button or by typing |
| An open question dialog | Claude has asked you a question in a dialog | none: answer in the dialog | The dialog is answered or closed |
| A side session | A session below this chat (one it started, one that one started, and so on down) is waiting on you: its title starts with ✋ | `Open session`, which opens it beside this chat | Its title loses the ✋, or it is archived |

Each line says who asks (`this chat` or `side session`), how long it has
waited, and links the page it is about (a claude.ai artifact) when it names
one. `hide` folds the band to a single line with the count; `show` brings it
back. With nothing waiting, the band is not drawn.

A turn that ends waiting on you always reaches the band: a wrap-up marked
`blocked: true` whose `ask` is missing or blank is refused before it runs,
and Claude is told to call it again with the question and its reply buttons
(or to leave `blocked` out when the turn does not wait on you). A question
written only in the chat message, with no wrap-up `ask`, is not caught here;
sarathi's `ask-gate.sh` on Stop is to turn it into one (veda-hq/veda#291).

## Filing a session that waits on you

The band shows only in the chat it belongs to. So that a waiting session
shows without its chat open, a turn whose wrap-up carries an `ask` also files
the session in the desktop app's sidebar. The plugin makes these calls
itself, through the app's session tools; the model makes none.

- The session's title gets a leading ✋.
- The row the sidebar draws moves under the "Needs you" section, which is
  made if the sidebar has none. A nested side session cannot move alone: the
  app moves it only with the top session of its family. So for a nested
  session the top session moves, found by walking up from the session's
  parent, archived ones included. The whole family then shows under "Needs
  you", and the top session's band lists the waiting session, however deep.
- That row is marked unread.

Your answer unfiles it: a prompt you send the session (typed, from the
phone, or a band button), or another session's message, which usually
relays your answer. App events, such as a CI or side-session note, leave it
filed: the session still waits. The ✋ comes off, and the top session goes
back to its group, and its pin, once no other filed session lives under it.
An answer given elsewhere only, such as a 👍 on GitHub, leaves the session
filed until someone tells it, since until then it does not go on either.

What was moved is kept in the plugin's store, shared by the sessions on this
machine, so the session that unfiles last need not be the one that filed
first. A filed session that is archived without an answer stops holding its
top session the next time another session under it unfiles. Each app call
gives up after 20 seconds, as one the app holds for an approval card would.
A failure is logged once, as `needs-you: the sidebar was not updated (…)`;
in a session without the app's tools (a terminal) nothing is filed and
nothing is logged.

Side sessions are read every minute through the desktop app's session tools,
so that line shows only where those tools are connected. Where they are not
(a terminal session), the plugin says so in one line and stops asking until
the session starts again. A failed read is logged once: the same failure
again is not, until a read of the list has succeeded; a different failure is
logged when it first happens. So a failure repeating every minute never fills
the transcript; an answer that is plain text rather than JSON (`Session …
not found.`) is read as no session and logged nowhere.

## Install

At the prompt of a terminal session:

```text
/plugin install needs-you --marketplace veda-hq/veda
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```sh
claude plugin install needs-you --marketplace veda-hq/veda
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `veda-hq/veda`, then Add plugin. A
plugin installed from a terminal at the user scope also loads in the desktop
app's local sessions.

## Developing

```sh
claude plugin validate packages/needs-you
claude plugin test packages/needs-you
```

CI runs both with a pinned Claude Code build. `claude --plugin-dir
packages/needs-you` loads the folder for one session. The engine writes the
editor types into `.claude-plugin/types/` the first time it loads the plugin;
that folder is not committed.
