/** Minimal BibTeX parser — enough for autocomplete metadata (key, type, author, title, year). */

export interface BibEntry {
  key: string;
  type: string;
  author?: string;
  /** Display surname of the first author, computed BEFORE brace-stripping —
   *  a literal name ({Growth Market Reports}) stays whole, a comma-form name
   *  keeps its full surname part (Castanon Remy). */
  authorLabel?: string;
  title?: string;
  year?: string;
  journal?: string;
  file: string;
}

/** First author's label from the RAW (still braced) author field. */
function firstAuthorLabel(raw: string): string | undefined {
  const first = raw.split(/\s+and\s+/i)[0].trim();
  if (!first) return undefined;
  // {Literal Name}: biblatex treats the braced group as one indivisible name
  if (first.startsWith('{')) return clean(first) || undefined;
  const cleaned = clean(first);
  if (!cleaned) return undefined;
  // "Surname, Given" keeps the whole surname part; "Given Surname" the last word
  if (cleaned.includes(',')) return cleaned.split(',')[0].trim() || undefined;
  return cleaned.split(/\s+/).pop();
}

/** Just the citation keys (skipping @comment/@string/@preamble) — a cheap
 *  dedup check without parseBib's per-entry field extraction. */
export function bibKeys(source: string): Set<string> {
  const keys = new Set<string>();
  const re = /@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const type = m[1].toLowerCase();
    if (type === 'comment' || type === 'preamble' || type === 'string') continue;
    keys.add(m[2]);
  }
  return keys;
}

export function parseBib(source: string, file: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const re = /@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const type = m[1].toLowerCase();
    if (type === 'comment' || type === 'preamble' || type === 'string') continue;
    const key = m[2];
    // capture the balanced body of the entry
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    const body = source.slice(re.lastIndex, i - 1);
    const rawField = (name: string): string | undefined => {
      const fm = body.match(new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*(\\{|")`, 'i'));
      if (!fm) return undefined;
      const open = fm[1];
      let start = fm.index! + fm[0].length;
      if (open === '{') {
        let d = 1; let j = start;
        while (j < body.length && d > 0) {
          if (body[j] === '{') d++;
          else if (body[j] === '}') d--;
          j++;
        }
        return body.slice(start, j - 1);
      } else {
        const end = body.indexOf('"', start);
        return end === -1 ? undefined : body.slice(start, end);
      }
    };
    const field = (name: string): string | undefined => {
      const raw = rawField(name);
      return raw === undefined ? undefined : clean(raw);
    };
    const rawAuthor = rawField('author');
    entries.push({
      key,
      type,
      file,
      author: rawAuthor === undefined ? undefined : clean(rawAuthor),
      authorLabel: rawAuthor === undefined ? undefined : firstAuthorLabel(rawAuthor),
      title: field('title'),
      year: field('year') || (field('date') || '').slice(0, 4) || undefined,
      journal: field('journal') || field('journaltitle') || field('booktitle'),
    });
  }
  return entries;
}

const ACCENTS: Record<string, string> = {
  '`': '̀', "'": '́', '^': '̂', '~': '̃', '=': '̄', '.': '̇', '"': '̈',
  u: '̆', v: '̌', H: '̋', r: '̊', c: '̧', k: '̨', d: '̣', b: '̱',
};

/** Control words that print something; every other one prints nothing but
 *  keeps its argument (\emph{x} is x). */
const WORDS: Record<string, string> = {
  TeX: 'TeX', LaTeX: 'LaTeX', LaTeXe: 'LaTeX2ε', BibTeX: 'BibTeX', XeTeX: 'XeTeX', XeLaTeX: 'XeLaTeX',
  LuaTeX: 'LuaTeX', LuaLaTeX: 'LuaLaTeX', ConTeXt: 'ConTeXt', AmS: 'AMS', METAFONT: 'METAFONT', MF: 'METAFONT',
  ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  textendash: '–', textemdash: '—', ldots: '…', dots: '…', textellipsis: '…', textquoteleft: '‘',
  textquoteright: '’', S: '§', P: '¶', copyright: '©', textregistered: '®', texttrademark: '™',
  textdegree: '°', euro: '€', pounds: '£', textbackslash: '\\',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ',
  Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

// \"o, \"{o}, \'\i; a letter accent needs a brace or a space (\v{c}, \v c) so \cite and \url stay commands
const ACCENT = /\\([`'^~=."])\s*(?:\{\s*(\\[ij]|[a-zA-Z])\s*\}|(\\[ij](?![a-zA-Z])|[a-zA-Z]))|\\([uvHrckdb])(?:\s*\{\s*(\\[ij]|[a-zA-Z])\s*\}|\s+(\\[ij](?![a-zA-Z])|[a-zA-Z]))/g;
// TeX eats the spaces after a control word, so \TeX book is TeXbook
const COMMAND = /\\([a-zA-Z]+)\s*|\\([^a-zA-Z])/g;
const OPEN = '', CLOSE = '';

/** BibTeX field text as it prints, for display only. Commands go before
 *  braces: {\TeX}book must not become \TeXbook, one unknown command. */
function clean(s: string): string {
  return s
    .replace(/\\\{/g, OPEN).replace(/\\\}/g, CLOSE)
    .replace(/(?<!\\)\$/g, '')
    .replace(ACCENT, (_, sym, symBraced, symBare, letter, letterBraced, letterBare) => {
      const base: string = symBraced ?? symBare ?? letterBraced ?? letterBare;
      return (base.startsWith('\\') ? base.slice(1) : base) + ACCENTS[sym ?? letter];
    })
    .replace(COMMAND, (_, word: string | undefined, symbol: string | undefined) => {
      if (word) return WORDS[word] ?? '';
      if (symbol === ' ' || symbol === '\\' || symbol === ',') return ' ';
      return '&%$#_'.includes(symbol!) ? symbol! : '';
    })
    .replace(/[{}]/g, '')
    .replace(new RegExp(OPEN, 'g'), '{').replace(new RegExp(CLOSE, 'g'), '}')
    .replace(/---/g, '—').replace(/--/g, '–').replace(/``/g, '“').replace(/''/g, '”')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .normalize('NFC')
    .trim();
}
