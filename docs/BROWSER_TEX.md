# TeX in the browser

With `ALDINE_TYPESET=browser` Aldine runs without its compiler container.
The app server hands each browser TeX Live compiled to WebAssembly, and
typesetting happens in the browser. A deployment is one image, and it needs
no 2.4 GB TeX Live pull.

The default (`ALDINE_TYPESET` unset) is unchanged: the compiler container
typesets.

## How it works

- **The engine** is [TeXlyre's BusyTeX build](https://github.com/TeXlyre/texlyre-busytex-build)
  (TeX Live 2026: pdfLaTeX, XeLaTeX, LuaLaTeX, BibTeX, Biber, makeindex,
  SyncTeX). It is licensed AGPL-3.0, like Aldine. The server fetches a
  pinned release on first start, checks each file's sha256, and serves the
  files from its own origin. Browsers keep them in their cache.
- **Every tab with TeX typesets its own PDF**, on every change: your edits,
  a co-author's and an agent's. The PDF is shown from memory, and SyncTeX
  runs in the tab. Error rows come from the compiler's own log parser, which
  the app server runs.
- **Some runs are published to the server**: runs whose PDF is final (a
  full typeset, or a quick draft that left no references behind), from one
  tab per branch, at most every 10 seconds, and never twice for the same
  source. What reads the PDF on the server works as before: the
  project list's thumbnail and download, share links, the agent's
  `get_pdf_url`, and the PDF a reopened project shows first.
- **Phones don't download TeX.** They show the PDF that other people's
  browsers publish. "Typeset in this
  browser" in the command palette opts a device in, and "Stop typesetting
  in this browser" opts it out.
- **Packages beyond the profile are fetched on demand.** When TeX misses a
  file, the server looks it up in TeX Live's package database
  (`texlive.tlpdb`), downloads that package from a TeX Live mirror once,
  checks it against the database's sha512, and serves it from its cache.
- **An agent's or an API caller's typeset** (`compile` over MCP,
  `POST /api/projects/:id/compile`) is run by an open Aldine tab on the
  branch. With no tab open, the call fails with a message saying so.
- **Viewers typeset in their own browser** but cannot publish. The PDF
  everyone else sees always comes from someone who may edit.

## Run it

```bash
docker compose -f docker-compose.browser.yml up -d
```

The first start downloads the TeX build into the cache volume, about 270 MB
for the `recommended` profile with Biber. Typesetting reports "TeX for the
browser is still being prepared" until the download finishes. Each browser
then downloads its profile once from your server:

| `ALDINE_BROWSER_TEX_PROFILE` | Per browser | Covers |
|---|---|---|
| `basic` | ~125 MB | LaTeX base; everything else on demand |
| `recommended` (default) | ~235 MB | Most papers without fetching anything |
| `extra` | ~375 MB | Close to the compiler image's TeX Live |

### Without internet access

Bake the build into an image, so nothing is downloaded at start:

```bash
docker build -f deploy/browser-tex/Dockerfile \
  --build-arg ALDINE_VERSION=1.9.1 --build-arg BROWSER_TEX_PROFILE=recommended \
  -t aldine-app:1.9.1-browser .
```

Use that image in `docker-compose.browser.yml`. The image carries the build's
license texts (TeXlyre's AGPL-3.0 and NOTICE) beside it. Then do one of these:

- Point `ALDINE_TEXLIVE_MIRROR` at a TeX Live 2026 tlnet inside your
  network, so on-demand packages still work.
- Set `ALDINE_TEXLIVE_ONDEMAND=0`. The profile is then everything browsers
  have, so choose `extra`.

### Another build or a mirror of it

The server knows the build only as files named in a manifest with their
sha256 (`apps/server/src/browsertex/manifest.ts`). To serve a newer release,
a mirror of it, or your own build, write a JSON file of the same shape and
set `ALDINE_BROWSER_TEX_MANIFEST` to it. The manifest's `version` must
change whenever a file does: browsers cache everything under it as
immutable.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ALDINE_TYPESET` | `server` | `browser` turns this mode on |
| `ALDINE_BROWSER_TEX_PROFILE` | `recommended` | `basic`, `recommended` or `extra` |
| `ALDINE_BROWSER_TEX_BIBER` | on | `0` leaves Biber out (saves ~32 MB per browser; biblatex then needs `backend=bibtex`) |
| `ALDINE_BROWSER_TEX_DIR` | — | A directory with the build already in it (`<dir>/<version>/<file>`), as baked by `deploy/browser-tex/Dockerfile` |
| `ALDINE_BROWSER_TEX_MANIFEST` | the pinned TeXlyre release | A JSON manifest naming another build |
| `ALDINE_TEXLIVE_ONDEMAND` | on | `0` turns on-demand packages off |
| `ALDINE_TEXLIVE_MIRROR` | `https://mirror.ctan.org/systems/texlive/tlnet` | The tlnet on-demand packages come from. It must be the build's TeX Live release, 2026; once TeX Live 2027 is out, use a historic archive's `2026/tlnet-final` |
| `ALDINE_TEXLIVE_CACHE_MAX_MB` | `4096` | Packages fetched on demand stop being added beyond this |
| `ALDINE_BROWSER_UPLOAD_MAX_BYTES` | 256 MB | Largest published run (PDF, SyncTeX, log). A proxy in front needs `client_max_body_size` at least this |
| `ALDINE_BROWSER_TYPESET_MAX_BYTES` | 256 MB | Largest project a browser is given to typeset |
| `ALDINE_BROWSER_CLAIM_MS` | `20000` | How long an agent's or API caller's typeset waits for a tab to take it |
| `ALDINE_BROWSER_TYPESET_TIMEOUT_MS` | `300000` | How long a tab may take with a run it took |

With accounts on (`AUTH_ENABLED=1`), only signed-in people can download the
build and on-demand packages.

## What differs from the compiler

- **A run with an error shows no new PDF.** The build stops at the first
  error, as "Stop on first error" does with the compiler, and the previous
  PDF stays on screen. With the compiler, a document with errors still
  typesets to the end by default.
- **No shell escape.** `minted`, `\write18` and EPS conversion do not work.
  The compiler allows a restricted list.
- **Fonts are those in TeX Live.** XeLaTeX and LuaLaTeX cannot see fonts
  installed on the computer. Upload a font file into the project to use it.
- **Large documents meet the browser's memory.** The engine has a fixed
  512 MB heap.
- **The first typeset on a device waits for the download.** The PDF pane
  shows "Loading TeX… n%". Later visits load TeX from the browser's cache in
  a second or two.
- **The venue gallery is empty and repository template previews are not
  rendered.** Both come from the compiler image's installed classes.
