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
| A side session | A session this chat started is waiting on you: it gives itself a title starting with ✋ | `Open session`, which opens it beside this chat | Its title loses the ✋, or it is archived |

Each line says who asks (`this chat` or `side session`), how long it has
waited, and links the page it is about (a claude.ai artifact) when it names
one. `hide` folds the band to a single line with the count; `show` brings it
back. With nothing waiting, the band is not drawn.

A turn that ends waiting on you always reaches the band: a wrap-up marked
`blocked: true` whose `ask` is missing or blank is refused before it runs,
and Claude is told to call it again with the question and its reply buttons
(or to leave `blocked` out when the turn does not wait on you). A question
written only in the chat message, with neither `blocked` nor `ask`, is not
caught.

Side sessions are read every minute through the desktop app's session tools,
so that line shows only where those tools are connected.

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
