import { vi } from 'vitest';

/**
 * Just enough of the DOM for html2latex in Node, where vitest runs without
 * one: elements, text, attributes, inline styles and tag-name selectors.
 * Markup is taken as written, so fixtures close every tag they open (no
 * implied end tags, no foster parenting); void elements need no end tag.
 */
const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

class MiniText {
  readonly nodeType = 3;
  constructor(readonly textContent: string) {}
}

class MiniElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: Array<MiniElement | MiniText> = [];
  readonly style: Record<string, string> = {};

  constructor(tag: string, private readonly attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    for (const decl of (attrs.style ?? '').split(';')) {
      const [prop, ...value] = decl.split(':');
      if (!prop.trim() || !value.length) continue;
      this.style[prop.trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value.join(':').trim();
    }
  }

  get children(): MiniElement[] {
    return this.childNodes.filter((c): c is MiniElement => c instanceof MiniElement);
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  /** `sel`: tag names, comma-separated. */
  querySelectorAll(sel: string): MiniElement[] {
    const names = new Set(sel.split(',').map((s) => s.trim().toUpperCase()));
    const out: MiniElement[] = [];
    const visit = (el: MiniElement) => {
      for (const c of el.children) {
        if (names.has(c.tagName)) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }

  querySelector(sel: string): MiniElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

function parse(html: string): MiniElement {
  const body = new MiniElement('body');
  const stack = [body];
  const token = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|[^<]+|</gi;
  for (const m of html.matchAll(token)) {
    const top = stack[stack.length - 1];
    const [whole, close, open, attrText] = m;
    if (close) {
      const i = stack.map((e) => e.tagName).lastIndexOf(close.toUpperCase());
      if (i > 0) stack.length = i;
    } else if (open) {
      const attrs: Record<string, string> = {};
      for (const a of (attrText ?? '').matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      }
      const el = new MiniElement(open, attrs);
      top.childNodes.push(el);
      if (!VOID.has(open.toLowerCase())) stack.push(el);
    } else if (!whole.startsWith('<!')) {
      top.childNodes.push(new MiniText(decode(whole)));
    }
  }
  return body;
}

/** Puts DOMParser and Node on globalThis for the code under test. */
export function installMiniDom(): void {
  vi.stubGlobal('Node', { ELEMENT_NODE: 1, TEXT_NODE: 3 });
  vi.stubGlobal('DOMParser', class {
    parseFromString(html: string) {
      return { body: parse(html) };
    }
  });
}
