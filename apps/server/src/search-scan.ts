// Runs in a worker as well as in the main thread, so this file stays
// worker-safe: no relative imports and erasable TypeScript only (no enums,
// namespaces or parameter properties). Under tsx the worker loads it through
// Node's own type stripping, without tsx's hooks, and a relative import or a
// non-erasable construct fails there while working everywhere else.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

export interface SearchOptions { caseSensitive: boolean; wholeWord: boolean; regex: boolean }

export interface ScanLimits {
  /** Matches reported; one past it sets `truncated: 'matches'`. */
  maxMatches: number;
  /** Sum of the scanned texts' lengths; a file that would pass it is not scanned. */
  maxScanUnits: number;
  /** A longer match is counted in `longMatches`, never reported. */
  maxMatchUnits: number;
  /** A file whose text after the replacement would pass it stops the scan. */
  maxResultUnits: number;
}

export interface ScanInput { path: string; text: string; open?: boolean }

export interface ScanMatch {
  from: number;
  to: number;
  line: number;
  column: number;
  text: string;
  preview: { text: string; start: number; end: number };
  /** Only when the scan was asked for a replacement. */
  replacement?: string;
}

export interface ScanFileResult { path: string; open: boolean; matches: ScanMatch[] }

export interface ScanResult {
  files: ScanFileResult[];
  total: number;
  truncated: null | 'matches' | 'bytes';
  longMatches: number;
  /** The first file whose replaced text would pass maxResultUnits. */
  tooLarge?: string;
}

/** Literal and regex replacements; `template` is expanded per match only in regex mode. */
export interface ScanReplace { template: string; regex: boolean }

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const BEFORE_WORD = '(?<![\\p{L}\\p{N}_])';
const AFTER_WORD = '(?![\\p{L}\\p{N}_])';
// A regex's edge characters are only known per match: an edge that is not a
// word character needs no boundary, the same rule literal mode applies to
// the query's own first and last character.
const REGEX_BEFORE_WORD = '(?:(?<![\\p{L}\\p{N}_])|(?![\\p{L}\\p{N}_]))';
const REGEX_AFTER_WORD = '(?:(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_]))';

export function escapeLiteral(q: string): string {
  return q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The query as a RegExp. Always `g`, `m` and `u`; `i` unless match case is
 * on. Whole word uses Unicode lookarounds because ASCII `\b` splits "Müller";
 * a side needs its boundary only when the match's own first or last
 * character is a word character, so `\cite` matches in `a\cite{` and not in
 * `\citep`, in either mode. A user regex is compiled on its own first, so a
 * syntax error names the user's pattern rather than the wrapper, then
 * wrapped in a non-capturing group that keeps its group numbers.
 */
export function buildPattern(q: string, opts: SearchOptions): RegExp {
  const flags = opts.caseSensitive ? 'gmu' : 'gimu';
  let src: string;
  if (opts.regex) {
    new RegExp(q, flags);
    src = opts.wholeWord ? `${REGEX_BEFORE_WORD}(?:${q})${REGEX_AFTER_WORD}` : q;
  } else {
    src = escapeLiteral(q);
    if (opts.wholeWord) {
      const chars = Array.from(q);
      if (chars.length && WORD_CHAR.test(chars[0])) src = BEFORE_WORD + src;
      if (chars.length && WORD_CHAR.test(chars[chars.length - 1])) src = src + AFTER_WORD;
    }
  }
  return new RegExp(src, flags);
}

/** Offsets at which each line starts; line 1 starts at 0. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line and column of `offset` (columns count UTF-16 units). */
export function locate(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

const PREVIEW_UNITS = 120;
const PREVIEW_BEFORE = 40;
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * The match's line without its line break, cut to PREVIEW_UNITS with up to
 * PREVIEW_BEFORE of them before the match. A cut end gets "…" and never
 * splits a surrogate pair. `start`/`end` index into `text`; `end` stops at
 * the line end for a match that runs onto the next line.
 */
export function previewOf(text: string, starts: number[], line: number, from: number, to: number): { text: string; start: number; end: number } {
  const lineStart = starts[line - 1];
  let lineEnd = line < starts.length ? starts[line] - 1 : text.length;
  if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd--;
  const lineText = text.slice(lineStart, lineEnd);
  const mStart = Math.min(from - lineStart, lineText.length);
  const mEnd = Math.min(to - lineStart, lineText.length);
  let cutStart = Math.max(0, mStart - PREVIEW_BEFORE);
  if (cutStart > 0 && isLow(lineText.charCodeAt(cutStart))) cutStart++;
  let cutEnd = Math.min(lineText.length, cutStart + PREVIEW_UNITS);
  if (cutEnd < lineText.length && isHigh(lineText.charCodeAt(cutEnd - 1))) cutEnd--;
  const head = cutStart > 0 ? '…' : '';
  const tail = cutEnd < lineText.length ? '…' : '';
  return {
    text: head + lineText.slice(cutStart, cutEnd) + tail,
    start: Math.min(mStart, cutEnd) - cutStart + head.length,
    end: Math.min(mEnd, cutEnd) - cutStart + head.length,
  };
}

/**
 * A regex replacement with the JS rules for `$1`–`$99`, `$<name>`, `$&` and
 * `$$`; a `$n` naming a group that does not exist stays literal. `` $` ``
 * and `$'` stay literal on purpose: each copies the whole rest of the file
 * once per match.
 */
export function expandReplacement(template: string, m: RegExpExecArray): string {
  if (!template.includes('$')) return template;
  const groups = m.length - 1;
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c !== '$' || i + 1 >= template.length) { out += c; continue; }
    const n = template[i + 1];
    if (n === '$') { out += '$'; i++; continue; }
    if (n === '&') { out += m[0]; i++; continue; }
    if (n >= '0' && n <= '9') {
      const d1 = n.charCodeAt(0) - 48;
      const n2 = template[i + 2];
      const two = n2 !== undefined && n2 >= '0' && n2 <= '9' ? d1 * 10 + (n2.charCodeAt(0) - 48) : -1;
      if (two >= 1 && two <= groups) { out += m[two] ?? ''; i += 2; continue; }
      if (d1 >= 1 && d1 <= groups) { out += m[d1] ?? ''; i++; continue; }
      out += c;
      continue;
    }
    if (n === '<' && m.groups) {
      const close = template.indexOf('>', i + 2);
      if (close !== -1) {
        out += m.groups[template.slice(i + 2, close)] ?? '';
        i = close;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * Every match of `pattern` in `files`, in order. Empty matches are never
 * reported (`^`, `a*`): the scan steps one code point past them. Line and
 * column belong to a match's start.
 */
export function scanFiles(files: ScanInput[], pattern: RegExp, limits: ScanLimits, replace?: ScanReplace): ScanResult {
  const out: ScanFileResult[] = [];
  let total = 0;
  let scanned = 0;
  let longMatches = 0;
  let truncated: ScanResult['truncated'] = null;
  let tooLarge: string | undefined;
  const re = new RegExp(pattern.source, pattern.flags);
  scan: for (const f of files) {
    if (scanned + f.text.length > limits.maxScanUnits) { truncated = 'bytes'; break; }
    scanned += f.text.length;
    const text = f.text;
    let starts: number[] | null = null;
    let size = text.length;
    const matches: ScanMatch[] = [];
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const from = m.index;
      const len = m[0].length;
      if (len === 0) {
        re.lastIndex = from + (isHigh(text.charCodeAt(from)) && isLow(text.charCodeAt(from + 1)) ? 2 : 1);
        if (re.lastIndex > text.length) break;
        continue;
      }
      if (len > limits.maxMatchUnits) { longMatches++; continue; }
      if (total >= limits.maxMatches) { truncated = 'matches'; if (matches.length) out.push({ path: f.path, open: !!f.open, matches }); break scan; }
      starts ??= lineStarts(text);
      const { line, column } = locate(starts, from);
      const match: ScanMatch = { from, to: from + len, line, column, text: m[0], preview: previewOf(text, starts, line, from, from + len) };
      if (replace) {
        match.replacement = replace.regex ? expandReplacement(replace.template, m) : replace.template;
        size += match.replacement.length - len;
        if (size > limits.maxResultUnits) { tooLarge = f.path; break scan; }
      }
      matches.push(match);
      total++;
    }
    if (matches.length) out.push({ path: f.path, open: !!f.open, matches });
  }
  return { files: out, total, truncated, longMatches, ...(tooLarge ? { tooLarge } : {}) };
}

export interface RebaseResult<M> { kept: M[]; skipped: number }

/**
 * Carry matches found in `snap` over to `cur`, the same file a little later.
 * The common prefix and suffix of the two texts bound the one region that
 * changed: a match wholly before it keeps its offsets, one wholly after it
 * moves by the length difference, and one that touches it is dropped —
 * adjacency counts, since text typed against a word changes whether it is
 * still a whole word. Survivors are checked against `cur` once more.
 */
export function rebaseMatches<M extends { from: number; to: number; text: string }>(snap: string, cur: string, matches: M[]): RebaseResult<M> {
  if (snap === cur) return { kept: matches.slice(), skipped: 0 };
  const max = Math.min(snap.length, cur.length);
  let pre = 0;
  while (pre < max && snap.charCodeAt(pre) === cur.charCodeAt(pre)) pre++;
  let suf = 0;
  while (suf < max - pre && snap.charCodeAt(snap.length - 1 - suf) === cur.charCodeAt(cur.length - 1 - suf)) suf++;
  const snapEnd = snap.length - suf;
  const delta = cur.length - snap.length;
  const kept: M[] = [];
  let skipped = 0;
  for (const m of matches) {
    let moved: M | null = null;
    if (m.to < pre) moved = m;
    else if (m.from > snapEnd) moved = { ...m, from: m.from + delta, to: m.to + delta };
    if (moved && cur.slice(moved.from, moved.to) === moved.text) kept.push(moved);
    else skipped++;
  }
  return { kept, skipped };
}

/** The match a Replace (one) click means, as the search showed it. */
export interface MatchTarget {
  text: string;
  preview: { text: string; start: number; end: number };
  /** Its place among the file's matches of the same text, and how many of those there were. */
  ordinal: number;
  count: number;
  /** How many of those had this very preview, itself included. */
  alike: number;
}

export type PickResult = { match: ScanMatch } | { stale: true };

/**
 * The match in `text` that `target` names, after whatever edits landed since
 * the search. Offsets are not trusted: an insert above moves an earlier
 * occurrence of the same text onto the match's old offset. The same-text
 * matches are counted in order instead. While their number is unchanged, the
 * one at the target's ordinal is it if its line still reads as it did;
 * otherwise the only match whose preview is identical is it, provided the
 * search showed no other with that preview: an untouched twin of an edited
 * line is not the line clicked. Anything else is stale, so a click never
 * lands on an occurrence the person did not mean. Only the pick has its
 * replacement expanded.
 */
export function pickMatch(text: string, pattern: RegExp, target: MatchTarget, limits: ScanLimits, replace?: ScanReplace): PickResult {
  const re = new RegExp(pattern.source, pattern.flags);
  const tp = target.preview;
  let starts: number[] | null = null;
  let n = 0;
  let atOrdinal: RegExpExecArray | null = null;
  let firstAlike: RegExpExecArray | null = null;
  let alikeCount = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const from = m.index;
    const len = m[0].length;
    if (len === 0) {
      re.lastIndex = from + (isHigh(text.charCodeAt(from)) && isLow(text.charCodeAt(from + 1)) ? 2 : 1);
      if (re.lastIndex > text.length) break;
      continue;
    }
    if (len > limits.maxMatchUnits || m[0] !== target.text) continue;
    starts ??= lineStarts(text);
    const p = previewOf(text, starts, locate(starts, from).line, from, from + len);
    if (p.text === tp.text && p.start === tp.start && p.end === tp.end) {
      if (n === target.ordinal) atOrdinal = m;
      firstAlike ??= m;
      alikeCount++;
    }
    n++;
  }
  const pick = n === target.count && atOrdinal ? atOrdinal : target.alike === 1 && alikeCount === 1 ? firstAlike : null;
  if (!pick) return { stale: true };
  starts ??= lineStarts(text);
  const from = pick.index;
  const to = from + pick[0].length;
  const { line, column } = locate(starts, from);
  const match: ScanMatch = { from, to, line, column, text: pick[0], preview: previewOf(text, starts, line, from, to) };
  if (replace) match.replacement = replace.regex ? expandReplacement(replace.template, pick) : replace.template;
  return { match };
}

/** What a worker is asked to do; `source` and `flags` are the compiled pattern's. */
export type WorkerJob =
  | { op: 'scan'; files: ScanInput[]; limits: ScanLimits; replace?: ScanReplace }
  | { op: 'pick'; text: string; target: MatchTarget; limits: ScanLimits; replace?: ScanReplace };

if (!isMainThread && workerData?.kind === 'aldine-search') {
  const { source, flags, job } = workerData as { source: string; flags: string; job: WorkerJob };
  const pattern = new RegExp(source, flags);
  parentPort!.postMessage(job.op === 'pick'
    ? pickMatch(job.text, pattern, job.target, job.limits, job.replace)
    : scanFiles(job.files, pattern, job.limits, job.replace));
}
