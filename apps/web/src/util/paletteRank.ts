/**
 * How the command palette matches and orders what is typed. Only the title
 * (and a command's own keywords) is searched, never its section heading, so
 * "op" does not match every row under "Open". Lower scores rank higher.
 */

export interface Rankable { title: string; group?: string; keywords?: string }
export interface Section<T> { group: string; items: T[] }

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
const isWordStart = (t: string, i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(t[i - 1]);

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
  const at = t.indexOf(q);
  if (at >= 0) return (isWordStart(t, at) ? 0 : 10) + at / 1000;
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
  if (s !== null) return s;
  const k = keywords ? textScore(q, keywords) : null;
  return k === null ? null : 50 + k;
}

/**
 * Matching commands in sections. A section ranks by its best match; on a tie
 * (always, before anything is typed) `groupOrder` decides, then the order in
 * which sections first appear. Within a section, the better match first.
 */
export function rankCommands<T extends Rankable>(commands: readonly T[], query: string, groupOrder: readonly string[] = [], limit = 60): Section<T>[] {
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
  const out: Section<T>[] = [];
  let left = limit;
  for (const [group, g] of ordered) {
    if (left <= 0) break;
    const items = g.rows.sort((a, b) => (a.score - b.score) || (a.i - b.i)).slice(0, left).map((r) => r.c);
    left -= items.length;
    out.push({ group, items });
  }
  return out;
}
