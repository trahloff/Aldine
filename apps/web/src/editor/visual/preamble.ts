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

/** A macro the preamble defines: its body, with `#1`…`#n` for its arguments. */
export interface MacroDef { def: string; args: number }

/** The document's math macros by name (without the backslash), plus a key that changes when they do. */
export interface MacroSet { defs: Record<string, MacroDef>; key: string }

export const NO_MACROS: MacroSet = { defs: {}, key: '' };

/** The balanced `{…}` group starting at `i` (which holds `{`): its interior and the index after it. */
function group(text: string, i: number): { body: string; end: number } | null {
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { body: text.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * The macros a formula may use from the preamble: \newcommand,
 * \renewcommand and \providecommand without an optional argument (with up
 * to nine plain arguments), and \DeclareMathOperator. Anything else is left
 * out, and a formula using it keeps opening as source.
 */
export function preambleMacros(preamble: string | null): MacroSet {
  if (!preamble) return NO_MACROS;
  const defs: Record<string, MacroDef> = {};
  const re = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator)(\*?)/g;
  for (let m = re.exec(preamble); m; m = re.exec(preamble)) {
    let i = skipSpace(preamble, m.index + m[0].length);
    let name: string | null = null;
    if (preamble[i] === '{') {
      const g = group(preamble, i);
      const n = g && /^\s*\\([A-Za-z]+)\s*$/.exec(g.body);
      if (!g || !n) continue;
      name = n[1];
      i = g.end;
    } else {
      const n = /^\\([A-Za-z]+)/.exec(preamble.slice(i));
      if (!n) continue;
      name = n[1];
      i += n[0].length;
    }
    i = skipSpace(preamble, i);
    let args = 0;
    if (m[1] !== 'DeclareMathOperator') {
      const a = /^\[\s*([0-9])\s*\]/.exec(preamble.slice(i));
      if (a) {
        args = Number(a[1]);
        i = skipSpace(preamble, i + a[0].length);
      }
      if (preamble[i] === '[') continue; // an optional argument with a default
    }
    const body = group(preamble, i);
    if (!body) continue;
    re.lastIndex = body.end;
    // a body that names an argument it does not take is not a definition TeX accepts
    if ([...body.body.matchAll(/#([0-9])/g)].some((x) => Number(x[1]) < 1 || Number(x[1]) > args)) continue;
    const def = m[1] === 'DeclareMathOperator' ? `\\operatorname${m[2]}{${body.body}}` : body.body;
    if (m[1] === 'providecommand' && defs[name]) continue;
    defs[name] = { def, args };
  }
  const names = Object.keys(defs).sort();
  return names.length ? { defs, key: names.map((n) => `${n}/${defs[n].args}/${defs[n].def}`).join('\n') } : NO_MACROS;
}
