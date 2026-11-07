/**
 * The spans that turn one text into another, for putting new file content
 * into a live Y.Text without replacing it: only the changed spans are
 * deleted and inserted, so a collaborator's cursor, selection and pending
 * keystrokes outside them stay where they were.
 *
 * Lines are matched first (Myers), then each changed run of lines is cut to
 * the characters that differ.
 */

/** A replacement of a[from, to) by `insert`, in the old text's offsets. */
export interface TextSpan { from: number; to: number; insert: string }

/** Line edit distance past which the changed region becomes one span: the
 *  search is O((N+M)·D) on the server's event loop. */
const MAX_LINE_EDITS = 500;

/** Lines with their newline, so joining them gives the text back. */
function splitLines(s: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < s.length) {
    const nl = s.indexOf('\n', at);
    const end = nl === -1 ? s.length : nl + 1;
    out.push(s.slice(at, end));
    at = end;
  }
  return out;
}

/** a[i] matched with b[j] for every pair Myers keeps, in order; null past the cap. */
function matchLines(a: number[], b: number[], maxD: number): Array<[number, number]> | null {
  const n = a.length, m = b.length, max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer:
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break outer; }
    }
  }
  const pairs: Array<[number, number]> = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const t = trace[d];
    const at = (k: number) => t[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { pairs.push([x - 1, y - 1]); x--; y--; }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { pairs.push([x - 1, y - 1]); x--; y--; }
  return pairs.reverse();
}

/** `insert` replacing a[from, to), cut to where the two differ; null when they do not. */
function trimmed(a: string, from: number, to: number, insert: string): TextSpan | null {
  let p = 0;
  const max = Math.min(to - from, insert.length);
  while (p < max && a.charCodeAt(from + p) === insert.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(to - 1 - s) === insert.charCodeAt(insert.length - 1 - s)) s++;
  if (p === to - from && p === insert.length) return null;
  return { from: from + p, to: to - s, insert: insert.slice(p, insert.length - s) };
}

/** The spans turning `a` into `b`, ascending and disjoint, in `a`'s offsets. */
export function diffSpans(a: string, b: string): TextSpan[] {
  if (a === b) return [];
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  const whole = (): TextSpan[] => [{ from: p, to: a.length - s, insert: b.slice(p, b.length - s) }];
  if (p === a.length - s || p === b.length - s) return whole();
  // The middle widened to whole lines, which both texts share outside it.
  const start = p === 0 ? 0 : a.lastIndexOf('\n', p - 1) + 1;
  const nl = a.indexOf('\n', a.length - s);
  const tail = nl === -1 ? 0 : a.length - (nl + 1);
  const aLines = splitLines(a.slice(start, a.length - tail));
  const bLines = splitLines(b.slice(start, b.length - tail));
  const ids = new Map<string, number>();
  const id = (l: string) => { let v = ids.get(l); if (v === undefined) { v = ids.size; ids.set(l, v); } return v; };
  const pairs = matchLines(aLines.map(id), bLines.map(id), MAX_LINE_EDITS);
  if (!pairs) return whole();
  const spans: TextSpan[] = [];
  let i = 0, j = 0, aAt = start;
  const flush = (toI: number, toJ: number) => {
    let len = 0;
    for (let x = i; x < toI; x++) len += aLines[x].length;
    if (toI > i || toJ > j) {
      const span = trimmed(a, aAt, aAt + len, bLines.slice(j, toJ).join(''));
      if (span) spans.push(span);
    }
    aAt += len;
  };
  for (const [mi, mj] of pairs) {
    flush(mi, mj);
    aAt += aLines[mi].length;
    i = mi + 1;
    j = mj + 1;
  }
  flush(aLines.length, bLines.length);
  return spans;
}

/** `a` with `spans` applied: what a Y.Text holding `a` reads after them. */
export function applySpans(a: string, spans: TextSpan[]): string {
  let out = '';
  let at = 0;
  for (const s of spans) { out += a.slice(at, s.from) + s.insert; at = s.to; }
  return out + a.slice(at);
}
