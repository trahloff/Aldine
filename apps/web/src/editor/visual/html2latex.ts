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

function isBlock(el: Element): boolean {
  return /^(p|div|h[1-6]|ul|ol|li|table|tr|blockquote|br|section|article)$/i.test(el.tagName);
}

function convertChildren(node: Node): string {
  let out = '';
  node.childNodes.forEach((child) => { out += convertNode(child); });
  return out;
}

function convertTable(el: Element): string {
  const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td,th')).map((td) => convertChildren(td).trim().replace(/\n+/g, ' ')),
  ).filter((r) => r.length);
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const body = rows.map((r) => {
    while (r.length < cols) r.push('');
    return `${r.join(' & ')} \\\\`;
  }).join('\n');
  return `\n\\begin{tabular}{${'l'.repeat(cols)}}\n${body}\n\\end{tabular}\n`;
}

function convertList(el: Element, ordered: boolean): string {
  const items = Array.from(el.children)
    .filter((c) => c.tagName.toLowerCase() === 'li')
    .map((li) => `\\item ${convertChildren(li).trim()}`);
  if (!items.length) return '';
  const env = ordered ? 'enumerate' : 'itemize';
  return `\n\\begin{${env}}\n${items.join('\n')}\n\\end{${env}}\n`;
}

function convertNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeLatex((node.textContent || '').replace(/\s+/g, ' '));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'b': case 'strong': {
      const inner = convertChildren(el).trim();
      return inner ? `\\textbf{${inner}}` : '';
    }
    case 'i': case 'em': {
      const inner = convertChildren(el).trim();
      return inner ? `\\textit{${inner}}` : '';
    }
    case 'u': {
      const inner = convertChildren(el).trim();
      return inner ? `\\underline{${inner}}` : '';
    }
    case 'code': case 'tt': {
      const inner = convertChildren(el).trim();
      return inner ? `\\texttt{${inner}}` : '';
    }
    case 'h1': return `\n\\section{${convertChildren(el).trim()}}\n`;
    case 'h2': return `\n\\subsection{${convertChildren(el).trim()}}\n`;
    case 'h3': case 'h4': case 'h5': case 'h6':
      return `\n\\subsubsection{${convertChildren(el).trim()}}\n`;
    case 'a': {
      const href = el.getAttribute('href');
      const inner = convertChildren(el).trim();
      if (!href || href.startsWith('#') || href === inner) return inner ? `\\url{${href ?? inner}}` : '';
      // Never \href: it exists only under hyperref, which many classes (incl.
      // plain article setups) don't load — one pasted link then kills the
      // compile. \url (url/xurl, pulled in far more widely) plus the link text.
      return `${inner} (\\url{${href}})`;
    }
    case 'ul': return convertList(el, false);
    case 'ol': return convertList(el, true);
    case 'table': return convertTable(el);
    case 'br': return '\n';
    case 'style': case 'script': case 'head': case 'meta': case 'title': return '';
    default: {
      const inner = convertChildren(el);
      return isBlock(el) ? `${inner.replace(/\s+$/, '')}\n\n` : inner;
    }
  }
}

export function htmlToLatex(html: string): string {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  return convertNode(dom.body)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
