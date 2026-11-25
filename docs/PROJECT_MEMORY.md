# Project memory

A paper collects more than its text: what the work has shown, what the
authors decided, what is still open, and which script made which figure.
Aldine keeps that as four plain Markdown files at the root of the project,
in its git history like everything else. An assistant you connect is told
to read them before it works and to add to them as it goes, so a fresh
session starts from what is written down instead of from what you paste in.

## The files

| File | Holds |
|---|---|
| `FINDINGS.md` | What the project has established: the claim, the evidence, how sure you are. Newest last; a correction is a new entry. |
| `DECISIONS.md` | What was decided, why, by whom, and when. |
| `TASKS.md` | Open work, one line each, with an owner; ticked when done. |
| `RESULTS.md` | Where each figure, table and number comes from: the script, its inputs, the file it writes, and for raw data the place it lives and its SHA-256. |

Only these names at the project root count. A project can have any of
them; none is required.

## Getting them

- **New project:** pick **Article with project memory** in the New project
  chooser. It is the Article template plus the four files, each with a
  short note on its format.
- **Existing project:** add the files yourself, or ask your assistant to.
  Files you already keep under these names (a `FINDINGS.md` in a repository
  you imported, for example) count as they are.

## What assistants are told

When a client connects, Aldine's MCP server sends one instruction with the
handshake (the MCP `instructions` field):

- call `project_structure` first; its `memory` field lists which of the
  four files the project has;
- read them before working, and use them instead of asking for context
  that is already written down;
- add a short dated entry to the right file when it learns, finishes or is
  told something the files track, with `edit_file`; never rewrite or delete
  what others wrote;
- record a decision only when a person made it, and name that person;
- create the files only when the user asks.

Clients decide whether to show the instruction to their model. Claude does;
others may not, so the same advice is in the `project_structure` tool
description.

## Limits

- The files are text the assistant reads, not a database: nothing checks
  that an entry is true, and anyone with edit access can change them. Their
  history is the project's git history, with the usual names on each change.
- Raw data does not belong in the project. `RESULTS.md` names where it is
  and its checksum, so anyone can check they have the same data.
- There are no screens for the files beyond the editor. That waits until
  the files are in use.
