/**
 * What the document's preamble provides, read from its source. Only what
 * is written there counts: a package a class loads on its own is unknown,
 * so callers treat anything not found as missing.
 */

/** Drop %-comments (an escaped \% stays), so commented-out lines never count. */
function stripComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gm, '$1');
}

/** The source before \begin{document}, or null when the text has none (a file \input by another). */
export function preambleOf(text: string): string | null {
  const code = stripComments(text);
  const m = /\\begin\s*\{document\}/.exec(code);
  return m ? code.slice(0, m.index) : null;
}

/** Every package the preamble loads with \usepackage or \RequirePackage. */
export function loadedPackages(preamble: string): Set<string> {
  const out = new Set<string>();
  const re = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  for (let m = re.exec(preamble); m; m = re.exec(preamble)) {
    for (const name of m[1].split(',')) if (name.trim()) out.add(name.trim());
  }
  return out;
}

/** Packages that define \url (biblatex loads url itself). */
const URL_PACKAGES = ['url', 'xurl', 'hyperref', 'biblatex'];

export function definesUrl(preamble: string | null): boolean {
  if (!preamble) return false;
  const pkgs = loadedPackages(preamble);
  return URL_PACKAGES.some((p) => pkgs.has(p));
}
