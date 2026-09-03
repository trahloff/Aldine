# Templates

Starting points offered in Aldine's **New project** dialog. Templates come from
two places, and both are optional and additive:

| Source | Set | Good for |
| --- | --- | --- |
| A directory | `TEMPLATES_DIR` (defaults to this one) | templates that ship with the deployment |
| A GitLab group | `GITLAB_TEMPLATE_GROUP` | templates a group maintains, with merge requests |

## A template in a directory

One subdirectory per template. Any folder holding a `.tex` file counts:

```
templates/
  thesis/
    main.tex
    chapters/intro.tex
    logo.png
    template.json     ← optional
```

`template.json` only controls how the tile looks. Without it, the tile is named
after the folder.

```json
{
  "name": "Report / Thesis",
  "description": "Chapters, table of contents, and a bibliography.",
  "icon": "📚",
  "order": 4
}
```

`order` sorts the grid (lower first; unordered templates come last,
alphabetically). Binary files — logos, bundled PDFs — are copied byte-for-byte.

To use your own templates instead of the ones Aldine ships, point
`TEMPLATES_DIR` at your directory. In docker compose, mount it and set the
variable — see the commented volume in `docker-compose.full.yml`.

## A template in GitLab

Set `GITLAB_TEMPLATE_GROUP` to a group's full path (subgroups included). Every
project in it becomes a template, cloned to seed the new project. The tile takes
its name and description from the GitLab project; commit a `template.json` at
the repo root to override them or add an icon and order.

The dialog re-reads the group each time it opens, so a template pushed to the
group is available immediately (within `GITLAB_TEMPLATE_TTL_MS`, default 60s).

Templates are **copied, not linked**: the new project's git history starts with
its own initial commit and the template repo is not one of its remotes. Editing
a template never touches projects already made from it.

## Placeholders

Text files may use these, filled in when the project is created:

| Token | Becomes |
| --- | --- |
| `{{PROJECT_NAME}}` | the name typed in the dialog |
| `{{AUTHOR}}` | the signed-in user's name (empty when auth is off) |
| `{{DATE}}` | today, as `YYYY-MM-DD` |
| `{{YEAR}}` | the current year |

```latex
\title{{{PROJECT_NAME}}}
\author{{{AUTHOR}}}
\date{{{DATE}}}
```

Anything else in braces is left exactly as written, so ordinary LaTeX is safe.
Binary files are never substituted into.

## Licensing

A template you add is your own work under your own terms. The ones shipped here
are part of Aldine (AGPL-3.0), except `iac-paper/iac.cls`, which is LPPL-1.3c —
see the licence note in the repository README.
