# Evals

`claude plugin eval` is early access; these cases are written for it but the
plugin does not depend on the runner. Each case is `<case>/prompt.md` (the
user turn, with `allowed_tools` in the frontmatter) plus `<case>/graders/`.

## Prerequisites

- An Aldine that serves the Agent API (`ALDINE_MCP=1`; the release after
  0.9.0 or a build from `main`), reachable from the machine that runs the eval.
- `ALDINE_URL` exported, and `ALDINE_TOKEN` set to a credential that reaches
  the fixture project (the instance's `ALDINE_MCP_TOKEN`, or an `aldn_…`
  personal access token) — the runner has no browser for the Connect flow.
- Tool names: the plugin's server registers as `plugin:aldine:aldine`, so
  its tools are `mcp__plugin_aldine_aldine__<tool>`. The `mcp__aldine__*`
  names in `allowed_tools` cover a server added by hand with `claude mcp add`.

## fix-build

Fixture: a project named `thesis-2026` on branch `main`, seeded from
`templates/article`, split so the method section lives in
`sections/method.tex`, with one unbalanced brace in that file (an
`\emph{` without its closing brace on a line of prose). Everything else
must compile, so the first `type:"error"` row points at that line.

Seed and reset it through the same MCP server the eval uses (any client:
`claude mcp add` the instance, or `curl` against `POST $ALDINE_URL/mcp`):

1. `create_project {name: "thesis-2026", template: "article"}` — once.
2. `write_file` `main.tex` with the template's preamble and
   `\input{sections/method}` in the body; `write_file`
   `sections/method.tex` with a paragraph containing `\emph{unbalanced`.
3. Before each run: `write_file` `sections/method.tex` with the broken
   content again (the run's fix is a commit on `main`; overwriting restores
   the breakage as a new commit, which is fine for the fixture).

A run that answers `No project "thesis-2026" is reachable` is a fixture
problem, not a skill failure.

`allowed_tools` includes `write_file` on purpose: criteria.md fails a run
that fixes one line with `write_file`, and the criterion is only meaningful
when the tool is available.
