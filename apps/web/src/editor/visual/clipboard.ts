import { EditorView } from '@codemirror/view';
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

/** Clipboard text that is LaTeX already: copied from a .tex file, here or elsewhere. */
const LATEX_TEXT = /\\(section|textbf|begin|item|cite)\b/;

/**
 * What a paste writes in Visual mode, or null for the editor's own paste.
 * Rich text converts to clean LaTeX; plain prose is escaped, so `50% & $5`
 * stays text. Source copied from an editor pastes as it is.
 */
export function pasteText(html: string, text: string, doc: string): string | null {
  if (LATEX_TEXT.test(text) || isOwnCopy(text)) return null;
  if (!html) {
    const escaped = escapeLatex(text);
    return escaped === text ? null : escaped;
  }
  const latex = htmlToLatex(html, { url: definesUrl(preambleFor(doc)) });
  if (!latex || latex === text.trim()) return null;
  return latex;
}
