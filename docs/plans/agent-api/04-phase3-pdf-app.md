# Phase 3 — PDF in the chat (MCP App viewer)

Requires Phase 1; ships before the public announcement (it IS the launch asset —
record the GIF). ~1 week.

## 3.1 Signed output URLs (the auth bridge)

Problem: `/api/projects/:id/output` sits behind cookie auth; the MCP App iframe is
sandboxed and cross-origin — no cookie, no way to get one. Base64-tunneling PDF
bytes through tool results is rejected (payload caps; a 20 MB thesis dies).

Design:
- HMAC-signed URLs on `/output` only: `&exp=<unix>&sig=HMAC-SHA256(secret,
  projectId|branch|path|exp)`.
- Secret: `ALDINE_SIGNING_SECRET` env; else generated at boot and persisted in
  `META_DIR` (outside the compiler's reach — the META_DIR/DATA_DIR isolation rule
  applies to this secret exactly as it does to API keys).
- Verification runs before the cookie guard for this route; the existing
  `.aldine-out` path regex stays enforced. TTL 15 min. Blast radius of a leaked
  URL: one compile artifact, one branch, 15 minutes, `no-store` already set.
- HARD RULE (SECURITY.md): the signer never generalizes beyond `/output`. No
  "signed URL for any file" convenience — that bypasses authz one favor at a time.
- `compile` tool result carries the signed `pdfUrl` + `pageCount`; add
  `get_pdf_url({project, branch?})` (read-only) for re-fetch without recompiling.

## 3.2 The viewer (ui:// resource)

- `ui://aldine/pdf-viewer`, MIME `text/html+mcp`, declared via `_meta.ui.resourceUri`
  on the `compile` (and `get_pdf_url`) tools. Extension negotiation:
  `io.modelcontextprotocol/ui`. Build against `@modelcontextprotocol/ext-apps`;
  the official ext-apps `pdf-server` example is the reference implementation.
- Fully self-contained HTML: pdf.js core + worker inlined (~1.5–2 MB, loaded once
  per conversation). `_meta.ui.csp` allowlists exactly the instance origin (for the
  signed PDF fetch). No other external origins.
- Rendering: page 1 eagerly, virtualize the rest — port the approach (not the code)
  from PdfPane's virtualization (commit 0bbff9a). Display cap ~50 MB.
- Layout (700–800 px chat column, light+dark via prefers-color-scheme; pages stay
  white — it's paper):
  - Status row: `<file>.pdf · <branch> · typeset <time> · <n> pages` (the
    stale-preview antidote).
  - Error strip (only when errors > 0): amber, collapsed; each row `file:line
    message`, click = deep link into Aldine at that line.
  - Canvas area, fit-width default, internal scroll.
  - Control bar: page ‹ n / N ›, zoom − / 100 % / +, **Open in Aldine** (primary,
    deep link with `?file=&line=`).
- Deliberately NOT in the viewer: recompile button (proxied tools/call hits the
  host approval flow mid-iframe — confusing; typing "recompile" in chat is better
  and lets Claude react), SyncTeX, any editing. The viewer answers "does my paper
  look right?" and offers one exit.
- Compile-failed state: status row + error strip + Open in Aldine, no canvas.
  Never a broken/empty iframe.
- Graceful degradation: hosts without MCP Apps (e.g. mobile) still get `pdfUrl` +
  `deepLink` in the tool result text path.

## 3.3 Aldine deep-link support

Accept `?file=&line=` on the project URL: open file, scroll to line, flash it.
Needed by the viewer's two click-throughs; independently useful. (~1 day incl.
e2e.)

## 3.4 Acceptance

- Server: signed-URL unit tests — valid, expired, tampered sig, path outside
  `.aldine-out`, wrong branch. e2e: full-suite green.
- Viewer: Playwright loads the built viewer HTML directly against a real signed
  URL from a compiled fixture project — asserts render, page nav, error strip,
  deep-link href. Both color schemes.
- Manual matrix before announce: claude.ai web + Claude Desktop + Cowork, a
  figure-heavy 10 MB PDF, and one compile-failure case.
- CHANGELOG; GIF recorded for the announcement.
