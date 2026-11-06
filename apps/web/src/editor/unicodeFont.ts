/**
 * What "Typeset with XeLaTeX and a font that has these characters" does to
 * the root file's preamble. XeLaTeX and LuaLaTeX read Unicode, but print a
 * character only when the font has it: Latin Modern, their default, has no
 * Greek and few math symbols, and `\usepackage[T1]{fontenc}` puts them back
 * on an 8-bit font. So the preamble gets a font with Greek and math symbols
 * (DejaVu Serif, which the compiler image ships), loaded only where fontspec
 * works, and the fontenc/inputenc lines become pdfLaTeX's alone. Both are
 * behind \ifPDFTeX, so the file still typesets with pdfLaTeX.
 */

export const UNICODE_FONT = '\\setmainfont{DejaVuSerif}[Extension=.ttf, BoldFont=*-Bold, ItalicFont=*-Italic, BoldItalicFont=*-BoldItalic]';

export interface TextChange { from: number; to: number; insert: string }

/**
 * `edit`: the changes to make. `keep`: the document sets its own main font,
 * so only the engine changes. `manual`: a line loads fontenc or inputenc in
 * a way no edit can guard without rewriting it; the person changes `line`
 * (1-based) themselves.
 */
export type UnicodeFontPlan =
  | { kind: 'edit'; changes: TextChange[] }
  | { kind: 'keep' }
  | { kind: 'manual'; line: number; text: string };

const code = (line: string) => line.replace(/(^|[^\\])%.*$/, '$1');
const ENCODING = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:fontenc|inputenc)\b[^}]*\}/;
const ENCODING_LINE = /^\s*\\usepackage\s*(?:\[[^\]]*\])?\s*\{\s*(?:fontenc|inputenc)\s*\}\s*(?:%.*)?$/;

export function unicodeFontPlan(text: string): UnicodeFontPlan {
  const lines = text.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) { starts.push(at); at += l.length + 1; }
  const begin = lines.findIndex((l) => /\\begin\s*\{document\}/.test(code(l)));
  const pre = begin < 0 ? lines.length : begin;
  const preamble = lines.slice(0, pre).map(code);
  if (preamble.some((l) => /\\setmainfont\b/.test(l))) return { kind: 'keep' };
  const lineEnd = (n: number) => starts[n] + lines[n].length;
  const font = '\\usepackage{fontspec}\n' + UNICODE_FONT;
  // fontspec is loaded already, unguarded: the font goes right after it
  const fontspec = preamble.findIndex((l) => /\\usepackage\s*(?:\[[^\]]*\])?\s*\{\s*fontspec\s*\}/.test(l));
  if (fontspec >= 0) return { kind: 'edit', changes: [{ from: lineEnd(fontspec), to: lineEnd(fontspec), insert: `\n${UNICODE_FONT}` }] };
  const guarded = preamble.some((l) => /\\ifPDFTeX\b/.test(l));
  const iftexAt = preamble.findIndex((l) => /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\biftex\b/.test(l));
  const iftex = iftexAt >= 0 ? '' : '\\usepackage{iftex}\n';
  const enc = guarded ? [] : preamble.map((l, i) => (ENCODING.test(l) ? i : -1)).filter((i) => i >= 0);
  const odd = enc.find((i) => !ENCODING_LINE.test(lines[i]));
  if (odd !== undefined) return { kind: 'manual', line: odd + 1, text: lines[odd].trim() };
  if (!enc.length) {
    // after iftex where it is loaded, which \ifPDFTeX needs
    const cls = iftexAt >= 0 ? iftexAt : preamble.findIndex((l) => /\\documentclass\b/.test(l));
    const after = cls >= 0 ? lineEnd(cls) : 0;
    const block = `${iftex}\\ifPDFTeX\\else\n${font}\n\\fi`;
    return { kind: 'edit', changes: [cls >= 0 ? { from: after, to: after, insert: `\n${block}` } : { from: 0, to: 0, insert: `${block}\n` }] };
  }
  const contiguous = enc.every((n, k) => k === 0 || n === enc[k - 1] + 1);
  const first = enc[0];
  // \ifPDFTeX needs iftex loaded before it; loading it twice is harmless
  const load = iftexAt >= 0 && iftexAt < first ? '' : '\\usepackage{iftex}\n';
  const last = enc[enc.length - 1];
  if (contiguous) {
    return {
      kind: 'edit',
      changes: [
        { from: starts[first], to: starts[first], insert: `${load}\\ifPDFTeX\n` },
        { from: lineEnd(last), to: lineEnd(last), insert: `\n\\else\n${font}\n\\fi` },
      ],
    };
  }
  return {
    kind: 'edit',
    changes: enc.flatMap((n, k) => [
      { from: starts[n], to: starts[n], insert: `${k === 0 ? load : ''}\\ifPDFTeX\n` },
      { from: lineEnd(n), to: lineEnd(n), insert: `\n\\fi${n === last ? `\n\\ifPDFTeX\\else\n${font}\n\\fi` : ''}` },
    ]),
  };
}
