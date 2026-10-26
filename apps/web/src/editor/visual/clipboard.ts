import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { verbatimArgCommand } from './decorations';
import { safeStorage } from '../../util/safeStorage';
import { escapeLatex, htmlToLatex } from './html2latex';
import { preambleFor } from './context';
import { definesUrl } from './preamble';

/**
 * Text the editor itself put on the clipboard is already source and pastes
 * as it is; plain text from anywhere else is prose. Only a hash is kept, in
 * this tab and for the app's other tabs.
 */
const KEY = 'aldine.visual.lastCopy';
let last: string | null = null;

function hash(text: string): string {
  let h = 0x811c9dc5;
  const t = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${t.length}:${(h >>> 0).toString(36)}`;
}

/** Remembers every copy and cut out of an editor, in either mode. */
export const recordOwnCopies = EditorView.clipboardOutputFilter.of((text) => {
  last = hash(text);
  safeStorage.set(KEY, last);
  return text;
});

export function isOwnCopy(text: string): boolean {
  const h = hash(text);
  return h === last || h === safeStorage.get(KEY);
}

/**
 * Clipboard text that is LaTeX already, copied from a .tex file, a terminal
 * or a chat: a control word (not a Windows path's `C:\Users`), or a `$…$`
 * formula (not the `$5 … $10` of prices).
 */
const LATEX_TEXT = /(?:^|[^A-Za-z0-9:\\/])\\[A-Za-z]+|\\[A-Za-z]+\s*[{[]|\$[^\s$\d](?:[^$\n]*[^\s$])?\$/;

/** Where text is taken as written (math, verbatim, a path), so an escape would show or break it. */
const RAW_CONTENT = new Set(['Math', 'VerbatimContent', 'VerbContent', 'LstInlineContent', 'LiteralArgContent']);
/** Arguments that hold keys or paths, raw strictly between their braces. */
const RAW_ARGS = new Set(['DollarMath', 'BracketMath', 'ParenMath', 'RefArgument', 'BibKeyArgument', 'LabelArgument', 'UrlArgument', 'FilePathArgument']);

/** Whether a paste at `pos` lands where text is source as written, not prose. */
export function rawAt(state: EditorState, pos: number): boolean {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (RAW_CONTENT.has(n.name) && n.from <= pos && pos <= n.to) return true;
      if (n.from >= pos || pos >= n.to) continue;
      if (RAW_ARGS.has(n.name)) return true;
      if (n.name === 'TextArgument' && n.parent?.name === 'UnknownCommand' && verbatimArgCommand(n.parent, state.doc)) return true;
    }
  }
  return false;
}

/**
 * What a paste writes in Visual mode, or null for the editor's own paste.
 * Rich text converts to clean LaTeX; plain prose is escaped, so `50% & $5`
 * stays text. Source copied from an editor, and anything pasted where text
 * is taken as written (`raw`: a formula, a listing, a \ref key), pastes as
 * it is.
 */
export function pasteText(html: string, text: string, doc: string, raw = false): string | null {
  if (raw || LATEX_TEXT.test(text) || isOwnCopy(text)) return null;
  if (!html) {
    const escaped = escapeLatex(text);
    return escaped === text ? null : escaped;
  }
  const latex = htmlToLatex(html, { url: definesUrl(preambleFor(doc)) });
  if (!latex || latex === text.trim()) return null;
  return latex;
}
