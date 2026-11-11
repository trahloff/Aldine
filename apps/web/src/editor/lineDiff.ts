/**
 * Line-level difference between a file's baseline and the text in the
 * editor, as the hunks the change marks show: `add` lines that are new,
 * `mod` lines that replaced others, `del` a point where lines were removed.
 * Line numbers are the editor's (1-based); a `del` sits before line `from`,
 * which is one past the last line when the removal was at the end.
 */
export type HunkKind = 'add' | 'mod' | 'del';

export interface Hunk {
  kind: HunkKind;
  /** First and last line in the new text; for `del`, from === to. */
  from: number;
  to: number;
  /** The baseline's lines this hunk replaced or removed ([] for `add`). */
  old: string[];
}

/** Lines as CodeMirror counts them: "a\n" is two, the second empty. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Line edits past which the changed middle is one `mod` hunk: the search is
 *  O((N+M)·D) on the main thread. */
const MAX_EDITS = 2000;

/** a[i] matched with b[j] for every pair Myers keeps, in order; null past maxD. */
function matchLines(a: Int32Array, b: Int32Array, maxD: number): Array<[number, number]> | null {
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

/** The hunks turning `before` into `after`, ascending. */
export function diffLines(before: string[], after: string[], maxEdits = MAX_EDITS): Hunk[] {
  // Most edits are local: the common start and end never reach the search.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const aEnd = before.length - end, bEnd = after.length - end;
  if (start === aEnd && start === bEnd) return [];

  const ids = new Map<string, number>();
  const intern = (lines: string[], from: number, to: number) => {
    const out = new Int32Array(to - from);
    for (let i = from; i < to; i++) {
      let id = ids.get(lines[i]);
      if (id === undefined) { id = ids.size; ids.set(lines[i], id); }
      out[i - from] = id;
    }
    return out;
  };
  const pairs = matchLines(intern(before, start, aEnd), intern(after, start, bEnd), maxEdits) ?? [];

  const hunks: Hunk[] = [];
  let i = start, j = start;
  const gap = (ai: number, bj: number) => {
    if (ai === i && bj === j) return;
    const old = before.slice(i, ai);
    if (bj === j) hunks.push({ kind: 'del', from: j + 1, to: j + 1, old });
    else hunks.push({ kind: ai === i ? 'add' : 'mod', from: j + 1, to: bj, old });
  };
  for (const [pa, pb] of pairs) {
    gap(pa + start, pb + start);
    i = pa + start + 1;
    j = pb + start + 1;
  }
  gap(aEnd, bEnd);
  return hunks;
}
