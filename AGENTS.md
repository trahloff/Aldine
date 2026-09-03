# AGENTS.md

Guidance for AI agents (and a fast orientation for humans) working in this repo.

## What this is

Aldine — a slim, self-hosted collaborative LaTeX platform (Overleaf
alternative). Fastify server with embedded Hocuspocus/Yjs collab, per-project
git repos (worktree per branch), sandboxed TeX Live compiler service, React 19
+ Vite + CodeMirror 6 frontend. AGPL-3.0.

## Layout

- `apps/server` — Fastify API, collab (Yjs snapshots + debounced git
  autocommit), auth (env-gated, off by default), datastore seam
  (`src/db/`: JSON files default, Postgres via `DATABASE_URL`)
- `apps/web` — React SPA; `src/editor/visual/` is the visual editing mode
  (pure decoration layer, **byte-stable by contract** — rendering must never
  change source bytes; an e2e test enforces this)
- `apps/compiler` — zero-dependency Node HTTP wrapper around latexmk
  (restricted shell-escape, no egress in compose)
- `e2e` — Playwright suites (`tests/`), screenshot/demo generators
  (`shots.mjs`, `demo.mjs`), fixtures
- `deploy` — compose overlays, nginx sample, AWS (Terraform) + Hetzner demo stacks
- `site` — aldine.dev landing page (GitHub Pages), `plugins`, `templates`

## Commands

```bash
npm install                                  # workspace root
npm run typecheck -w apps/web                # tsc, no emit
npm run test -w apps/web                     # vitest unit tests
npm run dev:server / dev:web / dev:compiler  # local stack (:3000 / :5173 / :4020)
npm run test:e2e                             # playwright (starts its own server)
```

e2e needs the compiler on :4020 **with the e2e data dir**:
`DATA_DIR=$(pwd)/.data-e2e PORT=4020 node apps/compiler/server.js` — a
compiler on the default `.data` makes every compile test fail while looking
healthy. `ALDINE_URL=http://localhost:8080 npm run test:e2e` targets a running
compose stack instead. Two `07-features` tests need full TeX Live (BasicTeX
lacks packages); everything else passes locally. Two checkouts side by side
(`reuseExistingServer` would otherwise test the other tree's server):
`E2E_PORT=3101 E2E_MOCK_PORT=4920 E2E_AUTH_PORT=3201 COMPILER_URL=http://localhost:4021 npm run test:e2e`.

## Conventions

- Comments state constraints the code can't express — never narration of the
  change or the reviewer's rationale.
- Every headline feature gets an e2e test; UI elements carry `data-testid`.
- New/changed runtime deps: commit the updated `package-lock.json` or CI's
  `npm ci` fails.
- Feature flags: experimental UI ships behind localStorage flags
  (`aldine.experimental.*`), announced in the command palette.
- User-visible strings are sentence-case, concrete, and name the action.
- `CHANGELOG.md` (Keep-a-Changelog) is updated with the feature, not after.

## Gotchas that have bitten before

- **Byte stability** is the visual editor's core promise — any change there
  must keep the cursor-tour e2e green.
- Yjs docs reload from binary snapshots (`META_DIR` sidecar); never reseed
  open docs from plain text — that duplicates content on reconnect.
- `META_DIR` is deliberately outside `DATA_DIR` so the compiler container can
  never read API keys — don't "simplify" them onto one volume.
- The file tree defaults to source-only view; e2e that asserts non-source
  files must toggle to "All" first.
- Dark theme is the app default (stamped pre-paint in `index.html`);
  Playwright `colorScheme` emulation does *not* switch the app theme —
  drive `localStorage['aldine.theme']` instead.
- git tokens are passed inline per operation, never written to `.git/config`
  (the compiler can read project dirs).
- Playwright `webServer` timeouts are long on purpose; kill stray
  `tsx watch` processes if local ports hang.
