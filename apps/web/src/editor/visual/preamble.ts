/**
 * What the document's preamble provides, read from its source. Only what
 * is written there counts: a package a class loads on its own is unknown,
 * so callers treat anything not found as missing.
 */

/** Drop %-comments (an escaped \% stays), so commented-out lines never count. */
export function stripComments(text: string): string {
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

/** A command name written `\name` or `{\name}` at `i`: the name and the index after it. */
function commandName(text: string, i: number): { name: string; end: number } | null {
  if (text[i] === '{') {
    const g = group(text, i);
    const n = g && /^\s*\\([A-Za-z]+)\s*$/.exec(g.body);
    return g && n ? { name: n[1], end: g.end } : null;
  }
  const n = /^\\([A-Za-z]+)/.exec(text.slice(i));
  return n ? { name: n[1], end: i + n[0].length } : null;
}

/**
 * Bodies a formula renderer cannot expand: package internals (`@`), TeX's
 * conditionals and definitions made inside a definition.
 */
const NOT_MATH = /@|\\(?:(?!iff(?![A-Za-z]))if[a-zA-Z]*|fi|else|or|expandafter|csname|endcsname|noexpand|futurelet|afterassignment|catcode|global|g?def|edef|xdef|let|(?:re)?newcommand|providecommand)(?![A-Za-z])/;

/**
 * The macros a formula may use from the preamble: \newcommand,
 * \renewcommand and \providecommand without an optional argument (with up
 * to nine plain arguments), \DeclareMathOperator, \DeclarePairedDelimiter,
 * \def and \gdef with plain `#1#2` parameters, and \let to another command.
 * Anything else is left out, and a formula using it keeps opening as source.
 */
export function preambleMacros(preamble: string | null): MacroSet {
  if (!preamble) return NO_MACROS;
  const defs: Record<string, MacroDef> = {};
  const re = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|DeclarePairedDelimiter|g?def|let)(?![A-Za-z])(\*?)/g;
  for (let m = re.exec(preamble); m; m = re.exec(preamble)) {
    const kind = m[1];
    const cmd = commandName(preamble, skipSpace(preamble, m.index + m[0].length));
    if (!cmd || cmd.name.includes('@')) continue;
    const { name } = cmd;
    let i = skipSpace(preamble, cmd.end);
    if (kind === 'let') {
      if (preamble[i] === '=') i = skipSpace(preamble, i + 1);
      const to = /^\\([A-Za-z]+)(?![A-Za-z])/.exec(preamble.slice(i));
      if (to && to[1] !== 'relax' && !to[1].includes('@')) defs[name] = { def: `\\${to[1]}`, args: 0 };
      continue;
    }
    let args = 0;
    if (kind === 'def' || kind === 'gdef') {
      // only #1#2… in order: delimited parameters (\def\x#1.{…}) have no counterpart in a formula renderer
      const params = /^(?:#[1-9])*/.exec(preamble.slice(i))![0];
      if (params !== Array.from({ length: params.length / 2 }, (_, k) => `#${k + 1}`).join('')) continue;
      args = params.length / 2;
      i += params.length;
      if (preamble[i] !== '{') continue;
    } else if (kind === 'DeclarePairedDelimiter') {
      const open = group(preamble, i);
      const close = open && group(preamble, skipSpace(preamble, open.end));
      if (!open || !close) continue;
      re.lastIndex = close.end;
      defs[name] = { def: `${open.body.trim()} #1 ${close.body.trim()}`, args: 1 };
      continue;
    } else if (kind !== 'DeclareMathOperator') {
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
    if (NOT_MATH.test(body.body)) continue;
    // a body that names an argument it does not take is not a definition TeX accepts
    if ([...body.body.matchAll(/#([0-9])/g)].some((x) => Number(x[1]) < 1 || Number(x[1]) > args)) continue;
    const def = kind === 'DeclareMathOperator' ? `\\operatorname${m[2]}{${body.body}}` : body.body;
    if (kind === 'providecommand' && defs[name]) continue;
    defs[name] = { def, args };
  }
  const names = Object.keys(defs).sort();
  return names.length ? { defs, key: names.map((n) => `${n}/${defs[n].args}/${defs[n].def}`).join('\n') } : NO_MACROS;
}

/**
 * The part of `set` a formula can reach: the macros its source names, and
 * those their definitions name in turn. A formula's rendering changes only
 * when this part does.
 */
export function macrosUsedBy(source: string, set: MacroSet): MacroSet {
  if (set === NO_MACROS) return NO_MACROS;
  const used = new Set<string>();
  const queue = [source];
  while (queue.length) {
    for (const m of queue.pop()!.matchAll(/\\([A-Za-z]+)/g)) {
      const def = set.defs[m[1]];
      if (def && !used.has(m[1])) { used.add(m[1]); queue.push(def.def); }
    }
  }
  if (!used.size) return NO_MACROS;
  const names = [...used].sort();
  const defs: Record<string, MacroDef> = {};
  for (const n of names) defs[n] = set.defs[n];
  return { defs, key: names.map((n) => `${n}/${defs[n].args}/${defs[n].def}`).join('\n') };
}
