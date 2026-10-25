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

const BLOCK_TAGS = 'p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,table,tr,blockquote,section,article';

function isBlock(el: Element): boolean {
  return /^(p|div|h[1-6]|ul|ol|li|table|tr|blockquote|br|section|article)$/i.test(el.tagName);
}

/** Formatting already applied by an enclosing command, so nested runs don't repeat it. */
interface Ctx { bold: boolean; italic: boolean; heading: boolean }
const PLAIN: Ctx = { bold: false, italic: false, heading: false };

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

function convertList(el: Element, ordered: boolean, ctx: Ctx): string {
  const items = Array.from(el.children)
    .filter((c) => c.tagName.toLowerCase() === 'li')
    .map((li) => `\\item ${convertChildren(li, ctx).trim()}`);
  if (!items.length) return '';
  const env = ordered ? 'enumerate' : 'itemize';
  return `\n\\begin{${env}}\n${items.join('\n')}\n\\end{${env}}\n`;
}

function heading(cmd: string, el: Element, ctx: Ctx): string {
  return `\n\\${cmd}{${convertChildren(el, { ...ctx, heading: true }).trim()}}\n`;
}

function convertNode(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeLatex((node.textContent || '').replace(/\s+/g, ' '));
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
      if (!inner || (el.textContent || '').trim() === href) return `\\url{${href}}`;
      // Never \href: it exists only under hyperref, which many classes (incl.
      // plain article setups) don't load — one pasted link then kills the
      // compile. \url (url/xurl, pulled in far more widely) plus the link text.
      return `${inner} (\\url{${href}})`;
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
      let inner = convertChildren(el, next);
      if (wrappers.length) {
        const text = inner.trim();
        if (!text) return '';
        // keep the run's outer spaces outside the braces
        const lead = /^\s/.test(inner) ? ' ' : '';
        const trail = /\s$/.test(inner) ? ' ' : '';
        inner = lead + wrappers.reduceRight((acc, cmd) => `\\${cmd}{${acc}}`, text) + trail;
      }
      return isBlock(el) ? `${inner.replace(/\s+$/, '')}\n\n` : inner;
    }
  }
}

export function htmlToLatex(html: string): string {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  return convertNode(dom.body, PLAIN)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
