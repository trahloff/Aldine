# Aldine Agent API — program overview

Status: approved 2026-09-01 · Owner: Toby · Execution: phased, workflow-driven (see WORKFLOW.md)

## What this is

Aldine becomes agent-native: AI agents (Claude as the flagship client) read and write
LaTeX directly in Aldine projects, Aldine compiles, structured errors feed back, and
the typeset PDF renders inside the agent conversation. Aldine stays the source of
truth; the copy-paste loop between chat sessions and the editor disappears.

Delivery vehicle: one MCP server embedded in the existing Fastify app (`/mcp`,
Streamable HTTP), reachable as a Claude custom connector (claude.ai, Desktop, mobile,
Cowork) and runnable as local stdio for Claude Code and private instances.

## Why (market facts, verified 2026-09-01)

- Overleaf has no agent API; its git bridge is premium-only. 8+ community MCP shims
  exist for it, all built on sync hacks. Agent access is Overleaf's weakest flank.
- OpenAI Prism (Jan 2026): free AI-native LaTeX workspace, but model-locked, no API,
  not self-hostable.
- No existing LaTeX MCP server combines project-native storage + server-side compile
  + structured errors + real-time collab. Aldine owns the store AND the compiler, so
  the write→compile→errors→fix loop closes in one tool call.
- MCP Apps (SEP-1865, shipped Jan 2026) render sandboxed interactive iframes in-chat
  in Claude web/Desktop/Cowork — the mechanism for the in-chat PDF viewer. Official
  pdf-server example exists.

## Positioning

- Brand: **agent-native, Claude as flagship client** — not Claude-exclusive
  (MCP Apps also render in ChatGPT, Copilot, Cursor).
- Pitch the friction, not the architecture: "Write LaTeX with Claude. Compile, see
  the PDF, fix errors — without leaving the conversation."
- This is the wedge, not a pivot: core product remains the slim self-hosted Overleaf
  alternative. Retention lives in the error-fix loop (errors recur; drafting doesn't).

## Decisions log

| Decision | Choice | Date |
|---|---|---|
| Target surface | Remote MCP connector first; same server as stdio for Claude Code/private instances | 2026-09-01 |
| Audience | Toby first; productize once proven | 2026-09-01 |
| Write path | Live into Yjs collab session via anchored splices (no typing simulation, no whole-file swaps on open docs) | 2026-09-01 |
| PDF | Rendered inside Claude via MCP App; deep link as fallback | 2026-09-01 |
| HN launch relation | Tease at core launch ("agent integration coming"); ship weeks later as its own announcement | 2026-09-01 |
| Demo trial | demo.aldine.dev wired as one-click trial connector from Phase 1 (second dogfood env) | 2026-09-01 |
| Naming | "Aldine Agent API" (feature umbrella); settings card "Agent access"; connector name "Aldine" | 2026-09-01 |
| MCP server placement | In-process Fastify route, env-gated; NOT a sidecar/standalone (write primitives are in-process only) | 2026-09-01 |
| v1 auth | PATs (`aldn_` prefix) + Claude `static_headers`; OAuth 2.1 deferred to Phase 4 | 2026-09-01 |
| Async compile API | Rejected — synchronous + MCP progress notifications (120 s bound) | 2026-09-01 |

## Phase map

| Phase | Ships | Spec | Effort |
|---|---|---|---|
| 0 | Foundations: flush-race fixes, contentVersion exposure, PAT layer + settings UI | 01 | 3–5 d |
| 1 | The connector: `/mcp`, 8 tools, agent presence + attribution, demo trial connector | 02 | 1.5–2 wk |
| 2 | Loop polish: references/citations/labels tools, tool-description tuning | 03 | 3–5 d |
| 3 | PDF in chat: signed output URLs, MCP App viewer | 04 | ~1 wk |
| 4 | Public: docs, Claude Code plugin, OAuth + directory (demand-gated) | 05 | 3–5 d (+1 wk OAuth) |

Phase gates: a phase starts only when the previous phase's acceptance criteria pass
and its review findings are resolved. Phase 1 exit criterion: Toby stops copy-pasting
and has not reverted an agent commit in anger for two weeks of daily use.

## Success metrics (instrument server-side from Phase 1)

1. Second-week agent compile: users with ≥1 MCP-initiated compile in week N and N+1
   (the demo-toy detector).
2. Agent compiles per connected project per week (loop depth).
3. % of agent commits reverted (>10 % = the write path is scaring people).
4. Demo-connector sessions → self-host installs (funnel, Phase 4).

## Non-goals (rejected; do not resurrect without new evidence)

- Async compile job API / webhooks (compile is 120 s-bounded; progress notifications suffice).
- Per-conversation server-side state (a project-scoped PAT is the context).
- Agent tools for delete/purge, share management, GitHub push, token management
  (destructive surface — deliberately not expressible).
- SyncTeX tools for agents; vision-in-the-loop layout judging; keystroke-simulation
  "typing" animation.
- Verb-level token scopes (project scope only in v1).

## Reference docs in this pack

- `01-phase0-foundations.md` … `05-phase4-public.md` — implementation specs
- `SECURITY.md` — threat model and required mitigations (applies to every phase)
- `UX.md` — interaction design: presence, attribution, review, viewer, failure states
- `WORKFLOW.md` — how phases are executed with implementation subagents + reviewers
