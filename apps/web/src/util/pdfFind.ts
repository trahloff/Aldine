/**
 * Find in the typeset PDF. A page's text is the strings pdf.js extracts, one
 * per text item, the runs its text layer draws as spans; a match is found
 * without case or accents, across line ends and across the hyphen TeX breaks
 * a word with, and named back as spans of those strings.
 */

/** A text item as Find reads it. */
export interface TextRun { str: string; hasEOL: boolean }

/** A page's text folded for matching, and where each of its characters came from. */
export interface PageText {
  /** One space for each run of whitespace, a newline at each line end. */
  text: string;
  /** Per character of `text`: the item it came from, and the span of that
   *  item's string it was folded from. */
  item: number[];
  from: number[];
  to: number[];
  /** Each item's string length. */
  lengths: number[];
}

/** A span of one item's string. */
export interface TextRange { item: number; from: number; to: number }

/** A match on a page (1-based): the item spans it covers, in order. */
export interface Match { page: number; ranges: TextRange[] }

/** Characters as Find compares them: ligatures and other compatibility forms
 *  spelled out, accents dropped. Case is the pattern's. */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '');
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || (c > '\u007f' && /\s/u.test(c));

export function pageText(runs: readonly TextRun[]): PageText {
  const out: string[] = [], item: number[] = [], from: number[] = [], to: number[] = [];
  const lengths: number[] = [];
  const push = (c: string, k: number, a: number, b: number) => { out.push(c); item.push(k); from.push(a); to.push(b); };
  // Starts as a line end, so whitespace before the first word is dropped.
  let last = '\n';
  runs.forEach((run, k) => {
    lengths.push(run.str.length);
    let a = 0;
    for (const ch of run.str) {
      const b = a + ch.length;
      for (const c of ch < '\u0080' ? ch : fold(ch)) {
        if (isSpace(c)) {
          if (last !== ' ' && last !== '\n') { push(' ', k, a, b); last = ' '; }
        } else {
          push(c, k, a, b);
          last = c;
        }
      }
      a = b;
    }
    if (run.hasEOL) {
      if (last === ' ') out[out.length - 1] = '\n';
      else if (last !== '\n') push('\n', k, run.str.length, run.str.length);
      last = '\n';
    }
  });
  return { text: out.join(''), item, from, to, lengths };
}

const SYNTAX = /[\\^$.*+?()[\]{}|/]/g;

/**
 * The pattern for `query` over a PageText, null for a query of only
 * whitespace. Any whitespace matches any other, a line end included; between
 * two letters a hyphen at a line end may stand (exam-ple), and after a
 * typed hyphen the line may end (well-known).
 */
export function findPattern(query: string): RegExp | null {
  const q = [...fold(query).trim().replace(/\s+/g, ' ')];
  if (!q.length) return null;
  let src = '';
  q.forEach((c, n) => {
    const prev = q[n - 1];
    if (n && prev !== ' ' && c !== ' ') src += prev === '-' ? '\\n?' : '(?:-\\n)?';
    src += c === ' ' ? '\\s' : c.replace(SYNTAX, '\\$&');
  });
  return new RegExp(src, 'giu');
}

/** The item spans of `text[start, end)`. */
export function rangesOf(p: PageText, start: number, end: number): TextRange[] {
  const first = p.item[start], last = p.item[end - 1];
  const a = p.from[start], b = p.to[end - 1];
  if (first === last) return [{ item: first, from: a, to: b }];
  const out: TextRange[] = [{ item: first, from: a, to: p.lengths[first] }];
  for (let k = first + 1; k < last; k++) if (p.lengths[k]) out.push({ item: k, from: 0, to: p.lengths[k] });
  out.push({ item: last, from: 0, to: b });
  return out.filter((r) => r.to > r.from);
}

/** Every match of `query` in `pages` (page 1 first), in reading order. */
export function findMatches(pages: readonly PageText[], query: string): Match[] {
  const re = findPattern(query);
  if (!re) return [];
  const out: Match[] = [];
  pages.forEach((p, i) => {
    re.lastIndex = 0;
    for (let m = re.exec(p.text); m; m = re.exec(p.text)) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out.push({ page: i + 1, ranges: rangesOf(p, m.index, m.index + m[0].length) });
    }
  });
  return out;
}

/** What the find bar's count says: nothing before a query, then the match
 *  on screen and how many there are. */
export function findCount(query: string, total: number | null, current: number): string {
  if (!query.trim()) return '';
  if (total == null) return 'Searching…';
  if (!total) return 'No matches';
  return `${Math.max(0, current) + 1} of ${total}`;
}
