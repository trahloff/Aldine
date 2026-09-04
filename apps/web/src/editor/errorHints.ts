/** Plain-English hints for the most common LaTeX errors. */

const HINTS: Array<{ re: RegExp; hint: string }> = [
  { re: /Undefined control sequence/i, hint: 'A command isn’t defined — check its spelling, or add the \\usepackage that provides it.' },
  { re: /Missing \$ inserted/i, hint: 'Math content outside math mode — wrap symbols like _ ^ \\alpha in $…$.' },
  { re: /File `?([^']+?)\.sty'? not found/i, hint: 'The package “$1” isn’t in this server’s TeX Live image (or is misspelled in \\usepackage). Self-hosting? Set ALDINE_TEXLIVE=-full and pull again to get all of TeX Live (ALDINE_TEXLIVE_SCHEME=full when building from source).' },
  { re: /File `?([^']+?)\.cls'? not found/i, hint: 'The document class “$1” isn’t in this server’s TeX Live image — upload the .cls into the project, or set ALDINE_TEXLIVE=-full and pull again to get all of TeX Live.' },
  { re: /File `?([^']+?)'? not found/i, hint: 'The file isn’t in the project — check the path in \\input, \\include, or \\includegraphics.' },
  { re: /Environment .* undefined/i, hint: 'The \\begin{…} environment isn’t defined — load the package that provides it.' },
  { re: /\\begin\{.*\} on input line .* ended by \\end\{.*\}/i, hint: 'Mismatched \\begin/\\end pair — every \\begin{x} must close with \\end{x}.' },
  { re: /Missing \\begin\{document\}/i, hint: 'Content appears before \\begin{document} — move text after it (or a stray character sits in the preamble).' },
  { re: /Runaway argument/i, hint: 'An argument never closed — look for a missing closing brace }.' },
  { re: /Extra \}, or forgotten/i, hint: 'Brace mismatch — an extra } or a missing { earlier in the line.' },
  { re: /Citation .* undefined|Empty bibliography/i, hint: 'The citation key isn’t in your .bib — check the key, or sync your bibliography.' },
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
