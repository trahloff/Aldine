/**
 * Convert pasted rich text (HTML from Word, Google Docs, web pages) into
 * clean LaTeX. Deliberately conservative: unknown markup degrades to its
 * plain text; nothing invents structure that wasn't in the clipboard.
 */

const SPECIALS: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_',
  '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};

export function escapeLatex(text: string): string {
  return text.replace(/[\\&%$#_{}~^]/g, (c) => SPECIALS[c]);
}

/** Unicode math and Greek as math-mode LaTeX. */
const UNICODE_MATH: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon', ϵ: '\\epsilon', ζ: '\\zeta', η: '\\eta',
  θ: '\\theta', ϑ: '\\vartheta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', ο: 'o',
  π: '\\pi', ϖ: '\\varpi', ρ: '\\rho', ϱ: '\\varrho', σ: '\\sigma', ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon',
  φ: '\\varphi', ϕ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma', Υ: '\\Upsilon',
  Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
  '≤': '\\le', '≥': '\\ge', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv', '∼': '\\sim', '≃': '\\simeq', '≅': '\\cong',
  '∝': '\\propto', '≪': '\\ll', '≫': '\\gg', '≺': '\\prec', '≻': '\\succ', '⊥': '\\perp', '∥': '\\parallel', '∣': '\\mid',
  '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq', '∈': '\\in', '∉': '\\notin', '∋': '\\ni',
  '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div', '·': '\\cdot', '⋅': '\\cdot', '∗': '\\ast', '∘': '\\circ',
  '∙': '\\bullet', '⊕': '\\oplus', '⊗': '\\otimes', '∪': '\\cup', '∩': '\\cap', '∧': '\\wedge', '∨': '\\vee',
  '∖': '\\setminus', '−': '-', '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∮': '\\oint', '√': '\\surd',
  '∂': '\\partial', '∇': '\\nabla', '∞': '\\infty', '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists', '¬': '\\neg',
  '′': "'", '″': "''", '‴': "'''", ℓ: '\\ell', ℏ: '\\hbar', ħ: '\\hbar', '℘': '\\wp', ℜ: '\\Re', ℑ: '\\Im', ℵ: '\\aleph',
  '∠': '\\angle', '△': '\\triangle', '°': '^{\\circ}', '…': '\\ldots', '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots',
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow',
  '↦': '\\mapsto', '↑': '\\uparrow', '↓': '\\downarrow', '⟶': '\\longrightarrow', '⟹': '\\Longrightarrow',
  µ: '\\mu', '⟨': '\\langle', '⟩': '\\rangle', '‖': '\\|', '⌈': '\\lceil', '⌉': '\\rceil', '⌊': '\\lfloor', '⌋': '\\rfloor',
};

/** Characters of UNICODE_MATH that pdfLaTeX's UTF-8 input typesets in text as they are. */
const PDF_TEXT_OK = new Set('±×÷·°µ¬…→←↑↓');
const PROSE_SYMBOL = new RegExp(`[${Object.keys(UNICODE_MATH).filter((c) => !PDF_TEXT_OK.has(c)).join('')}]`, 'gu');

/**
 * Prose as LaTeX: specials escaped and, with `symbols` (pdfLaTeX, whose
 * input stops at a Greek letter or ≤), math symbols written as the commands
 * that typeset them in text and math alike.
 */
export function proseLatex(text: string, symbols = false): string {
  const escaped = escapeLatex(text);
  return symbols ? escaped.replace(PROSE_SYMBOL, (c) => (/^[A-Za-z]$/.test(UNICODE_MATH[c]) ? UNICODE_MATH[c] : `\\ensuremath{${UNICODE_MATH[c]}}`)) : escaped;
}

/** Characters as math-mode LaTeX: symbols as commands, specials escaped. */
function mathChars(text: string): string {
  let out = '';
  for (const c of text) {
    const cmd = UNICODE_MATH[c];
    if (cmd) out += /^\\[A-Za-z]+$/.test(cmd) ? `${cmd} ` : cmd;
    else if (/[&%$#{}]/.test(c)) out += `\\${c}`;
    else if (c === '\\') out += '\\backslash ';
    else if (c === ' ') out += ' ';
    else out += c;
  }
  return out;
}

/**
 * A stretch of pasted text that is LaTeX already, `[from, to)`. `percent`: a
 * `%` in it is a percent sign, since the stretch sits on one line where a
 * comment would swallow its own closing brace or `$`. `math`: a formula.
 */
export interface LatexRun { from: number; to: number; percent: boolean; math?: boolean }

const LETTER = /[A-Za-z]/;
const ARG_AHEAD = /[^\S\n]*[{[]/y;
const ENV_NAME = /[^\S\n]*\{([^{}\n]*)\}/y;
const ENV_EDGE = /\\(begin|end)[^\S\n]*\{([^{}\n]*)\}/g;
/** Environments whose body no escape can express: math, and text taken as written. */
const RAW_ENVS = /^(?:equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math|verbatim|Verbatim|lstlisting|minted)\*?$/;
const VERBATIM_ENVS = /^(?:verbatim|Verbatim|lstlisting|minted)\*?$/;
/** Commands that read `%` in their argument as part of an address. */
const VERBATIM_ARGS = /^(?:url|href|path|nolinkurl)$/;

/** Where the `{…}` or `[…]` group opening at `k` closes, or -1 when it doesn't on this line. */
function groupEnd(t: string, k: number): number {
  const square = t[k] === '[';
  if (!square && t[k] !== '{') return -1;
  let depth = 0;
  for (let m = k; m < t.length; m++) {
    const c = t[m];
    if (c === '\n') return -1;
    if (c === '\\') {
      if (t[m + 1] === '\n') return -1;
      m++;
    } else if (c === '{') depth++;
    else if (c === '}') {
      if (--depth === 0 && !square) return m;
      if (depth < 0) return -1;
    } else if (c === ']' && square && depth === 0) return m;
  }
  return -1;
}

/** A math or verbatim environment from its `\begin` at `i` through its matching `\end`, or null when it has none. */
function environment(t: string, i: number, nameAt: number, argsEnd: number): LatexRun | null {
  ENV_NAME.lastIndex = nameAt;
  const env = ENV_NAME.exec(t)?.[1].trim();
  if (!env || !RAW_ENVS.test(env)) return null;
  ENV_EDGE.lastIndex = argsEnd;
  let depth = 1;
  for (let m = ENV_EDGE.exec(t); m; m = ENV_EDGE.exec(t)) {
    if (m[2].trim() !== env) continue;
    depth += m[1] === 'begin' ? 1 : -1;
    if (depth) continue;
    const to = m.index + m[0].length;
    const verbatim = VERBATIM_ENVS.test(env);
    return { from: i, to, percent: !verbatim && !t.slice(i, to).includes('\n'), math: !verbatim };
  }
  return null;
}

/** A control word at `i` with its arguments, unless it is a Windows path's `C:\Users\me`. */
function command(t: string, i: number): LatexRun | null {
  let j = i + 1;
  while (LETTER.test(t[j] ?? '')) j++;
  const name = t.slice(i + 1, j);
  if (t[j] === '*') j++;
  ARG_AHEAD.lastIndex = j;
  if (/[A-Za-z0-9:\\/]/.test(t[i - 1] ?? '') && !ARG_AHEAD.test(t)) return null;
  let end = j;
  for (;;) {
    let k = end;
    while (t[k] === ' ' || t[k] === '\t') k++;
    const close = groupEnd(t, k);
    if (close < 0) break;
    end = close + 1;
  }
  return (name === 'begin' && environment(t, i, j, end)) || { from: i, to: end, percent: !VERBATIM_ARGS.test(name) };
}

/**
 * `$…$`, not the `$5 … $10` of prices, or `$$…$$`. A formula that opens with
 * a digit (`$2n$`) holds a letter or a math sign and ends on neither a space
 * nor a sign, which the `$5 to $10`, `$5-$10` and `$5M and $` of prices do.
 */
function dollarMath(t: string, i: number): LatexRun | null {
  if (t[i + 1] === '$') {
    const close = t.indexOf('$$', i + 2);
    const body = close < 0 || t[i - 1] === '$' || t[close + 2] === '$' ? '' : t.slice(i + 2, close);
    return /\S/.test(body) && !body.includes('$') ? { from: i, to: close + 2, percent: !body.includes('\n'), math: true } : null;
  }
  const close = t.indexOf('$', i + 1);
  if (close < 0) return null;
  const body = t.slice(i + 1, close);
  if (body.includes('\n')) return null;
  const letterLed = /^[^\s\d]/.test(body) && /\S$/.test(body);
  const digitLed = /^\d/.test(body) && !/[\s\-+,./]$/.test(body) && /[A-Za-z^_\\{}=<>]/.test(body);
  return letterLed || digitLed ? { from: i, to: close + 1, percent: true, math: true } : null;
}

/** `\(…\)` on one line, or `\[…\]`. */
function delimitedMath(t: string, i: number): LatexRun | null {
  const display = t[i + 1] === '[';
  const close = t.indexOf(display ? '\\]' : '\\)', i + 2);
  if (close < 0) return null;
  const body = t.slice(i + 2, close);
  if (!/\S/.test(body) || (!display && body.includes('\n'))) return null;
  return { from: i, to: close + 2, percent: !body.includes('\n'), math: true };
}

function runAt(t: string, i: number): LatexRun | null {
  const prev = t[i - 1] ?? '';
  const next = t[i + 1] ?? '';
  if (t[i] === '$') return prev === '\\' ? null : dollarMath(t, i);
  if (t[i] === '~') return /[A-Za-z.]/.test(prev) && /[A-Za-z0-9\\]/.test(next) ? { from: i, to: i + 1, percent: false } : null;
  if (t[i] !== '\\') return null;
  if (LETTER.test(next)) return command(t, i);
  if (/[:\\/]/.test(prev)) return null;
  if (/[%&$#_{},;!]/.test(next)) return { from: i, to: i + 2, percent: false };
  if (next === '\\') return /[A-Za-z0-9]/.test(t[i + 2] ?? '') ? null : { from: i, to: i + 2, percent: false };
  if (next === '(' || next === '[') return delimitedMath(t, i);
  return null;
}

/**
 * The stretches of `text` that are LaTeX already, as a draft types it or a
 * .tex file, a terminal or a chat copies it:
 * - a control word with its arguments (`\cite[p.~3]{knuth}`), but not a
 *   Windows path's `C:\Users\me`;
 * - an escape (`30\%`), a thin space (`5\,km`) or a line break (`\\`);
 * - a tie after a word (`Fig.~3`, not the `3~5` of a range);
 * - a formula (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, a math environment) or a
 *   verbatim environment. Display math and environments may span lines.
 */
export function latexRuns(text: string): LatexRun[] {
  const runs: LatexRun[] = [];
  for (let i = 0; i < text.length;) {
    const run = runAt(text, i);
    if (run) {
      runs.push(run);
      i = run.to;
    } else i++;
  }
  return runs;
}

export function looksLikeLatex(text: string): boolean {
  return latexRuns(text).length > 0;
}

const BLOCK_TAGS = 'p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,table,tr,blockquote,section,article';

function isBlock(el: Element): boolean {
  return /^(p|div|h[1-6]|ul|ol|li|table|tr|blockquote|br|section|article)$/i.test(el.tagName);
}

const UNSEEN = /^(style|script|head|meta|title|del)$/i;

/** A MathJax 2 script holding a formula's TeX source. */
function texScript(el: Element): boolean {
  return /^script$/i.test(el.tagName) && /^math\/tex\b/i.test(el.getAttribute('type') || '');
}

/**
 * Elements whose text the paste leaves out: the page's machinery, deleted
 * text (Word's tracked deletions), Word's own list numbers and bullets, and
 * what is hidden from screen readers as a copy of something else (the drawn
 * glyphs of a KaTeX or MathJax formula, Wikipedia's formula image).
 */
function unseen(el: Element): boolean {
  if (UNSEEN.test(el.tagName) && !texScript(el)) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  return /mso-list:\s*Ignore/i.test(el.getAttribute('style') || '');
}

/** Elements that paste as one formula, whatever their text says. */
function formulaElement(el: Element): boolean {
  return /^math$/i.test(el.tagName) || texScript(el);
}

/**
 * What the clipboard's text nodes write, worked out over each line of the
 * paste, so LaTeX split across runs (`\url{` around a link Docs made) stays
 * whole. `latex`: each text node's LaTeX. `kept`: text nodes that are LaTeX
 * throughout. `inFormula`: blocks that end inside a formula, whose next line
 * follows on a single newline (a blank line ends math with an error).
 */
interface Lines { latex: Map<Node, string>; kept: Set<Node>; inFormula: Set<Element> }

function readLines(root: Node, symbols: boolean): Lines {
  let text = '';
  const nodes: Array<{ node: Node; from: number; to: number }> = [];
  const blocks: Array<{ el: Element; at: number }> = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const s = (node.textContent || '').replace(/\s+/g, ' ');
      nodes.push({ node, from: text.length, to: text.length + s.length });
      text += s;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || unseen(node as Element)) return;
    const el = node as Element;
    if (formulaElement(el)) {
      text += ' ';
      return;
    }
    const block = isBlock(el) || /^t[dh]$/i.test(el.tagName);
    if (block) text += '\n';
    el.childNodes.forEach(walk);
    if (block) {
      blocks.push({ el, at: text.length });
      text += '\n';
    }
  };
  walk(root);
  const runs = latexRuns(text);
  const lines: Lines = { latex: new Map(), kept: new Set(), inFormula: new Set() };
  let r = 0;
  for (const { node, from, to } of nodes) {
    while (r < runs.length && runs[r].to <= from) r++;
    let out = '';
    let at = from;
    let kept = 0;
    for (let k = r; k < runs.length && runs[k].from < to; k++) {
      const run = runs[k];
      const a = Math.max(run.from, from);
      const b = Math.min(run.to, to);
      out += proseLatex(text.slice(at, a), symbols);
      for (let m = a; m < b; m++) out += run.percent && text[m] === '%' && text[m - 1] !== '\\' ? '\\%' : text[m];
      kept += b - a;
      at = b;
    }
    lines.latex.set(node, out + proseLatex(text.slice(at, to), symbols));
    if (to > from && kept === to - from) lines.kept.add(node);
  }
  r = 0;
  for (const { el, at } of blocks) {
    while (r < runs.length && runs[r].to <= at) r++;
    if (r < runs.length && runs[r].from < at) lines.inFormula.add(el);
  }
  return lines;
}

const MONO_FONT = /monospace|courier|menlo|monaco|consolas|inconsolata|\bmono\b|\bcode\b/i;

/** Whether every word on the clipboard is set in a monospace font: code, as an editor copies it with its colours. */
export function isCodeHtml(html: string): boolean {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  let words = false;
  const mono = (node: Node, code: boolean): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!/\S/.test(node.textContent || '')) return true;
      words = true;
      return code;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    const el = node as Element;
    if (UNSEEN.test(el.tagName)) return true;
    const font = (el as HTMLElement).style?.fontFamily;
    const inner = /^(pre|code|tt|kbd|samp)$/i.test(el.tagName) || (font ? MONO_FONT.test(font) : code);
    return Array.from(el.childNodes).every((child) => mono(child, inner));
  };
  return mono(dom.body, false) && words;
}

/**
 * Formatting already applied by an enclosing command, so nested runs don't
 * repeat it. `wrapped`: inside any command's argument. `url`: \url is defined.
 * `symbols`: Unicode math is written as commands (pdfLaTeX).
 */
interface Ctx {
  bold: boolean; italic: boolean; heading: boolean; wrapped: boolean; url: boolean; symbols: boolean;
  script: 'sup' | 'sub' | null; lines: Lines;
}

/** Whether all the text under `el` is LaTeX the paste spells out. */
function keptWhole(el: Element, ctx: Ctx): boolean {
  let words = false;
  const all = (node: Node): boolean => {
    if (node.nodeType !== Node.TEXT_NODE) return Array.from(node.childNodes).every(all);
    if (!/\S/.test(node.textContent || '')) return true;
    words = true;
    return ctx.lines.kept.has(node);
  };
  return all(el) && words;
}

/** Whether \url{href} typesets here: % and # read verbatim only outside another command's argument. */
function urlFits(href: string, ctx: Ctx): boolean {
  if (!ctx.url || /[{}\\\s]/.test(href)) return false;
  return !ctx.wrapped || !/[%#]/.test(href);
}

/** Bold as the element's own style says (Google Docs marks runs with font-weight), or null when it says nothing. */
function styledBold(el: Element): boolean | null {
  const w = (el as HTMLElement).style?.fontWeight;
  if (!w) return null;
  if (w === 'bold' || w === 'bolder') return true;
  if (w === 'normal' || w === 'lighter') return false;
  const n = Number(w);
  return Number.isFinite(n) ? n >= 600 : null;
}

function styledItalic(el: Element): boolean | null {
  const s = (el as HTMLElement).style?.fontStyle;
  if (!s) return null;
  return s === 'italic' || s === 'oblique';
}

/** Superscript or subscript as the tag or (Google Docs) the run's vertical-align says. */
function styledScript(el: Element, tag: string): 'sup' | 'sub' | null {
  if (tag === 'sup' || tag === 'sub') return tag;
  const v = (el as HTMLElement).style?.verticalAlign;
  return v === 'super' ? 'sup' : v === 'sub' ? 'sub' : null;
}

/** A paragraph of a desktop Word list: its level, and whether its marker is a number. */
interface WordItem { el: Element; level: number; ordered: boolean }

const WORD_LIST = /mso-list:\s*l\d+\s+level(\d+)/i;

function wordItem(node: Node): WordItem | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const m = /^(p|div)$/i.test(el.tagName) ? WORD_LIST.exec(el.getAttribute('style') || '') : null;
  if (!m) return null;
  let marker = '';
  const find = (n: Node): boolean => {
    if (n.nodeType !== Node.ELEMENT_NODE) return false;
    if (/mso-list:\s*Ignore/i.test((n as Element).getAttribute('style') || '')) {
      marker = (n.textContent || '').replace(/[\s ]+/g, '');
      return true;
    }
    return Array.from(n.childNodes).some(find);
  };
  find(el);
  const ordered = /^[([]?(?:\d+(?:\.\d+)*[.)\]]?|[A-Za-z][.)\]]|[ivxlcdmIVXLCDM]+[.)\]])$/.test(marker);
  return { el, level: Number(m[1]), ordered };
}

/** Word's list paragraphs as itemize/enumerate, nested by their levels. */
function convertWordList(items: WordItem[], ctx: Ctx): string {
  const open: Array<{ level: number; env: string }> = [];
  let out = '\n';
  for (const item of items) {
    while (open.length && open[open.length - 1].level > item.level) out += `\\end{${open.pop()!.env}}\n`;
    const top = open[open.length - 1];
    if (!top || top.level < item.level) {
      const env = item.ordered ? 'enumerate' : 'itemize';
      open.push({ level: item.level, env });
      out += `\\begin{${env}}\n`;
    }
    out += `\\item ${convertChildren(item.el, ctx).trim().replace(/\n{2,}/g, '\n')}\n`;
  }
  while (open.length) out += `\\end{${open.pop()!.env}}\n`;
  return out;
}

const blankText = (n: Node) => n.nodeType === Node.TEXT_NODE && !/\S/.test(n.textContent || '');

/** A MathJax 2 formula's drawing, when the script after it holds the formula's TeX. */
function mathJaxFrame(kids: Node[], i: number): boolean {
  const el = kids[i];
  if (el.nodeType !== Node.ELEMENT_NODE || !/\bMathJax/.test((el as Element).getAttribute('class') || '')) return false;
  for (let j = i + 1; j < kids.length; j++) {
    if (blankText(kids[j])) continue;
    return kids[j].nodeType === Node.ELEMENT_NODE && texScript(kids[j] as Element);
  }
  return false;
}

function convertChildren(node: Node, ctx: Ctx): string {
  let out = '';
  const kids = Array.from(node.childNodes);
  for (let i = 0; i < kids.length; i++) {
    const first = wordItem(kids[i]);
    if (first) {
      const items = [first];
      let j = i + 1;
      for (; j < kids.length; j++) {
        if (blankText(kids[j])) continue;
        const item = wordItem(kids[j]);
        if (!item) break;
        items.push(item);
      }
      out += convertWordList(items, ctx);
      i = j - 1;
      continue;
    }
    if (mathJaxFrame(kids, i)) continue;
    out += convertNode(kids[i], ctx);
  }
  return out;
}

/**
 * arXiv's HTML (LaTeXML) lays a display equation out as a table: its parts
 * in cells (an aligned one split at its `&`), its number in a cell of its
 * own. Each row is one display formula.
 */
function equationTable(el: Element): string {
  const rows = Array.from(el.querySelectorAll('tr')).map((tr) => Array.from(tr.querySelectorAll('td'))
    .filter((td) => !/\bltx_eqn_eqno\b/.test(td.getAttribute('class') || ''))
    .flatMap((td) => Array.from(td.querySelectorAll('math')).map((m) => mathmlSource(m).trim().replace(/^\\displaystyle\b\s*/, '')))
    .join(' '));
  return `\n${rows.map((tex) => formula(tex, true)).filter(Boolean).join('\n')}\n`;
}

function convertTable(el: Element, ctx: Ctx): string {
  if (/\bltx_eqn/.test(el.getAttribute('class') || '')) return equationTable(el);
  const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td,th')).map((td) => convertChildren(td, ctx).trim().replace(/\n+/g, ' ')),
  ).filter((r) => r.length);
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const body = rows.map((r) => {
    while (r.length < cols) r.push('');
    return `${r.join(' & ')} \\\\`;
  }).join('\n');
  return `\n\\begin{tabular}{${'l'.repeat(cols)}}\n${body}\n\\end{tabular}\n`;
}

/**
 * The items of a list, every child kept. Google Docs writes a sub-list as a
 * `ul`/`ol` beside the items, not inside one: it, and anything else between
 * items, belongs to the item before it. Before the first item there is
 * nothing to nest under, so a sub-list's items count as this list's.
 */
function listItems(el: Element, ctx: Ctx): string[] {
  const items: string[] = [];
  el.childNodes.forEach((child) => {
    const tag = child.nodeType === Node.ELEMENT_NODE ? (child as Element).tagName.toLowerCase() : '';
    if (tag === 'li') { items.push(convertChildren(child, ctx).trim()); return; }
    if (!items.length && (tag === 'ul' || tag === 'ol')) { items.push(...listItems(child as Element, ctx)); return; }
    const out = convertNode(child, ctx).trim();
    if (!out) return;
    if (items.length) items[items.length - 1] += `\n${out}`;
    else items.push(out);
  });
  return items;
}

function convertList(el: Element, ordered: boolean, ctx: Ctx): string {
  const items = listItems(el, ctx).map((item) => `\\item ${item}`);
  if (!items.length) return '';
  const env = ordered ? 'enumerate' : 'itemize';
  return `\n\\begin{${env}}\n${items.join('\n')}\n\\end{${env}}\n`;
}

function heading(cmd: string, el: Element, ctx: Ctx): string {
  return `\n\\${cmd}{${convertChildren(el, { ...ctx, heading: true, wrapped: true }).trim()}}\n`;
}

/** Element children by tag name, namespace prefix included (`m:e`), case aside. */
function childrenNamed(el: Element, name: string): Element[] {
  const want = name.toLowerCase();
  return Array.from(el.childNodes).filter((c): c is Element => c.nodeType === Node.ELEMENT_NODE && (c as Element).tagName.toLowerCase() === want);
}

/** `s` as a sub- or superscript's base: one token as it is, anything longer braced. */
function base(s: string): string {
  const t = s.trim();
  return /^(?:[A-Za-z0-9]|\\[A-Za-z]+)$/.test(t) ? t : `{${t}}`;
}

/** Function names TeX sets upright as operators. */
const MATH_FUNCTIONS = /^(?:sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|coth|arcsin|arccos|arctan|log|ln|lg|exp|lim|liminf|limsup|max|min|sup|inf|det|dim|ker|arg|deg|gcd|hom|Pr)$/;

function operatorName(name: string): string {
  const t = name.trim();
  if (MATH_FUNCTIONS.test(t)) return `\\${t} `;
  return /^[A-Za-z]{2,}$/.test(t) ? `\\mathrm{${t}}` : t;
}

/** Combining accents (and their spacing forms) as the accent commands. */
const ACCENTS: Record<string, string> = {
  '̂': 'hat', '^': 'hat', '̃': 'tilde', '~': 'tilde', '̇': 'dot', '˙': 'dot', '̈': 'ddot', '¨': 'ddot',
  '⃗': 'vec', '→': 'vec', '̄': 'bar', '̅': 'bar', '¯': 'bar', '́': 'acute', '̀': 'grave', '̌': 'check',
};

const tidyMath = (tex: string) => tex.replace(/\s+/g, ' ').replace(/ ([}^_)\]])/g, '$1').trim();

/** MathML as LaTeX, for a formula that carries no TeX of its own. */
function mathmlTex(el: Element): string {
  const kids = Array.from(el.childNodes).filter((c): c is Element => c.nodeType === Node.ELEMENT_NODE);
  const sub = (i: number) => (kids[i] ? mathmlTex(kids[i]) : '');
  const all = () => kids.map(mathmlTex).join('');
  const text = (el.textContent || '').trim();
  switch (el.tagName.toLowerCase().replace(/^\w+:/, '')) {
    case 'mi': return text.length > 1 && !UNICODE_MATH[text] ? operatorName(text) : mathChars(text);
    case 'mn': case 'mo': return mathChars(text);
    case 'mtext': case 'ms': return text ? `\\mbox{${escapeLatex(text)}}` : '';
    case 'mspace': return ' ';
    case 'msup': return `${base(sub(0))}^{${sub(1)}}`;
    case 'msub': return `${base(sub(0))}_{${sub(1)}}`;
    case 'msubsup': case 'munderover': return `${base(sub(0))}_{${sub(1)}}^{${sub(2)}}`;
    case 'munder': return `${base(sub(0))}_{${sub(1)}}`;
    case 'mover': {
      const accent = ACCENTS[(kids[1]?.textContent || '').trim()];
      return accent ? `\\${accent}{${sub(0)}}` : `${base(sub(0))}^{${sub(1)}}`;
    }
    case 'mfrac': return `\\frac{${sub(0)}}{${sub(1)}}`;
    case 'msqrt': return `\\sqrt{${all()}}`;
    case 'mroot': return `\\sqrt[${sub(1)}]{${sub(0)}}`;
    case 'mfenced': {
      const open = el.getAttribute('open') ?? '(';
      const close = el.getAttribute('close') ?? ')';
      return `\\left${delimiter(open)} ${kids.map(mathmlTex).join(el.getAttribute('separators') ?? ',')} \\right${delimiter(close)}`;
    }
    case 'mtable': {
      const rows = kids.map((tr) => Array.from(tr.childNodes).filter((c): c is Element => c.nodeType === Node.ELEMENT_NODE).map(mathmlTex));
      const cols = Math.max(1, ...rows.map((r) => r.length));
      return `\\begin{array}{${'c'.repeat(cols)}} ${rows.map((r) => r.join(' & ')).join(' \\\\ ')} \\end{array}`;
    }
    case 'semantics': return sub(0);
    case 'annotation': case 'annotation-xml': case 'mphantom': return '';
    default: return all();
  }
}

/** A delimiter character as what \left or \right takes. */
function delimiter(c: string): string {
  if (!c) return '.';
  if (c === '{' || c === '}') return `\\${c}`;
  return UNICODE_MATH[c] ?? c;
}

/** The TeX a MathML formula carries (an x-tex annotation, as KaTeX, Wikipedia and arXiv write it, or its alttext), or MathML read as LaTeX. */
function mathmlSource(math: Element): string {
  for (const a of math.querySelectorAll('annotation')) {
    if (/^(?:application\/x-tex|tex|latex)$/i.test((a.getAttribute('encoding') || '').trim())) return a.textContent || '';
  }
  return math.getAttribute('alttext') ?? tidyMath(mathmlTex(math));
}

/** A formula's TeX as inline or display math; Wikipedia wraps its TeX in {\displaystyle …}. */
function formula(tex: string, display: boolean): string {
  let t = tex.trim();
  const style = /^\{\s*\\(?:display|text)style\b([\s\S]*)\}$/.exec(t);
  if (style) t = style[1].trim();
  t = t.replace(/^\\displaystyle\b\s*/, '').replace(/\n\s*\n/g, '\n');
  if (!t) return '';
  return display ? `\\[ ${t} \\]` : `$${t.replace(/\s*\n\s*/g, ' ')}$`;
}

/** Word's equation (OMML) as LaTeX. Its HTML formatting wraps the parts and is passed through. */
function ommlTex(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return mathChars(node.textContent || '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const inner = () => Array.from(el.childNodes).map(ommlTex).join('');
  if (!tag.startsWith('m:')) return inner();
  const part = (name: string) => childrenNamed(el, `m:${name}`).map(ommlTex).join('');
  const prop = (pr: string, name: string): string | null => {
    const holder = childrenNamed(el, `m:${pr}`)[0];
    const p = holder && childrenNamed(holder, `m:${name}`)[0];
    return p ? p.getAttribute('m:val') ?? '' : null;
  };
  const scripts = (tex: string, sub: string, sup: string) => `${tex}${sub.trim() ? `_{${sub}}` : ''}${sup.trim() ? `^{${sup}}` : ''}`;
  switch (tag.slice(2)) {
    case 'ssup': return `${base(part('e'))}^{${part('sup')}}`;
    case 'ssub': return `${base(part('e'))}_{${part('sub')}}`;
    case 'ssubsup': return `${base(part('e'))}_{${part('sub')}}^{${part('sup')}}`;
    case 'spre': return `{}_{${part('sub')}}^{${part('sup')}}${base(part('e'))}`;
    case 'f': return `\\frac{${part('num')}}{${part('den')}}`;
    case 'rad': {
      const deg = part('deg').trim();
      return `\\sqrt${deg ? `[${deg}]` : ''}{${part('e')}}`;
    }
    case 'nary': return `${scripts(mathChars(prop('naryPr', 'chr') || '∫').trim(), part('sub'), part('sup'))} ${part('e')}`;
    case 'd': {
      const sep = mathChars(prop('dPr', 'sepChr') ?? ',');
      const es = childrenNamed(el, 'm:e').map(ommlTex);
      return `\\left${delimiter(prop('dPr', 'begChr') ?? '(')} ${es.join(sep)} \\right${delimiter(prop('dPr', 'endChr') ?? ')')}`;
    }
    case 'func': return `${operatorName(part('fName'))} ${part('e')}`;
    case 'acc': return `\\${ACCENTS[prop('accPr', 'chr') ?? '̂'] ?? 'hat'}{${part('e')}}`;
    case 'bar': return `\\${prop('barPr', 'pos') === 'bot' ? 'underline' : 'overline'}{${part('e')}}`;
    case 'limlow': return scripts(operatorName(part('e')), part('lim'), '');
    case 'limupp': return scripts(base(part('e')), '', part('lim'));
    case 'm': {
      const rows = childrenNamed(el, 'm:mr').map((mr) => childrenNamed(mr, 'm:e').map(ommlTex));
      const cols = Math.max(1, ...rows.map((r) => r.length));
      return `\\begin{array}{${'c'.repeat(cols)}} ${rows.map((r) => r.join(' & ')).join(' \\\\ ')} \\end{array}`;
    }
    case 'eqarr': return `\\begin{array}{l} ${childrenNamed(el, 'm:e').map(ommlTex).join(' \\\\ ')} \\end{array}`;
    default: return /pr$/.test(tag) ? '' : inner();
  }
}

/** Word's equations, which it writes into a conditional comment (its fallback image is useless off the author's disk). */
function wordEquations(comment: string): string {
  const m = /^\[if gte msEquation \d+\]>([\s\S]*)<!\[endif\]$/.exec(comment.trim());
  if (!m) return '';
  const out: string[] = [];
  const visit = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'm:omathpara') {
      for (const math of childrenNamed(el, 'm:omath')) out.push(formula(tidyMath(ommlTex(math)), true));
      return;
    }
    if (tag === 'm:omath') { out.push(formula(tidyMath(ommlTex(el)), false)); return; }
    Array.from(el.childNodes).forEach((c) => { if (c.nodeType === Node.ELEMENT_NODE) visit(c as Element); });
  };
  // OMML closes empty elements XML-style (`<m:chr m:val="∑"/>`), which an HTML parser reads as an opening tag
  const markup = m[1].replace(/<([a-z][\w:-]*)(\s[^<>]*?)?\/>/gi, '<$1$2></$1>');
  visit(new DOMParser().parseFromString(markup, 'text/html').body);
  return out.filter(Boolean).join(' ');
}

function convertNode(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return ctx.lines.latex.get(node) ?? proseLatex((node.textContent || '').replace(/\s+/g, ' '), ctx.symbols);
  }
  if (node.nodeType === Node.COMMENT_NODE) return wordEquations(node.textContent || '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === 'math') return formula(mathmlSource(el), el.getAttribute('display') === 'block');
  if (texScript(el)) return formula(el.textContent || '', /mode\s*=\s*display/i.test(el.getAttribute('type') || ''));
  if (unseen(el)) return '';
  switch (tag) {
    case 'h1': return heading('section', el, ctx);
    case 'h2': return heading('subsection', el, ctx);
    case 'h3': case 'h4': case 'h5': case 'h6': return heading('subsubsection', el, ctx);
    case 'a': {
      const href = (el.getAttribute('href') || '').trim();
      const inner = convertChildren(el, ctx).trim();
      // same-page anchors (a section link, a Wikipedia footnote) and script
      // links lead nowhere from a paper: the text is what was meant
      if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return inner;
      // a link inside LaTeX the paste spells out (Docs links the address in `\url{…}`) is that LaTeX's argument
      if (keptWhole(el, ctx)) return inner;
      // Never \href: it exists only under hyperref, which many classes (incl.
      // plain article setups) don't load — one pasted link then kills the
      // compile. \url only where the preamble loads it, else the URL as text.
      const url = urlFits(href, ctx) ? `\\url{${href}}` : escapeLatex(href);
      if (!inner || (el.textContent || '').trim() === href) return url;
      return `${inner} (${url})`;
    }
    case 'ul': return convertList(el, false, ctx);
    case 'ol': return convertList(el, true, ctx);
    case 'table': return convertTable(el, ctx);
    case 'br': return '\n';
    default: {
      const bold = styledBold(el) ?? (tag === 'b' || tag === 'strong' ? true : null);
      const italic = styledItalic(el) ?? (tag === 'i' || tag === 'em' ? true : null);
      const script = styledScript(el, tag);
      const wrappers: string[] = [];
      // An inline command around a paragraph break is a runaway argument (the
      // compile stops), so block content is never wrapped.
      const inline = !isBlock(el) && !el.querySelector(BLOCK_TAGS);
      const next = { ...ctx };
      if (inline) {
        if (bold && !ctx.bold && !ctx.heading) { wrappers.push('textbf'); next.bold = true; }
        if (italic && !ctx.italic) { wrappers.push('textit'); next.italic = true; }
        if (tag === 'u') wrappers.push('underline');
        if (tag === 'code' || tag === 'tt') wrappers.push('texttt');
        if (script && ctx.script !== script) { wrappers.push(script === 'sup' ? 'textsuperscript' : 'textsubscript'); next.script = script; }
      }
      if (wrappers.length) next.wrapped = true;
      let inner = convertChildren(el, next);
      if (wrappers.length) {
        const text = inner.trim();
        if (!text) return '';
        // keep the run's outer spaces outside the braces
        const lead = /^\s/.test(inner) ? ' ' : '';
        const trail = /\s$/.test(inner) ? ' ' : '';
        inner = lead + wrappers.reduceRight((acc, cmd) => `\\${cmd}{${acc}}`, text) + trail;
      }
      return isBlock(el) ? `${inner.replace(/\s+$/, '')}${ctx.lines.inFormula.has(el) ? '\n' : '\n\n'}` : inner;
    }
  }
}

/**
 * `url`: whether the document defines \url; without it links keep their
 * address as escaped text. `symbols`: write Unicode math as LaTeX commands,
 * for pdfLaTeX. LaTeX the text spells out (latexRuns) stays as written, and
 * the prose around it is escaped.
 */
export function htmlToLatex(html: string, opts: { url?: boolean; symbols?: boolean } = {}): string {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const symbols = opts.symbols ?? false;
  const ctx: Ctx = { bold: false, italic: false, heading: false, wrapped: false, url: opts.url ?? false, symbols, script: null, lines: readLines(dom.body, symbols) };
  return convertNode(dom.body, ctx)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
