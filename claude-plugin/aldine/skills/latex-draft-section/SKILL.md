---
name: latex-draft-section
description: Draft a new section, subsection or appendix into an existing LaTeX paper in an Aldine project — read the paper first, reuse its labels, citation keys and macros, write the section into its own file wired in with \input, compile once, report the commit and the deep link. Use only when the paper lives in an Aldine project (the user names an Aldine project or instance, or the aldine MCP server is connected and the file is not on local disk) and the user asks to write, draft or add a section, related work, discussion, appendix or similar prose. For a local LaTeX checkout do not use this skill. Do not use for fixing a broken build (latex-fix-build) or adding references (latex-bibliography).
---

# Draft a section into an existing paper

Tools come from the plugin's `aldine` server — they appear as
`mcp__plugin_aldine_aldine__<tool>` (or `mcp__aldine__<tool>` if you added the
server yourself with `claude mcp add`). Every project
tool takes `project` and `branch` (default `main`).

## Only for Aldine projects

If the user's files are local — a path on disk, a `.tex` in the working
directory, a git checkout in cwd — stop: this skill is for papers that live
in an Aldine project. Say so and work on the local files with the usual
tools instead. Do not `compile` whatever `list_projects` happens to return.

## Read before you write

1. `project_structure` `{project, branch}` — the file tree, `rootFile`,
   `engine` and `contentVersion`. Note how the paper is split: one file, or
   `sections/*.tex` pulled in with `\input`/`\include`.
2. `read_file` `{project, branch, path: <rootFile>}` — the preamble (packages,
   custom macros, `\newcommand`s, theorem environments, the bibliography
   setup) and the order of the existing `\input` lines. Read the neighbouring
   section too, so the new one matches its voice, tense and heading depth.
3. `list_labels` `{project, branch}` — every `\label` you may `\ref`, `\eqref`
   or `\cref`. Never write a reference to a label that is not in this list.
4. `list_citations` `{project, branch}` — every key you may `\cite`. A source
   the paper needs but does not have goes through `latex-bibliography`
   (`references_add`), or you ask the user; never invent a key.
5. `wordcount` if the user gave a length target — it counts the source of the
   root file and everything it `\input`/`\include`s, commands and comments
   stripped; no compile is needed, and it is not the PDF's word count.

## Write

Put the section in its own file and wire it in with one `batch_write`, so the
change is one reviewable commit:

```
batch_write {
  project, branch,
  files: [
    { path: "sections/related-work.tex", content: "<the section>",
      base_version: <contentVersion from project_structure> },
    { path: "<rootFile>", base_version: <contentVersion from read_file>,
      edits: [{ quote: "\\input{sections/method}",
                replacement: "\\input{sections/method}\n\\input{sections/related-work}" }] }
  ],
  message: "Add related-work section"
}
```

- The `quote` is the existing `\input` line the new one should follow, copied
  verbatim (at least 8 characters, matching once — add `occurrence` if the
  result says `ambiguous_anchor`).
- Follow the project's existing folder and file naming (`sections/`,
  `chapters/`, `sec_` prefixes) — do not introduce a second convention.
- For a one-file paper with no `\input`s, ask whether to split it before
  creating a folder; otherwise `edit_file` the section in place, anchored on
  the heading it should precede or follow.
- `base_version` on each entry: a `version_conflict` on any entry writes
  nothing — re-read that file and resend the batch.

## House rules for the text

- No new `\usepackage` unless the section cannot be written without it, and
  then say so in the answer. Use what the preamble already loads.
- Use the author's macros (`\method`, `\eg`, theorem environments) instead of
  spelling out what they abbreviate.
- Headings in sentence case unless the existing headings are title case.
- `\label{sec:related-work}` on the new heading, following the paper's label
  prefix style; `\ref`/`\cref` only to labels from `list_labels`.
- `\cite` only keys from `list_citations`. Mark a claim that needs a source
  you could not find as `% TODO cite: <what>` rather than inventing one.
- Plain ASCII in the source under pdflatex (`engine` from `project_structure`):
  `--`, `\"o`, `\%`, `\&` — a stray Unicode character halts the build.
- No commentary inside the `.tex` about what you did; the commit message
  carries that.

## Compile once, then report

`compile` `{project, branch}` after the batch. If `ok:true`, report:

- the commit hash (`commit` in the `batch_write` result) and its message,
- the new file's path and the line you added to the root file,
- `deepLink` (opens the project in Aldine; the Review toast there shows the diff) and
  `pdfUrl` (15-minute signed link),
- what you deliberately left open (`% TODO cite` marks, a figure you did not add).

If `compile` returns errors introduced by the section, switch to the
`latex-fix-build` loop (at most 3 attempts). Errors that were already present
before your change are reported, not fixed, unless the user asks.

## Do not

- Do not `write_file` over the root file or an existing section to add text —
  it discards what a collaborator is typing and makes the diff unreviewable.
- Do not restructure, renumber or rewrite existing sections "while you are there".
- Do not run `compile` between drafting and wiring in — one compile after the batch.
- Do not use `trash_project`, `create_project` or another branch as part of drafting.
