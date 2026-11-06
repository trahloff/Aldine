/** A piece of a changed line: `changed` when the other side does not have it. */
export interface Segment { text: string; changed: boolean }

/** Words, runs of white space, and every other character on its own: `\emph{x}` is `\`, `emph`, `{`, `x`, `}`. */
export function tokenize(s: string): string[] {
  return s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

/** Adjacent pieces of one kind become one. */
function join(tokens: Array<{ t: string; changed: boolean }>): Segment[] {
  const out: Segment[] = [];
  for (const { t, changed } of tokens) {
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += t;
    else out.push({ text: t, changed });
  }
  return out;
}

/** Past this many table cells the middle of the pair counts as one change. */
const MAX_CELLS = 250_000;
/** Below this share of unchanged text the two lines are a rewrite, not an edit. */
const MIN_KEPT = 0.25;

/**
 * Word-level difference between a removed line and the line that replaced
 * it, for highlighting inside a line diff: the common start and end are cut
 * first, the middle goes through a longest-common-subsequence table. Null
 * when the lines have too little in common for highlights to help.
 */
export function diffWords(before: string, after: string): { del: Segment[]; add: Segment[] } | null {
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const am = a.slice(start, a.length - end);
  const bm = b.slice(start, b.length - end);
  const keptA = new Array<boolean>(am.length).fill(false);
  const keptB = new Array<boolean>(bm.length).fill(false);
  if (am.length && bm.length && am.length * bm.length <= MAX_CELLS) {
    const n = am.length, m = bm.length;
    // lcs[i][j]: the longest common run of am[i..] and bm[j..], in one flat array
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] = am[i] === bm[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { keptA[i++] = true; keptB[j++] = true; }
      else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) i++;
      else j++;
    }
  }
  // White space alone is no common ground: "a b" and "c d" share a space.
  const solid = (tokens: string[], kept: boolean[]) => tokens.reduce((n, t, k) => n + (kept[k] && /\S/.test(t) ? t.length : 0), 0);
  const edge = [...a.slice(0, start), ...a.slice(a.length - end)].reduce((n, t) => n + (/\S/.test(t) ? t.length : 0), 0);
  const longest = Math.max(before.replace(/\s/g, '').length, after.replace(/\s/g, '').length);
  if (longest === 0 || (edge + solid(am, keptA)) / longest < MIN_KEPT) return null;
  const side = (all: string[], mid: string[], kept: boolean[]) => join([
    ...all.slice(0, start).map((t) => ({ t, changed: false })),
    ...mid.map((t, k) => ({ t, changed: !kept[k] })),
    ...all.slice(all.length - end).map((t) => ({ t, changed: false })),
  ]);
  return { del: side(a, am, keptA), add: side(b, bm, keptB) };
}
