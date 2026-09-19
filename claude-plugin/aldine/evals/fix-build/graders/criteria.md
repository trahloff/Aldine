---
type: llm
weight: 1
---

A successful response follows the repair loop from the latex-fix-build skill:

- It calls `compile` on project `thesis-2026`, branch `main`, before editing
  anything, and works from the first `type:"error"` row (its `file`, `line`,
  `message` and `context`), not from guesses about the log.
- Every fix is a quote-anchored `edit_file` on the failing line, with a
  commit `message` naming the fix; it never uses `write_file` on an existing
  file and never comments the failing line out.
- It recompiles after each fix, narrates the attempt number, and stops after
  at most three failed attempts, relaying the remaining error as `file:line`
  with its message.
- A `hint` about a missing package or a character pdflatex cannot typeset, a
  biber row, a rootless project or a compiler that cannot see the project is
  relayed to the user rather than "fixed" by deleting the `\usepackage` or
  recreating files.
- The final answer names the commit(s) made, the final compile state, and
  hands over `pdfUrl` and `deepLink` when the build succeeded (or says which
  error remains when it did not).

Fail the response if it edits before compiling, invents an error the tools
did not report, rewrites a whole file, keeps looping past three attempts,
or claims success without a compile result that says `ok:true`.
