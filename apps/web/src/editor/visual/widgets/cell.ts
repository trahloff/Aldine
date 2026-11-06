import { renderMath } from '../katex';
import { macrosUsedBy } from '../preamble';
import type { MacroSet } from '../preamble';
import { CTRL_SYMBOLS, CTRL_WORDS } from '../decorations';
import { citeChip, refChip } from './chips';

/** Commands whose argument shows in a style, as Visual shows them in text. */
const STYLED: Record<string, string> = {
  textbf: 'cm-vis-b', textit: 'cm-vis-i', emph: 'cm-vis-i', textsl: 'cm-vis-i', underline: 'cm-vis-u', textsc: 'cm-vis-sc',
  texttt: 'cm-vis-tt', textsuperscript: 'cm-vis-sup', textsubscript: 'cm-vis-sub',
  textrm: '', textsf: '', textnormal: '', textup: '', mbox: '', makecell: '', thead: '',
};

/** Declarations that style the rest of their group (`{\bf Model}`); size and alignment ones show nothing. */
const SWITCHES: Record<string, string> = {
  bf: 'cm-vis-b', bfseries: 'cm-vis-b', it: 'cm-vis-i', itshape: 'cm-vis-i', em: 'cm-vis-i', sl: 'cm-vis-i', slshape: 'cm-vis-i',
  sc: 'cm-vis-sc', scshape: 'cm-vis-sc', tt: 'cm-vis-tt', ttfamily: 'cm-vis-tt',
  rm: '', rmfamily: '', sffamily: '', normalfont: '', upshape: '', mdseries: '',
  tiny: '', scriptsize: '', footnotesize: '', small: '', normalsize: '', large: '', Large: '', LARGE: '', huge: '', Huge: '',
  centering: '', raggedright: '', raggedleft: '', arraybackslash: '',
};

const CITE = /^(?:[Cc]ite[a-z]*|[Pp]arencite|[Tt]extcite|[Aa]utocite|[Ff]ootcite|citep|citet|citealp|citealt)$/;
const REF = /^(?:ref|eqref|autoref|[Cc]ref|pageref|nameref|vref)$/;
const SPACES: Record<string, string> = { ',': ' ', ' ': ' ', ';': ' ', ':': ' ', '!': '' };

function group(src: string, i: number): { inner: string; end: number } | null {
  if (src[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return { inner: src.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

function optional(src: string, i: number): { inner: string; end: number } | null {
  const j = skip(src, i);
  if (src[j] !== '[') return null;
  const close = src.indexOf(']', j);
  return close < 0 ? null : { inner: src.slice(j + 1, close), end: close + 1 };
}

const skip = (src: string, i: number) => { while (src[i] === ' ' || src[i] === '\t') i++; return i; };

/** The closing `$` of inline math opening at `open`, or -1. */
function dollarClose(src: string, open: number): number {
  for (let j = open + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '$') return j > open + 1 ? j : -1;
  }
  return -1;
}

/** What a cell shows: text, a styled run, a formula, a citation or a reference. */
export type CellPart = string | { style: string; parts: CellPart[] } | { math: string } | { cite: string; notes: string[] } | { ref: string };

/**
 * A cell's text as Visual shows text: formulas typeset, styles applied,
 * escapes as the characters they stand for, citations and references as
 * chips, a \multicolumn or \multirow as its content. Anything else shows as
 * written.
 */
export function cellParts(src: string): CellPart[] {
  const out: CellPart[] = [];
  let text = '';
  const push = (part: CellPart) => {
    if (text) { out.push(text); text = ''; }
    out.push(part);
  };
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (ch === '$') {
      const close = dollarClose(src, i);
      if (close > 0) { push({ math: src.slice(i + 1, close) }); i = close + 1; continue; }
    } else if (ch === '{') {
      const g = group(src, i);
      if (g) { push({ style: '', parts: cellParts(g.inner) }); i = g.end; continue; }
    } else if (ch === '~') {
      text += '\u00a0';
      i++;
      continue;
    } else if (ch === '\\') {
      const two = src.slice(i, i + 2);
      if (two === '\\(') {
        const close = src.indexOf('\\)', i + 2);
        if (close > 0) { push({ math: src.slice(i + 2, close) }); i = close + 2; continue; }
      }
      if (CTRL_SYMBOLS[two]) { text += CTRL_SYMBOLS[two]; i += 2; continue; }
      if (two[1] in SPACES) { text += SPACES[two[1]]; i += 2; continue; }
      const m = /^\\([A-Za-z]+)\*?/.exec(src.slice(i));
      if (m) {
        const name = m[1];
        let j = i + m[0].length;
        const word = CTRL_WORDS[`\\${name}`];
        if (word !== undefined) {
          text += word;
          // as TeX reads it: a control word takes the spaces after it
          i = src.startsWith('{}', j) ? j + 2 : skip(src, j);
          continue;
        }
        if (name in STYLED) {
          const g = group(src, skip(src, j));
          if (g) { push({ style: STYLED[name], parts: cellParts(g.inner) }); i = g.end; continue; }
        }
        if (name === 'multicolumn' || name === 'multirow') {
          // \multicolumn{n}{spec}{body}; \multirow[pos]{n}[bigstruts]{width}[fixup]{body}
          let k = j;
          let last: { inner: string; end: number } | null = null;
          for (let n = 0; n < 3; n++) {
            if (name === 'multirow') k = optional(src, k)?.end ?? k;
            last = group(src, skip(src, k));
            if (!last) break;
            k = last.end;
          }
          if (last) {
            if (name === 'multirow') k = optional(src, k)?.end ?? k;
            const body = name === 'multirow' ? group(src, skip(src, k)) ?? last : last;
            if (text) { out.push(text); text = ''; }
            out.push(...cellParts(body.inner));
            i = body.end;
            continue;
          }
        }
        if (CITE.test(name) || REF.test(name)) {
          const notes: string[] = [];
          for (let o = optional(src, j); o; o = optional(src, j)) { notes.push(o.inner); j = o.end; }
          const g = group(src, skip(src, j));
          if (g) {
            push(CITE.test(name) ? { cite: g.inner.trim(), notes } : { ref: g.inner.trim() });
            i = g.end;
            continue;
          }
        }
        if (name in SWITCHES) {
          push({ style: SWITCHES[name], parts: cellParts(src.slice(skip(src, j))) });
          break;
        }
        if (name === 'hfill' || name === 'quad' || name === 'qquad') { text += ' '; i = skip(src, j); continue; }
        text += m[0];
        i = j;
        continue;
      }
    }
    text += ch;
    i++;
  }
  if (text) out.push(text);
  return out;
}

/** A chip drawn inside a cell: the cell's own editor takes its clicks, and tests find the table's chips apart from the text's. */
function cellChip(el: HTMLElement): HTMLElement {
  el.setAttribute('data-testid', `vis-cell-${el.getAttribute('data-testid')?.replace(/^vis-/, '') ?? 'chip'}`);
  return el;
}

/** The DOM for a cell's text (cellParts). */
export function renderCell(src: string, macros: MacroSet): Node[] {
  const build = (part: CellPart): Node => {
    if (typeof part === 'string') return document.createTextNode(part);
    if ('style' in part) {
      const el = document.createElement('span');
      if (part.style) el.className = part.style;
      el.append(...part.parts.map(build));
      return el;
    }
    if ('math' in part) {
      const el = document.createElement('span');
      el.className = 'cm-vis-cellmath';
      const html = renderMath(part.math.trim(), false, macrosUsedBy(part.math, macros));
      if (html) el.innerHTML = html;
      else { el.classList.add('cm-vis-math--raw'); el.textContent = `$${part.math}$`; }
      return el;
    }
    return cellChip('cite' in part ? citeChip(part.cite, part.notes).toDOM() : refChip(part.ref).toDOM());
  };
  return cellParts(src).map(build);
}
