# Templates

The folders in this directory are the templates Aldine ships in its "New
project" gallery. The same layout works for a **template repository**: any git
repository laid out like this folder, listed by the operator in
`TEMPLATE_REPOS`, shows its templates in the gallery under the repository's
label, next to the shipped ones. This file describes the layout, the manifest,
the placeholders a template can use, and how to point Aldine at your own
repository.

## Layout

One directory per template. A directory is a template if and only if it holds
a `template.json`; everything else in it is copied into a new project as-is,
subdirectories included.

```
templates/
├── article/
│   ├── template.json     # gallery metadata (below)
│   ├── LICENSE           # licence text for the files in this folder
│   ├── main.tex
│   └── references.bib
├── thesis/
│   ├── template.json
│   ├── LICENSE
│   ├── main.tex
│   ├── chapters/intro.tex
│   └── figures/logo.pdf
└── venues.json           # publisher-kit registry, not a template
```

Hidden directories (`.git`, `.github`, …) are skipped. `template.json` and
`LICENSE` are gallery bookkeeping and are never copied into a project. A
`template.json` that is not valid JSON is skipped with a warning in the server
log, and the rest of the folder keeps listing.

## The manifest, `template.json`

```json
{
  "name": "Article",
  "description": "A clean article with biblatex — the right default for most papers.",
  "icon": "📄",
  "order": 1,
  "category": "General",
  "license": "MIT",
  "licenseUrl": "https://opensource.org/license/mit",
  "source": {
    "url": "https://github.com/trahloff/Aldine/tree/main/templates/article",
    "version": "0.3.0"
  }
}
```

| Field | Meaning |
|---|---|
| `name` | Tile title. Defaults to the folder name |
| `description` | One sentence under the title |
| `icon` | An emoji for the tile |
| `order` | Sort key within its group (ascending, then by name; unset sorts last) |
| `category` | One of `Journals`, `Conferences`, `Theses`, `Slides`, `General` (the default). Shipped templates are grouped by it; templates from a repository are grouped under the repository's label instead |
| `license`, `licenseUrl` | What the files in the folder are licensed as, and where that text lives. Shown on the tile; without them the tile shows no licence badge |
| `source` | `{ "url", "version" }`: where the files came from upstream and which version this copy is. The API exposes it as `origin`, because `source` in the API says where a template is *listed from* (`builtin`, `repo`, `venue`, `kit`) |

An `id` field in the manifest is ignored: the folder name is the id. A shipped
template is `article`; the same folder in a repository listed as `lab` is
`repo:lab/article`.

`npm run templates:check` validates the shipped folders in CI (name, licence,
`licenseUrl`, `source`, a `LICENSE` file, at least one `.tex`). It takes a
directory argument, so it checks your own folder too:

```bash
npm run templates:check -- /path/to/your/templates
```

The check is stricter than the server: a private repository may leave
`license` and `source` out and still lists fine, and the check also flags a
directory without a `template.json`, which the server just skips. Point it at
a directory that holds only template folders.

## Placeholders

Any text file in a template may contain these tokens; they are replaced when a
project is created, whatever the template's source (shipped, repository,
venue class, publisher kit):

| Token | Value |
|---|---|
| `{{PROJECT_NAME}}` | The name given in the new-project dialog |
| `{{AUTHOR}}` | The display name of the signed-in user; empty in a single-tenant deploy |
| `{{DATE}}` | Today, `YYYY-MM-DD` |
| `{{YEAR}}` | Today's year |

Rules:

- Text files only (`.tex`, `.bib`, `.cls`, `.sty`, `.md`, `.txt`, `.json`,
  `.yml`, … and extension-less files). Binaries (`.pdf`, `.png`, `.jpg`,
  fonts) are copied byte for byte.
- In `.tex`, `.sty` and `.cls` files the value is LaTeX-escaped (`&` becomes
  `\&`, `_` becomes `\_`, and so on), so a project called `R&D_2026` typesets.
  Everywhere else it is inserted verbatim.
- Unknown tokens such as `{{FOO}}` are left untouched, so a template that uses
  Mustache or Jinja for its own purposes is not broken.

```latex
\title{{{PROJECT_NAME}}}
\author{{{AUTHOR}}}
\date{{{DATE}}}
```

## Your own template repository

Put the layout above in any git repository — GitHub, GitLab (cloud or
self-hosted), Gitea, Codeberg, a bare repository behind https — and list it
in `TEMPLATE_REPOS`. Aldine clones each repository shallowly into
`CACHE_DIR/template-repos/<id>` at boot, refreshes it on an interval, and lists
its templates under the repository's label. Projects created from them are
copies: the template repository is not the project's git remote, and a later
change to the template does not touch existing projects.

`TEMPLATE_REPOS` is a JSON array, either inline in the environment or in a
file named by `TEMPLATE_REPOS_FILE` (handy when the JSON quoting fights your
shell or compose file). It is read once at boot; an entry that fails
validation is logged as `[templates] TEMPLATE_REPOS entry skipped: …` and the
others still load.

```json
[
  {
    "id": "lab",
    "label": "Lab templates",
    "url": "https://gitlab.example.org/latex/templates.git",
    "ref": "main",
    "path": "templates",
    "tokenEnv": "TEMPLATE_REPO_LAB_TOKEN",
    "user": "oauth2"
  }
]
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `^[a-z0-9][a-z0-9-]{0,30}$`, unique across the list. Template ids become `repo:<id>/<folder>` and the checkout lives in `CACHE_DIR/template-repos/<id>` |
| `label` | no | Heading the templates are grouped under in the gallery; search matches it too. Defaults to `id` |
| `url` | yes | Clone URL, `https://` only. No credentials in the URL; use `tokenEnv` |
| `ref` | no | Branch or tag to track. Default `HEAD`, the remote's default branch |
| `path` | no | Directory inside the repository that holds the template folders. Default: the repository root |
| `tokenEnv` | no | Name of an environment variable holding a read token, for a private repository. The variable name is yours to choose; set it next to `TEMPLATE_REPOS` |
| `user` | no | Basic-auth user the host expects with that token: `oauth2` (GitLab, the default), `x-access-token` (GitHub); other hosts document theirs under "clone with a token" |

### Private repositories

Create a read-only token (GitLab: a project or group access token with the
`read_repository` scope; GitHub: a fine-grained token with *Contents: read* on
that repository), put it in the environment variable `tokenEnv` names, and set
`user` to what the host expects. The token is injected into the URL for one
git operation at a time and never written to the checkout's `.git/config`;
the checkout's `origin` stays credential-free, and the token appears in no
config file, log line or API response. That matters because `CACHE_DIR` is
readable by the compiler container in some deployments.

### Refresh

Every repository is fetched again every `TEMPLATE_REPOS_REFRESH_MS`
milliseconds (default `600000`, ten minutes; values below `60000` are raised
to one minute). Signed-in users (anyone, when auth is off) can also press
**Refresh templates** in the new-project dialog, which fetches every
repository and re-lists the gallery; the button appears as soon as one
repository is configured. Operators get the same from
`POST /api/templates/repos/refresh`, and `GET /api/templates/repos` reports
each repository's state (`ok`, `available`, `head`, `syncedAt`, `error`).
Neither needs a restart: push a new folder, refresh, and the tile is there.

### Stale, and other failure modes

A refresh that fails (host down, token revoked, branch deleted) keeps the
previous checkout: its templates stay in the gallery and projects can still be
created from them. The repository is **stale**, the gallery heading says
"last updated <when>, refresh failed", and the log names the cause once per
failure streak rather than once per interval. The next successful refresh
clears it. A repository that has never been cloned successfully lists nothing
and shows nothing in the gallery; `GET /api/templates/repos` carries the
error.

A checkout larger than `TEMPLATE_REPO_MAX_BYTES` (default `52428800`, 50 MiB)
is deleted and reported as an error rather than served, so a repository that
starts collecting build artefacts cannot fill the cache. Keep templates small:
a `.tex`, a `.bib`, a class file, a logo.
