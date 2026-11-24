# Assistant names

An assistant's change says which assistant made it and for whom: "ChatGPT
(for Ada)". Before this, every assistant commit read "Claude (for Ada)",
whichever client wrote it.

## Format

An assistant commit keeps its author and gains one trailer:

```
Author: Claude <claude@aldine.local>

Reword the opening line

On-behalf-of: Ada Lovelace
Agent-client: ChatGPT
```

- **Author** stays "Claude". The review prompt, the History dot, the
  "changes since" baseline and the rule that a typist never signs an
  assistant commit all compare the author with that one name, in commits
  that already exist. Changing it would need a second way to recognise old
  and new commits alike.
- **On-behalf-of** is the owner of the access token, as before.
- **Agent-client** is the name the client registered under when it
  connected (dynamic registration, a metadata document, or
  `oauth-add-client`). It is the name the person saw on the consent page
  and approved.

## Where the name shows

- History rows and the diff dialog.
- The "edited 2 files" prompt after an assistant session.
- The presence chip while the assistant writes, and the wait notice.
- Comments and replies the assistant writes.
- `GET /api/projects/:id/log` and `/agent-activity`: an optional `client`
  field on assistant commits.

Several clients in one session or one prompt are listed once each:
"ChatGPT, Claude Code (for Ada, Ben)".

## Limits

- **The name is the client's own claim.** With open registration any client
  can register as "ChatGPT". The person approved that name on the consent
  page, and the token is theirs, so `On-behalf-of` is the part Aldine
  vouches for. An instance that closes registration
  (`ALDINE_OAUTH_REGISTRATION=closed`) decides the names itself.
- **A personal access token names no client.** Aldine cannot tell what runs
  behind a pasted token, so those commits carry no `Agent-client` line and
  read "Claude (for Ada)".
- **No model name.** A client does not tell the server which model it runs,
  and one client can switch models between calls.
- **Older commits stay "Claude".** The trailer is written at commit time and
  is not filled in later.
- **On the git host the author is still "Claude".** The trailer travels with
  the commit, but GitHub and GitLab show the author line.
- **A message cannot claim a client.** An `Agent-client:` line in the
  assistant's commit message is dropped; the token decides. The trailer is
  read only on commits whose author is "Claude", so a person's hand-made
  commit never reads as a client's.
- **The name is cleaned**: one line, no angle brackets, parentheses or
  commas, at most 60 characters, and never "Aldine". A client cannot write
  the "(for …)" half of the label or pass as two clients.
- **Mixed sessions.** Work made with a personal access token beside work
  from a connected client is listed as "Claude" next to it: "ChatGPT, Claude
  (for Ada)".
- **Without accounts** (`ALDINE_MCP_TOKEN`) there is no client and no
  person: the commits read "Claude".

## Not changed

Wording in the product that speaks about the assistant in general ("Review
Claude's changes", "Revert Claude's edits") still says Claude.
