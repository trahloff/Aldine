# Contributing to Aldine

Thanks for your interest! Aldine is a slim, self-hostable LaTeX collaboration
platform. This guide gets you productive quickly.

## Layout

```
apps/server     Fastify API + embedded Hocuspocus (Yjs) collab + git + datastore
apps/compiler   TeX Live compile service (latexmk wrapper), sandboxed
apps/web        React + Vite + CodeMirror 6 + pdf.js frontend
plugins/        Built-in plugins (zotero, references, aifix)
e2e/            Playwright suites (main + auth) and helpers
deploy/         Single-VPS deploy bundle (Caddy TLS, backups, prod compose)
deploy/aws/     Terraform for an AWS Fargate deployment (see its README)
docs/           Architecture & scaling notes, plus the user-story inventory
```

[`docs/USER_STORIES.md`](docs/USER_STORIES.md) is the behavioral contract: what
Aldine promises, by domain, with the suite that automates each one. Adding a
headline feature means adding a story there and a Playwright test for it.

## Local development

```bash
npm ci
# one-time: a compiler on :4020 (docker container sharing ./.data)
docker build -t aldine-compiler apps/compiler
docker run -d --name aldine-compiler-dev -p 4020:4020 -v "$PWD/.data:/data" aldine-compiler

# API on :3000, Vite on :5173 (proxies /api, /plugins + /collab to :3000)
npm run dev -w apps/server
npm run dev -w apps/web    # in another terminal
```

Open http://localhost:5173.

## Checks before a PR

```bash
npm run typecheck -w apps/server
( cd apps/web && npx tsc --noEmit )
npm run build -w apps/web
npm run test -w apps/web                  # vitest unit tests
npm run test:github -w apps/server        # hermetic GitHub-sync integration test
npm run test:db -w apps/server            # datastore conformance (JSON; add
                                          # TEST_DATABASE_URL for the Postgres leg)
```

The Playwright suites build and start their own app instance (:3100 main, :3200
auth), but they do not start a compiler, and they run against `.data-e2e`. Point
a compiler at **that** directory, not `.data`: a compiler on the dev directory
answers `/health` happily and fails every compile test with "root file not
found".

```bash
DATA_DIR=$(pwd)/.data-e2e PORT=4020 node apps/compiler/server.js   # in its own terminal
npx playwright test -c e2e                                   # main (no-auth)
npx playwright test -c e2e/playwright.auth.config.ts         # auth
npx playwright test -c e2e/playwright.base-path.config.ts    # served under /internal/aldine (:3300)
ALDINE_REMOTE_URL=https://staging.example.com npx playwright test -c e2e/playwright.remote.config.ts  # a deployed instance
```

Kill the dev compiler container from the previous section first, or it holds
:4020. Two of the `07-features` tests need full TeX Live and fail on BasicTeX;
everything else passes locally.

CI runs the typecheck/build/integration checks on pushes to `main` and on PRs
(`.github/workflows/ci.yml`), including the datastore conformance suite against
a real Postgres service. The browser suites are not in CI yet: they need a TeX
Live image, so run them locally before a PR that touches a headline feature.

## Contributor License Agreement

The first pull request you open gets a bot comment asking you to sign the
[CLA](CLA.md) by posting one sentence back. It takes a few seconds and covers
everything you contribute afterwards.

You keep the copyright to your work. What the agreement grants Aldine is the
right to distribute your contribution, including under licence terms that differ
from today's AGPL-3.0 — so that a future commercial edition or licence change
does not require tracking down every contributor. Aldine is AGPL-3.0 today and
self-hosting stays free either way. If that trade is not one you want to make,
say so in an issue rather than silently walking away; it is a reasonable thing to
disagree about.

## Conventions

- **Match the surrounding code** — comment density, naming, idioms.
- Security matters: the compiler is sandboxed (restricted shell-escape, no
  egress, dropped caps) and API tokens live in the secrets volume, never in the
  compiler-visible projects dir. Don't loosen these without discussion.
- New persistence goes through the `DataStore` interface (JSON + Postgres), not
  ad-hoc files. See [docs/SCALING.md](docs/SCALING.md).
- Prefer a focused Playwright or integration test with any behavioral change.

## Releasing

A version tag ships to nobody. Pushing one runs `.github/workflows/release.yml`,
which checks the tag is on main and every version pin agrees with it, runs the
full CI suite on that commit, builds `aldine-app` and `aldine-compiler` as
immutable `x.y.z` and `sha-<commit>` tags, boots those exact digests with the
user-facing compose file and typesets a document with a bibliography inside
the sandbox. Then it waits. `:latest` moves, and the GitHub Release appears,
only when you approve the `promote` job (the `latest` environment) in that
same run. Until then nothing a self-hoster pulls has changed.

```bash
# 1. move the CHANGELOG's [Unreleased] entries under a new [x.y.z] heading,
#    and add the compare link at the bottom of the file
# 2. match every pin to the tag you are about to push
npm pkg set version=0.4.0 --workspaces --include-workspace-root
#    and the ${ALDINE_VERSION:-…} default in docker-compose.yml and the README
#    block (scripts/check-release-pins.mjs tells you which one you missed)
# 3. commit, then tag
git tag v0.4.0 && git push origin main v0.4.0
# 4. when the run pauses at "promote", try 0.4.0 somewhere real, then approve
```

To roll back, run "Promote to latest" by hand (Actions tab) with the previous
version: it re-tags the digests that already exist, no rebuild. The same
command is the way to re-promote a version whose approval you let expire.

Budget about an hour for the build: the compiler is built twice, as the
default `medium` scheme and as `-full`, and the full TeX Live image is around
2.8 GB compressed per architecture. Both variants are smoked and promoted
together, so `latest` and `latest-full` always name the same release.
