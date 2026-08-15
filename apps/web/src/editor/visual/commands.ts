import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

/**
 * All formatting is expressed as ordinary CodeMirror text dispatches, so it
 * flows through yCollab (collaborative) and the Yjs undo manager. These are
 * the only code paths in the visual editor that change document bytes.
 */

const STYLE = {
  bold: { cmd: '\\textbf', node: 'TextBoldCommand' },
  italic: { cmd: '\\textit', node: 'TextItalicCommand' },
} as const;
export type StyleKind = keyof typeof STYLE;

const SECTION_CMDS = ['\\section', '\\subsection', '\\subsubsection', '\\paragraph'] as const;
const SECTION_TOKENS = new Set([
  'BookCtrlSeq', 'PartCtrlSeq', 'ChapterCtrlSeq', 'SectionCtrlSeq',
  'SubSectionCtrlSeq', 'SubSubSectionCtrlSeq', 'ParagraphCtrlSeq', 'SubParagraphCtrlSeq',
]);

function ancestor(state: EditorState, pos: number, name: string): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    while (n) {
      if (n.name === name) return n;
      n = n.parent;
    }
  }
  return null;
}

/** Wrap the selection in \textbf{}/\textit{} — or unwrap when already inside one. */
export function toggleStyle(kind: StyleKind) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const { cmd, node } = STYLE[kind];
    const sel = state.selection.main;
    const wrapper = ancestor(state, sel.head, node);
    if (wrapper) {
      const arg = wrapper.getChild('TextArgument');
      const open = arg?.getChild('OpenBrace');
      const close = arg?.getChild('CloseBrace');
      if (arg && open && close) {
        view.dispatch({
          changes: [
            { from: wrapper.from, to: open.to },
            { from: close.from, to: close.to },
          ],
          scrollIntoView: true,
        });
        return true;
      }
      return false;
    }
    view.dispatch(state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: `${cmd}{` },
        { from: range.to, insert: '}' },
      ],
      range: EditorSelection.range(range.from + cmd.length + 1, range.to + cmd.length + 1),
    })));
    return true;
  };
}

/**
 * Set the sectioning level of the enclosing heading by replacing only its
 * command token (a `*` stays untouched). With no enclosing heading, the
 * current line's text becomes a new heading.
 */
export function setSectionLevel(level: 1 | 2 | 3 | 4) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const cmd = SECTION_CMDS[level - 1];
    const pos = state.selection.main.head;
    const sect = ancestor(state, pos, 'SectioningCommand');
    if (sect) {
      let tok: SyntaxNode | null = sect.firstChild;
      while (tok && !SECTION_TOKENS.has(tok.name)) tok = tok.nextSibling;
      if (!tok) return false;
      view.dispatch({ changes: { from: tok.from, to: tok.to, insert: cmd } });
      return true;
    }
    const line = state.doc.lineAt(pos);
    // Wrapping a comment (or the commented tail of a line) would put the
    // closing brace inside the comment — a runaway argument. Head only the
    // code part and keep any trailing comment outside the braces.
    const raw = line.text;
    const cm = raw.match(/(?:^|[^\\])%/);
    const cmIdx = cm ? cm.index! + cm[0].length - 1 : -1;
    const text = (cmIdx >= 0 ? raw.slice(0, cmIdx) : raw).trim();
    if (!text) return false; // comment-only or blank line — nothing to turn into a heading
    const trailing = cmIdx >= 0 ? ' ' + raw.slice(cmIdx).trim() : '';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: `${cmd}{${text}}${trailing}` },
      selection: { anchor: line.from + cmd.length + 1 + text.length },
    });
    return true;
  };
}

/** Wrap the selected lines in an itemize (or unwrap the enclosing list). */
export function toggleItemize(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const env = ancestor(state, sel.head, 'ListEnvironment');
  if (env) {
    const begin = env.getChild('BeginEnv');
    const end = env.getChild('EndEnv');
    if (!begin || !end) return false;
    const changes: Array<{ from: number; to: number; insert?: string }> = [];
    // drop the \begin/\end lines (with their newlines) …
    const beginTo = state.doc.sliceString(begin.to, begin.to + 1) === '\n' ? begin.to + 1 : begin.to;
    const endFrom = state.doc.sliceString(end.from - 1, end.from) === '\n' ? end.from - 1 : end.from;
    changes.push({ from: begin.from, to: beginTo }, { from: endFrom, to: end.to });
    // …and every \item prefix inside
    const re = /\\item\s?/g;
    const body = state.doc.sliceString(beginTo, endFrom);
    for (let m = re.exec(body); m; m = re.exec(body)) {
      changes.push({ from: beginTo + m.index, to: beginTo + m.index + m[0].length });
    }
    view.dispatch({ changes });
    return true;
  }
  const fromLine = state.doc.lineAt(sel.from);
  const toLine = state.doc.lineAt(sel.to);
  // CodeMirror applies same-position inserts in array order, so \begin{itemize}
  // must be pushed BEFORE the first line's \item or it lands after it.
  const changes: Array<{ from: number; insert: string }> = [{ from: fromLine.from, insert: '\\begin{itemize}\n' }];
  for (let ln = fromLine.number; ln <= toLine.number; ln++) {
    const line = state.doc.line(ln);
    if (line.text.trim()) changes.push({ from: line.from, insert: '\\item ' });
  }
  changes.push({ from: toLine.to, insert: '\n\\end{itemize}' });
  view.dispatch({ changes });
  return true;
}

/** Current heading level at the cursor (for the toolbar dropdown), or null. */
export function sectionLevelAt(state: EditorState, pos: number): number | null {
  const sect = ancestor(state, pos, 'SectioningCommand');
  if (!sect) return null;
  let tok: SyntaxNode | null = sect.firstChild;
  while (tok && !SECTION_TOKENS.has(tok.name)) tok = tok.nextSibling;
  if (!tok) return null;
  const text = state.doc.sliceString(tok.from, tok.to);
  const idx = SECTION_CMDS.indexOf(text as (typeof SECTION_CMDS)[number]);
  return idx === -1 ? 1 : idx + 1;
}
