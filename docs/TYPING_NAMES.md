# Names for typing

With accounts on (`AUTH_ENABLED`), the commit that saves what people typed
names them. Without accounts nothing changes: autosaves stay anonymous.

## Format

An autosave keeps its subject, `aldine: autosave`, so History still folds
autosaves, and the "changes since" baseline still skips them. Only the
people on it change:

```
Author: Ada Lovelace <ada@example.org>

aldine: autosave

Co-authored-by: Ben Okafor <ben.okafor@aldine.local>
```

- **Author:** the first person whose typing the save holds. The address is
  the account's commit email (Account settings), otherwise the derived
  `name@aldine.local`. A sign-in address is never used.
- **Co-authored-by:** one line for each other person who typed. GitHub and
  GitLab read these lines too, so a pushed autosave shows everyone.
- **A person's own commit** (a checkpoint, a merge, the save before a pull)
  is authored by that person as before. Anyone else whose typing it holds
  gets a Co-authored-by line.
- **Assistant commits** never carry a typist. The typing in a file an assistant is
  about to write is saved first, under the people who typed it.
- **Not used as names:** "Assistant", "Claude" and "Aldine" (History reads those as the
  agent and as nobody), and angle brackets or line breaks in a name.
- **History** shows the author and co-authors by name ("Ada Lovelace and Ben
  Okafor"); the log answer carries names only, never the addresses.

## How the names are collected

Each open document remembers who sent an update since its last write to
disk. When the document is written, those people are noted against that
file. A commit that takes the file takes the names noted for it. So the
names follow the bytes: typing that is undone before the next write names
nobody, and a save of one file names only the people who typed in that
file. The runner notes the person who started a run against the files it
wrote back.

## Limits

- One save can name several people. It cannot say whose line is whose.
- It needs accounts. Saves made before this change stay anonymous.
- The names are kept in memory until the commit. A crash or a hard kill in
  the 20-second window loses the names, not the text: that save is anonymous.
- Typing relayed from another node (`REDIS_URL`, not a supported topology,
  see [SCALING.md](SCALING.md)) is not named on the node that receives it.
- A commit email changed during a session is used from the next reconnect.
- A self-hosted history can be rewritten by whoever runs the server. The
  names say who typed according to this server; they are not a signature.
