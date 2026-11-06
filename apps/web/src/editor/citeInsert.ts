/**
 * Where a picked reference goes: into the citation the cursor is in or just
 * after, as one more key, else as a new \cite{key}. A reference picker that
 * always inserts \cite{key} nests it inside an argument (\cite{a\cite{b}})
 * and strings repeated picks into \cite{a}\cite{b}.
 */

/** A citation command up to its argument's opening brace: \cite, \citep*, \parencite[see][3], \textcite… */
const CITE_OPEN = /\\([a-zA-Z]*[cC]ite[a-zA-Z]*)\*?(?:\s*\[[^\]\n]*\]){0,2}\s*\{/g;
/** How far before the cursor a citation's start is looked for. */
const REACH = 2000;

export type CitationEdit =
  /** A new \cite{key} replacing from..to. */
  | { kind: 'insert'; from: number; to: number; insert: string; cursor: number }
  /** `insert` at `from`, inside an existing citation. */
  | { kind: 'add'; from: number; to: number; insert: string; cursor: number }
  /** The citation holds the key already. */
  | { kind: 'present'; cursor: number };

/** A citation's argument: `close` is its closing brace, or null while it is still being typed. */
interface Argument { open: number; close: number | null; command: string }

/** The citation arguments that start within REACH before `pos`. */
function argumentsBefore(text: string, pos: number): Argument[] {
  const out: Argument[] = [];
  CITE_OPEN.lastIndex = Math.max(0, pos - REACH);
  for (let m = CITE_OPEN.exec(text); m && m.index < pos; m = CITE_OPEN.exec(text)) {
    const open = m.index + m[0].length - 1;
    const end = text.slice(open + 1, open + 1 + REACH).search(/[{}]/);
    const at = end === -1 ? -1 : open + 1 + end;
    if (at !== -1 && text[at] === '}') out.push({ open, close: at, command: m[1] });
    // No brace of its own before the cursor: an argument still being typed.
    else if (open < pos && !/[{}]|\n\s*\n/.test(text.slice(open + 1, pos))) out.push({ open, close: null, command: m[1] });
  }
  return out;
}

function addTo(text: string, arg: Argument, pos: number, key: string): CitationEdit {
  const end = arg.close ?? pos;
  const body = text.slice(arg.open + 1, end);
  const keys = body.split(',').map((k) => k.trim()).filter(Boolean);
  if (arg.close !== null && keys.includes(key)) return { kind: 'present', cursor: arg.close + 1 };
  const kept = body.replace(/\s+$/, '');
  const at = arg.open + 1 + kept.length;
  const spaced = /,\s/.test(body);
  const joined = !kept ? key : kept.endsWith(',') ? `${spaced ? ' ' : ''}${key}` : `${spaced ? ', ' : ','}${key}`;
  if (arg.close === null) {
    const insert = `${joined}}`;
    return { kind: 'add', from: at, to: end, insert, cursor: at + insert.length };
  }
  return { kind: 'add', from: at, to: at, insert: joined, cursor: arg.close + 1 + joined.length };
}

/**
 * The edit that cites `key` with the selection from..to: inside a
 * citation's braces the key joins its list; right after a citation's closing
 * brace it joins that one (not \nocite, which prints nothing); anywhere else
 * a new \cite{key} replaces the selection. The cursor ends after the
 * citation either way, ready for the next pick.
 */
export function citationEdit(text: string, from: number, key: string, to = from): CitationEdit {
  const args = argumentsBefore(text, from);
  const inside = [...args].reverse().find((a) => a.open < from && (a.close === null || from <= a.close));
  if (inside) return addTo(text, inside, from, key);
  if (from === to) {
    const before = args.find((a) => a.close === from - 1 && a.command !== 'nocite');
    if (before) return addTo(text, before, from, key);
  }
  const insert = `\\cite{${key}}`;
  return { kind: 'insert', from, to, insert, cursor: from + insert.length };
}
