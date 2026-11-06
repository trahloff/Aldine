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

/**
 * A stretch of pasted text that is LaTeX already, `[from, to)`. `percent`: a
 * `%` in it is a percent sign, since the stretch sits on one line where a
 * comment would swallow its own closing brace or `$`.
 */
export interface LatexRun { from: number; to: number; percent: boolean }

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
    return { from: i, to, percent: !VERBATIM_ENVS.test(env) && !t.slice(i, to).includes('\n') };
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
    return /\S/.test(body) && !body.includes('$') ? { from: i, to: close + 2, percent: !body.includes('\n') } : null;
  }
  const close = t.indexOf('$', i + 1);
  if (close < 0) return null;
  const body = t.slice(i + 1, close);
  if (body.includes('\n')) return null;
  const letterLed = /^[^\s\d]/.test(body) && /\S$/.test(body);
  const digitLed = /^\d/.test(body) && !/[\s\-+,./]$/.test(body) && /[A-Za-z^_\\{}=<>]/.test(body);
  return letterLed || digitLed ? { from: i, to: close + 1, percent: true } : null;
}

/** `\(…\)` on one line, or `\[…\]`. */
function delimitedMath(t: string, i: number): LatexRun | null {
  const display = t[i + 1] === '[';
  const close = t.indexOf(display ? '\\]' : '\\)', i + 2);
  if (close < 0) return null;
  const body = t.slice(i + 2, close);
  if (!/\S/.test(body) || (!display && body.includes('\n'))) return null;
  return { from: i, to: close + 2, percent: !body.includes('\n') };
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

const UNSEEN = /^(style|script|head|meta|title)$/i;

/**
 * What the clipboard's text nodes write, worked out over each line of the
 * paste, so LaTeX split across runs (`\url{` around a link Docs made) stays
 * whole. `latex`: each text node's LaTeX. `kept`: text nodes that are LaTeX
 * throughout. `inFormula`: blocks that end inside a formula, whose next line
 * follows on a single newline (a blank line ends math with an error).
 */
interface Lines { latex: Map<Node, string>; kept: Set<Node>; inFormula: Set<Element> }

function readLines(root: Node): Lines {
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
    if (node.nodeType !== Node.ELEMENT_NODE || UNSEEN.test((node as Element).tagName)) return;
    const el = node as Element;
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
      out += escapeLatex(text.slice(at, a));
      for (let m = a; m < b; m++) out += run.percent && text[m] === '%' && text[m - 1] !== '\\' ? '\\%' : text[m];
      kept += b - a;
      at = b;
    }
    lines.latex.set(node, out + escapeLatex(text.slice(at, to)));
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
 */
interface Ctx { bold: boolean; italic: boolean; heading: boolean; wrapped: boolean; url: boolean; lines: Lines }

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

function convertChildren(node: Node, ctx: Ctx): string {
  let out = '';
  node.childNodes.forEach((child) => { out += convertNode(child, ctx); });
  return out;
}

function convertTable(el: Element, ctx: Ctx): string {
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

function convertNode(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return ctx.lines.latex.get(node) ?? escapeLatex((node.textContent || '').replace(/\s+/g, ' '));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
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
    case 'style': case 'script': case 'head': case 'meta': case 'title': return '';
    default: {
      const bold = styledBold(el) ?? (tag === 'b' || tag === 'strong' ? true : null);
      const italic = styledItalic(el) ?? (tag === 'i' || tag === 'em' ? true : null);
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
 * address as escaped text. LaTeX the text spells out (latexRuns) stays as
 * written, and the prose around it is escaped.
 */
export function htmlToLatex(html: string, opts: { url?: boolean } = {}): string {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  return convertNode(dom.body, { bold: false, italic: false, heading: false, wrapped: false, url: opts.url ?? false, lines: readLines(dom.body) })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
