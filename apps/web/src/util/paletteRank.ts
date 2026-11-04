/**
 * How the command palette matches and orders what is typed. Only the title
 * (and a command's own keywords) is searched, never its section heading, so
 * "op" does not match every row under "Open". Lower scores rank higher: a
 * whole word of the title, then a whole keyword, then the start of a word in
 * the title ("compile" is Typeset's keyword before it is the start of
 * "compiler" in Project settings).
 */

export interface Rankable { title: string; group?: string; keywords?: string }
export interface Section<T> { group: string; items: T[] }

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
const isWordStart = (t: string, i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(t[i - 1]);
const isWordEnd = (t: string, i: number) => i >= t.length || !/[\p{L}\p{N}]/u.test(t[i]);
/** A whole word of the title scores under 1 (its offset / 1000), a whole
 *  keyword 1, the start of a title word from 2. */
const WHOLE_KEYWORD = 1;
const WORD_PREFIX = 2;

/** The sum of the gaps of the tightest in-order match that starts at a word, or null. */
function subsequence(q: string, t: string): number | null {
  let best: number | null = null;
  for (let start = t.indexOf(q[0]); start >= 0; start = t.indexOf(q[0], start + 1)) {
    if (!isWordStart(t, start)) continue;
    let gaps = 0;
    let at = start;
    let ok = true;
    for (let k = 1; k < q.length; k++) {
      const next = t.indexOf(q[k], at + 1);
      if (next < 0) { ok = false; break; }
      gaps += next - at - 1;
      at = next;
    }
    if (ok && (best === null || gaps < best)) best = gaps;
  }
  return best;
}

function textScore(q: string, text: string): number | null {
  const t = fold(text);
  let best: number | null = null;
  for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + 1)) {
    const s = (isWordStart(t, at) ? (isWordEnd(t, at + q.length) ? 0 : WORD_PREFIX) : 10) + at / 1000;
    if (best === null || s < best) best = s;
  }
  if (best !== null) return best;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 20 + words.reduce((n, w) => n + t.indexOf(w), 0) / 1000;
  const compact = q.replace(/\s+/g, '');
  const gaps = compact ? subsequence(compact, t) : null;
  return gaps === null ? null : 100 + gaps;
}

/** How well `query` matches: 0 for nothing typed, null for no match. */
export function matchScore(query: string, title: string, keywords?: string): number | null {
  const q = fold(query.trim());
  if (!q) return 0;
  const s = textScore(q, title);
  const k = keywords ? textScore(q, keywords) : null;
  const viaKeyword = k === null ? null : k < 1 ? WHOLE_KEYWORD : 50 + k;
  if (s === null) return viaKeyword;
  return viaKeyword === null ? s : Math.min(s, viaKeyword);
}

/**
 * Matching commands in sections. A section ranks by its best match; on a tie
 * (always, before anything is typed) `groupOrder` decides, then the order in
 * which sections first appear. Within a section, the better match first.
 *
 * At most `limit` rows in all, and every section keeps a few of them, so a
 * long first section cannot push the others out. Before anything is typed a
 * section shows at most `idleSectionLimit` rows.
 */
export function rankCommands<T extends Rankable>(
  commands: readonly T[],
  query: string,
  groupOrder: readonly string[] = [],
  limit = 60,
  idleSectionLimit = Infinity,
): Section<T>[] {
  const groups = new Map<string, { best: number; first: number; rows: { c: T; score: number; i: number }[] }>();
  commands.forEach((c, i) => {
    const score = matchScore(query, c.title, c.keywords);
    if (score === null) return;
    const name = c.group ?? '';
    const g = groups.get(name) ?? { best: Infinity, first: i, rows: [] };
    g.best = Math.min(g.best, score);
    g.rows.push({ c, score, i });
    groups.set(name, g);
  });
  const rank = (name: string) => { const at = groupOrder.indexOf(name); return at < 0 ? Infinity : at; };
  const ordered = [...groups.entries()].sort(([an, a], [bn, b]) => (a.best - b.best) || (rank(an) - rank(bn)) || (a.first - b.first));
  const idle = !query.trim();
  const sections = ordered.map(([group, g]) => ({
    group,
    rows: g.rows.sort((a, b) => (a.score - b.score) || (a.i - b.i)).slice(0, idle ? idleSectionLimit : undefined).map((r) => r.c),
  }));
  const floor = sections.length ? Math.min(3, Math.floor(limit / sections.length)) : 0;
  const kept = sections.map((s) => Math.min(s.rows.length, floor));
  let left = limit - kept.reduce((n, k) => n + k, 0);
  const out: Section<T>[] = [];
  sections.forEach((s, n) => {
    const extra = Math.min(s.rows.length - kept[n], left);
    left -= extra;
    const items = s.rows.slice(0, kept[n] + extra);
    if (items.length) out.push({ group: s.group, items });
  });
  return out;
}
