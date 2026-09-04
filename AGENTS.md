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
  never read API keys — don't "simplify" them onto one volume. Every test runner
  that starts a server must set **both**: `META_DIR` defaults to the repo's real
  `.secrets`, so a runner that sets only `DATA_DIR` writes into the developer's
  own credential store — and `14-remotes.spec.ts` disconnects GitLab as user
  `local`, which silently wiped the real connection.
- Connection lookups follow a deliberate ladder, and which paths get the service
  token is a privilege decision, not an oversight. Sync, autopush and
  provisioning fall back to `serviceConnection()`; `/api/remotes/:provider/repos`,
  `/import` and `/status` never do — there the bot's token would change *which
  repositories a user can reach*, not just how the request is authenticated.
- The file tree defaults to source-only view; e2e that asserts non-source
  files must toggle to "All" first.
- Dark theme is the app default (stamped pre-paint in `index.html`);
  Playwright `colorScheme` emulation does *not* switch the app theme —
  drive `localStorage['aldine.theme']` instead.
- git tokens are passed inline per operation, never written to `.git/config`
  (the compiler can read project dirs).
- Never read `meta.remote` directly — go through `store.remoteLink()`, which
  falls back to the legacy `meta.github`. A direct read treats every project
  created before multi-provider support as unlinked. Write through
  `store.setRemoteLink()`, which drops the legacy field.
- A project's remote provider comes from its stored link, never from the request
  path: `/api/projects/:id/remote/*` has no `:provider` segment on purpose.
- GitLab (when `GITLAB_DEFAULT_GROUP` is set) is a **mirror**, not the store. The
  local per-project repo is load-bearing: the compiler mounts it, branches are
  worktrees, collab autocommits into it, Yjs snapshots sit beside it. "Just keep
  projects in GitLab" is not a simplification available here.
- Project creation must never fail on GitLab. `store.createProject` runs first
  and unconditionally; a provisioning failure sets `meta.remotePending` and
  degrades to local-only.
- Trashing a project deletes its remote repo, but only when
  `meta.remote.createdByAldine` is set. Deleting a repo a user merely imported
  would destroy work Aldine never owned — never widen this without being asked.
  The delete is best-effort: it must never block the local delete, and the purge
  sweep retries it for the ones that failed.
- One `DELETE /projects/:id` does not delete a GitLab project — it marks it and
  keeps it for the instance's retention period. The purge is a second delete with
  `permanently_remove` **addressed by numeric id**, because marking renames the
  path: keyed by path, the follow-up 404s and reads as success. A 404 means "not
  there"; any other error must not, or a delete against a down GitLab reports
  success and drops the link the purge sweep would have retried.
- `createdByAldine` is three-valued on purpose. `true`/`false` are recorded by
  provisioning and by import; **absent** means a link written before the flag
  existed, and treating that as `false` silently leaves those repos on GitLab
  forever. `provision.ts` resolves an absent flag by group membership.
- The service token needs **Owner** on the group, not Maintainer. Maintainer
  creates projects and subgroups fine, so the deployment looks healthy right up
  to the first delete, which 403s.
- The subgroup endpoint's `withinRoot` check is a privilege boundary, not
  validation politeness — without the `/` in its prefix test it creates groups
  anywhere on the instance.
- Templates invert the mirror rule. Auto-provisioning must never fail project
  creation, but a *template* is the content the caller asked for: if the chosen
  template can't be read, the request fails with 400 and no project is created.
  Only the template *listing* degrades (to whatever local templates exist).
- A project from a template is a copy, not a child: the clone is detached, so the
  template repo is never a remote of the new project and never its git parent.
  Making the template `origin` would send everyone's first push at the template.
- Never hardcode a template id in the UI. `TEMPLATES_DIR` and
  `GITLAB_TEMPLATE_GROUP` mean a deployment's templates may share no id with the
  four Aldine ships — the dialog selects the first template the server returns.
- `store.createProject` takes `string | Buffer` values. Reading a template file
  as utf8 silently corrupts logos and bundled PDFs; go through `isTextFile`.
- e2e provisioning tests run against a second server on `:3101`
  (`--project=provisioning`); the main suite deliberately runs with
  auto-provisioning off so the default path stays covered.
- Playwright `webServer` timeouts are long on purpose; kill stray
  `tsx watch` processes if local ports hang.
