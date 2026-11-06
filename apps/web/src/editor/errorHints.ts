/** Plain-English hints for the most common LaTeX errors. */

/** pdfLaTeX's error for a character its input encoding cannot typeset (a Greek letter, ≤). */
const UNICODE_CHAR = /Unicode character (\S+) \(U\+[0-9A-F]+\)/i;

const HINTS: Array<{ re: RegExp; hint: string }> = [
  { re: UNICODE_CHAR, hint: 'pdfLaTeX can’t typeset “$1”. Typeset with XeLaTeX and a font that has it, or write it as a LaTeX command (pasting in Visual mode does this for you).' },
  { re: /Missing character: There is no (\S+) /, hint: 'The font has no “$1”, so the PDF leaves it out. Choose a font that has it with \\setmainfont (fontspec), or write it as a LaTeX command.' },
  { re: /Undefined control sequence/i, hint: 'A command isn’t defined — check its spelling, or add the \\usepackage that provides it.' },
  { re: /Missing \$ inserted/i, hint: 'Math content outside math mode — wrap symbols like _ ^ \\alpha in $…$.' },
  { re: /File `?([^']+?)\.sty'? not found/i, hint: 'The package “$1” isn’t in this server’s TeX Live image (or is misspelled in \\usepackage). Self-hosting? Add “RUN tlmgr install $1” to a derived compiler image (README: “Need a package it does not have?”), or set ALDINE_TEXLIVE=-full and pull again to get all of TeX Live.' },
  { re: /File `?([^']+?)\.cls'? not found/i, hint: 'The document class “$1” isn’t in this server’s TeX Live image — upload the .cls into the project, add “RUN tlmgr install $1” to a derived compiler image (README: “Need a package it does not have?”), or set ALDINE_TEXLIVE=-full and pull again to get all of TeX Live.' },
  { re: /File `?([^']+?)'? not found/i, hint: 'The file isn’t in the project — check the path in \\input, \\include, or \\includegraphics.' },
  { re: /Environment .* undefined/i, hint: 'The \\begin{…} environment isn’t defined — load the package that provides it.' },
  { re: /\\begin\{.*\} on input line .* ended by \\end\{.*\}/i, hint: 'Mismatched \\begin/\\end pair — every \\begin{x} must close with \\end{x}.' },
  { re: /Missing \\begin\{document\}/i, hint: 'Content appears before \\begin{document} — move text after it (or a stray character sits in the preamble).' },
  { re: /Runaway argument/i, hint: 'An argument never closed — look for a missing closing brace }.' },
  { re: /Extra \}, or forgotten/i, hint: 'Brace mismatch — an extra } or a missing { earlier in the line.' },
  { re: /Citation .* undefined|Empty bibliography/i, hint: 'The citation key isn’t in a .bib the document loads — check the key, and that \\addbibresource or \\bibliography names its .bib.' },
  { re: /Reference .* undefined/i, hint: 'No matching \\label — typeset twice or fix the label name.' },
  { re: /Overfull \\hbox/i, hint: 'A line is too wide — often a long word or URL; consider \\sloppy or breaking it manually.' },
  { re: /Package biblatex Error: Please \(re\)run Biber/i, hint: 'The bibliography needs another pass — typeset again.' },
  { re: /Paragraph ended before .* was complete/i, hint: 'A command argument spans a blank line — remove the blank line or close the argument.' },
  { re: /Emergency stop/i, hint: 'TeX gave up — fix the first error above; the rest usually follow from it.' },
];

export function hintFor(message: string): string | null {
  for (const { re, hint } of HINTS) {
    const m = re.exec(message);
    if (m) return hint.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '');
  }
  return null;
}

/** Whether the error is one another engine fixes: pdfLaTeX stopping at a Unicode character. */
export function offersUnicodeEngine(message: string): boolean {
  return UNICODE_CHAR.test(message);
}
