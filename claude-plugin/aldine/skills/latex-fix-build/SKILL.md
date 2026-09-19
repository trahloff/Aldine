---
name: latex-fix-build
description: Repair a LaTeX build in an Aldine project — compile, read the parsed errors, fix the failing line with a quote-anchored edit, recompile, at most 3 attempts. Use only when the paper lives in an Aldine project (the user names an Aldine project or instance, or the aldine MCP server is connected and the file is not on local disk) and the user asks to fix, debug or "make it compile", a compile result has errors, or the PDF is missing after an edit. For a local LaTeX checkout do not use this skill. Do not use for drafting new text (latex-draft-section) or for citations (latex-bibliography).
---

# Fix a LaTeX build

Tools come from the plugin's `aldine` server — they appear as
`mcp__plugin_aldine_aldine__<tool>` (or `mcp__aldine__<tool>` if you added the
server yourself with `claude mcp add`). Every project
tool takes `project` (from `list_projects`; optional for a single-project token)
and `branch` (default `main`).

## Only for Aldine projects

If the user's files are local — a path on disk, a `.tex` in the working
directory, a git checkout in cwd — stop: this skill is for papers that live
in an Aldine project. Say so and work on the local files with the usual
tools instead. Do not `compile` whatever `list_projects` happens to return.

## The loop

1. `compile` with `{project, branch}`. Read the result before touching anything:
   - `ok:true` — done. Hand the user `pdfUrl` (15-minute signed link) and `deepLink`.
   - `errors[]` — rows of `{type, file, line, message, context, source}`,
     `type:"error"` rows first. `context` is the source line the engine was
     reading; `hint` names a cause the document cannot fix (below).
   - `errorsTotal` and `warningsTotal` count everything even when the list is capped.
   - `ok:false` with `errors[]` empty or no `type:"error"` row — read `logTail`
     (up to 4 KB around the first failure). Quote the line that names the
     failure and treat it as the first error. If `logTail` names no file and
     line either, relay it and stop.
2. Take the FIRST `type:"error"` row only. Later errors are usually knock-on effects.
3. `read_file` `{project, branch, path: <row.file>, from_line: max(1, line-5), to_line: line+5}`
   — `to_line` is clamped to the last line by the server, `from_line` is not
   and must be at least 1. If `line` is null, read the whole file (or
   `from_line: 1, to_line: 60` for a preamble error) and find `context` by
   searching. Confirm `context` is really at that line; keep `contentVersion`
   from the result.
4. `edit_file` `{project, branch, path, edits: [{quote, replacement}], base_version, message}`
   - `quote` is the failing line (or enough of it — at least 8 characters,
     copied verbatim from the read) so it matches once.
   - `message` names the fix, imperative: "Close the unbalanced brace in eq. 3".
5. `compile` again. Narrate: "attempt 2 of 3: escaped the stray % in the caption".
6. After 3 failed attempts stop. Relay the remaining first error as `file:line`,
   its `message` and `context`, and what you changed. Do not start a fourth.

## Errors that are not the document's fault — relay, do not edit

| What you see | What it means | Do |
|---|---|---|
| `hint` mentioning a package not installed | The compiler's TeX Live lacks that `.sty`. | Tell the user (docker compiler image or a fuller TeX Live fixes it). Never delete the `\usepackage`. |
| `hint` about a character pdflatex cannot typeset (`Unicode character … (U+…)`) | Not a syntax error. If it is in a `.bib` entry the row points at the line that prints the bibliography, not the entry. | Search the `.bib` files for the character and replace it there with the TeX escape (`{\"o}`, `--`), or replace it in the `.tex`. Switching to xelatex/lualatex is the user's call — ask. |
| Row with `source:"biber"` or `source:"bibtex"` | The row names the `.bib` file and its line, never the `.tex`. | Fix the entry in that `.bib` (a missing comma, an unbalanced brace, a bad field). A `\cite` of an unknown key is a warning: check `list_citations` before adding a key. |
| "This project has no .tex file to typeset" / "The main document … does not exist on <branch>" | Rootless project or the root is on another branch. | Ask which file is the main document; `write_file` of the first `.tex` makes it the root (`newRoot`). Do not invent a main.tex over a project you have not read. |
| "The compiler cannot see this project's files" | Compiler `DATA_DIR` mismatch on the server. | Relay verbatim. Do not edit, rename or recreate files. |
| "Typesetting failed to start", "An agent typeset is already running", quota or budget messages | Infrastructure or limits. | Relay; wait or stop. No retry loop. |
| `pdfStale:true` with `ok:false` | This run wrote no PDF; `pdfUrl` is the previous one or null. | Say so when you hand over a link. |

## Edit errors and what to do

- `{error:"stale_anchor", candidates}` — the quote is not in the file (someone
  typed, or you paraphrased). Re-read the lines around `candidates[].line`,
  copy the current text, retry. At most 2 retries, then ask.
- `{error:"ambiguous_anchor", candidates}` — resend the same edit with the
  `occurrence` from the candidate you mean. No re-read needed.
- `{error:"version_conflict", reason}` — the file changed after your read.
  Re-read, take the new `contentVersion` as `base_version`, apply once.
- Plain text "Edit 1: the quote must be at least 8 characters" — quote more.

## Do not

- Do not `write_file` an existing file to fix one line: it discards a
  collaborator's in-flight typing and produces an unreviewable diff. `edit_file` only.
- Do not fix several unrelated errors in one attempt; one cause per compile.
- Do not comment out the failing line to make the build pass — fix the cause
  or report it.
- Do not add `\usepackage` lines, change the engine or the document class
  without saying so in the answer.
- Do not compile "just to check": compile after a coherent change.
- Do not touch anything outside the project: no local files, no other
  projects, no branch you were not given.

## Reporting

One paragraph: what failed (`file:line`, message), what you changed (commit
hash from the edit result), the final `compile` state, `pdfUrl` and
`deepLink`. Warnings that remain (`warningsTotal`) are worth one sentence,
not a fix loop, unless the user asked for a clean log.
