import { pokeViews } from './refresh';

/**
 * Lazy KaTeX: loaded (with its CSS) only when visual mode first renders math,
 * as its own Vite chunk — the source-mode bundle is untouched. Until the
 * module arrives, math widgets show styled raw source; registered views get a
 * re-measure poke when rendering becomes available.
 */
type Katex = typeof import('katex').default;

let katex: Katex | null = null;
let loading: Promise<void> | null = null;

export function ensureKatex(): void {
  if (katex || loading) return;
  // @ts-expect-error -- CSS import is handled by Vite, not TS
  loading = Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([mod]) => {
      katex = mod.default;
      pokeViews(); // the widgets drawn so far are raw source; this redraws them
    })
    .catch(() => { loading = null; });
}

/** False until the chunk has arrived: a math widget drawn before that shows raw source. */
export function katexReady(): boolean {
  return katex !== null;
}

const cache = new Map<string, string>();
const CACHE_MAX = 500;

/** Rendered HTML for a math source, or null while KaTeX is still loading. */
export function renderMath(source: string, displayMode: boolean): string | null {
  if (!katex) { ensureKatex(); return null; }
  const key = `${displayMode ? 'D' : 'I'}:${source}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    // \label{} and \tag-less refs are invisible in real typeset output; KaTeX
    // would render them as red fallback text, so strip them (rendering only —
    // the source is never touched).
    const cleaned = source.replace(/\\label\s*\{[^}]*\}/g, '');
    // MathML is what screen readers read; KaTeX hides its HTML copy from them
    html = katex.renderToString(cleaned, { displayMode, throwOnError: false, output: 'htmlAndMathml' });
  } catch {
    return ''; // signals render failure → widget falls back to raw source
  }
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, html);
  return html;
}
