---
name: latex-bibliography
description: Add and cite references in an Aldine LaTeX project — resolve a DOI, arXiv or OpenAlex id to BibTeX with references_add, check list_citations first so nothing is duplicated, insert the \cite with a quote-anchored edit, and tell biber apart from bibtex. Use only when the paper lives in an Aldine project (the user names an Aldine project or instance, or the aldine MCP server is connected and the file is not on local disk) and the user asks to add a reference, cite a paper, fix a bibliography or an "undefined citation" warning. For a local LaTeX checkout do not use this skill. Do not use for prose drafting (latex-draft-section) or general build errors (latex-fix-build).
---

# References and citations

Tools come from the plugin's `aldine` server — they appear as
`mcp__plugin_aldine_aldine__<tool>` (or `mcp__aldine__<tool>` if you added the
server yourself with `claude mcp add`). Every project
tool takes `project` and `branch` (default `main`).

## Only for Aldine projects

If the user's files are local — a path on disk, a `.tex` in the working
directory, a git checkout in cwd — stop: this skill is for papers that live
in an Aldine project. Say so and work on the local files with the usual
tools instead. Do not `compile` whatever `list_projects` happens to return.

## Add a reference

1. `list_citations` `{project, branch}` → `citations[{key, title, author, year, file}]`.
   Look for the paper by title, first author and year. If it is there, use
   that `key` and skip the lookup — a second entry for the same paper is a
   duplicate the user has to clean up.
2. `references_add` `{project, branch, query, bibFile?}`
   - `query` is an identifier: a DOI (`10.1038/nature14539`), a `doi.org` URL,
     an arXiv id (`2301.12345` or `arXiv:2301.12345`) or an OpenAlex id (`W…`).
     A title is not a lookup: for a paper you only know by name, ask the user
     for its DOI or arXiv id — do not guess an identifier.
   - `bibFile` defaults to `references.bib` beside the root file; pass the
     project's actual `.bib` (from `list_citations[].file` or
     `project_structure`) when it has one under another name. A missing file
     is created, folders included (`created:true`).
   - Result: `{key, bibFile, duplicate, created, note?}`. Keys are
     `surname2021`; `duplicate:true` means the entry was already there and
     nothing was appended — cite the returned key.
   - `note` present: no `.tex` on the branch loads that `.bib`, so the citation
     stays undefined until the preamble has `\addbibresource{…}` (biblatex) or
     the file is in `\bibliography{…}` (bibtex). Say so, and only add that line
     when the user agrees — it changes the bibliography setup.
3. Insert the citation with `edit_file`
   `{project, branch, path, edits: [{quote, replacement}], base_version, message}`
   after a `read_file` of the paragraph: `quote` is the sentence end the
   citation attaches to (verbatim, at least 8 characters, matching once),
   `replacement` the same text with `~\cite{key}` before the full stop.
   `message`: "Cite Vaswani et al. for attention". Use the paper's citation
   command (`\citep`, `\autocite`, `\parencite`) when the preamble or the
   neighbouring text uses one.

## Lookup outcomes

| Result | Meaning | Do |
|---|---|---|
| `No reference found for "…"` | The id is well-formed but the upstream does not know it (or it is a title). | Check the id with the user; do not retry the same query. |
| `Reference lookup failed: <service> lookup failed (HTTP nnn)` | The upstream (doi.org, arXiv, OpenAlex) answered with an error other than not-found. | Relay the status. 5xx: try once more later if asked. 429: wait, one query at a time. Another 4xx: the id is malformed for that service — check it with the user. |
| `The reference service … could not be reached from your Aldine server` | Network from the server. | Relay; the server operator fixes it. |
| `Reference lookup budget reached` | Rate limit on lookups. | Wait a few seconds; one query at a time. |
| `bibFile must be a .bib file` | Wrong target path. | Pass a `.bib` path. |

## biber or bibtex

Decide from the sources, not from habit:

- `\usepackage[…]{biblatex}` + `\addbibresource{refs.bib}` + `\printbibliography`
  → biblatex with biber. Extension included in `\addbibresource`.
- `\bibliographystyle{…}` + `\bibliography{refs}` → bibtex (or natbib on top).
  No extension in `\bibliography`.
- `compile` rows carry `source:"biber"` or `source:"bibtex"` and name the
  `.bib` file and its line — the fix is in that entry, not in the `.tex`.
- `engine` from `project_structure`/`list_projects` is the TeX engine
  (pdflatex, xelatex, lualatex), not the bibliography backend.

Do not mix the two: adding `\addbibresource` to a natbib paper, or
`\bibliography` to a biblatex one, breaks the build.

## Undefined citation or bibliography errors

- A `compile` warning "Citation 'x' undefined": `list_citations` — the key is
  misspelt, or the entry is missing (add it with `references_add`), or the
  `.bib` is not loaded (see `note` above).
- A `Unicode character … (U+…)` `hint` on a pdflatex project after adding a
  reference: the character is in the `.bib` entry; the row names the `.tex`
  line that prints the bibliography. `read_file` the `.bib`, replace the
  character with its TeX escape via `edit_file`.
- With errors present the PDF is built but the bibliography and cross
  references are not refreshed — say so when handing over `pdfUrl`.

## Do not

- Do not write BibTeX by hand from memory when an identifier exists;
  `references_add` fetches the record.
- Do not `write_file` the `.bib` to add or fix one entry — `edit_file`, or
  `references_add`.
- Do not invent a key, a DOI or an arXiv id. Not found means ask.
- Do not remove entries the user did not ask about, even if they look unused.
