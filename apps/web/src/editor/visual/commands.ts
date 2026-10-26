import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import type { EditorState, StateCommand } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { insertNewlineKeepIndent } from '@codemirror/commands';
import type { SyntaxNode } from '@lezer/common';
import { headingLineTail } from './decorations';
import { atomicField } from './atomicField';

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
    const trailing = cmIdx >= 0 ? ' ' + raw.slice(cmIdx).trim() : '';
    if (!text) {
      // a blank (or comment-only) line gets an empty heading to type into
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: `${cmd}{}${trailing}` },
        selection: { anchor: line.from + cmd.length + 1 },
        scrollIntoView: true,
      });
      return true;
    }
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: `${cmd}{${text}}${trailing}` },
      selection: { anchor: line.from + cmd.length + 1 + text.length },
    });
    return true;
  };
}

/** The closing brace of the last heading whose argument ends on `line`. */
function headingCloserOn(state: EditorState, line: { from: number; to: number }): SyntaxNode | null {
  let close: SyntaxNode | null = null;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(n) {
      if (n.name !== 'SectioningCommand') return;
      const c = n.node.getChild('SectioningArgument')?.getChild('CloseBrace');
      if (c && c.to === n.to && c.from >= line.from && c.to <= line.to) close = c;
      return false;
    },
  });
  return close;
}

/**
 * Enter with the caret at the closing brace of a heading that ends its line
 * (End, a click past the heading and the Heading menu all leave it there),
 * or at the end of that line: the new line starts after the heading, not
 * inside its braces. It goes at the end of the line, so a same-line \label
 * or comment stays with the heading, and it takes no indentation.
 */
export const breakAfterHeading: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.head);
  const close = headingCloserOn(state, line);
  if (!close || (sel.head !== close.from && sel.head !== line.to)) return false;
  if (!headingLineTail(state.doc.sliceString(close.to, line.to))) return false;
  dispatch(state.update({
    changes: { from: line.to, insert: state.lineBreak },
    selection: { anchor: line.to + 1 },
    scrollIntoView: true,
    userEvent: 'input',
  }));
  return true;
};

const RENDERED_LISTS = new Set(['itemize', 'enumerate', 'description']);

/** The list environment `pos` is directly in (not in a nested one), when Visual renders its items. */
function listAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name !== 'ListEnvironment') continue;
    const name = n.getChild('BeginEnv')?.getChild('EnvNameGroup')?.getChild('ListEnvName');
    return name && RENDERED_LISTS.has(state.doc.sliceString(name.from, name.to)) ? n : null;
  }
  return null;
}

/** The list's own \item tokens, in order (a nested list's are its own). */
function listItems(list: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const text = list.getChild('Content')?.getChild('Text');
  for (let c = text?.firstChild ?? null; c; c = c.nextSibling) {
    const item = c.name === 'Command' ? c.getChild('KnownCommand')?.getChild('Item') : null;
    if (item) out.push(item);
  }
  return out;
}

const indentOf = (text: string) => /^[ \t]*/.exec(text)![0];

/** Whether a line holds nothing but `node` (and spaces). */
function aloneOnLine(state: EditorState, node: SyntaxNode): boolean {
  const line = state.doc.lineAt(node.from);
  return node.to <= line.to && !state.doc.sliceString(line.from, node.from).trim() && !state.doc.sliceString(node.to, line.to).trim();
}

/**
 * Enter at the end of a list item starts the next `\item` on a new line, at
 * the item's indentation. On an empty item it leaves the list: the empty
 * item goes, and the caret lands on a new line after the list (a new item of
 * the enclosing list when it is nested). The only item of a list takes the
 * list with it, since an empty list stops the compile.
 */
export const listItemEnter: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const pos = sel.head;
  const line = state.doc.lineAt(pos);
  if (state.doc.sliceString(pos, line.to).trim()) return false;
  const list = listAt(state, pos);
  if (!list) return false;
  const items = listItems(list);
  const item = [...items].reverse().find((i) => i.to <= pos);
  const end = list.getChild('EndEnv');
  if (!item || !end || pos > end.from) return false;
  const itemLine = state.doc.lineAt(item.from);
  const indent = state.doc.sliceString(itemLine.from, item.from).trim() ? '' : indentOf(itemLine.text);
  const empty = itemLine.number === line.number && state.doc.sliceString(item.to, line.to).trim() === '';
  if (!empty) {
    const insert = `${state.lineBreak}${indent}\\item `;
    dispatch(state.update({
      changes: { from: pos, to: line.to, insert },
      selection: { anchor: pos + insert.length },
      scrollIntoView: true,
      userEvent: 'input',
    }));
    return true;
  }
  if (!aloneOnLine(state, end)) return false;
  const endLine = state.doc.lineAt(end.from);
  if (items.length === 1) {
    const begin = list.getChild('BeginEnv');
    if (!begin || !aloneOnLine(state, begin)) return false;
    const beginLine = state.doc.lineAt(begin.from);
    dispatch(state.update({
      changes: { from: beginLine.from, to: endLine.to, insert: '' },
      selection: { anchor: beginLine.from },
      scrollIntoView: true,
      userEvent: 'delete',
    }));
    return true;
  }
  const outer = list.parent ? listAt(state, list.from) : null;
  const outerItem = outer ? [...listItems(outer)].reverse().find((i) => i.to <= list.from) : null;
  let after = '';
  if (outer && outerItem) {
    const l = state.doc.lineAt(outerItem.from);
    after = `${state.doc.sliceString(l.from, outerItem.from).trim() ? '' : indentOf(l.text)}\\item `;
  }
  const changes = state.changes([
    { from: line.from - 1, to: line.to },
    { from: endLine.to, insert: state.lineBreak + after },
  ]);
  dispatch(state.update({
    changes,
    selection: { anchor: changes.mapPos(endLine.to, 1) },
    scrollIntoView: true,
    userEvent: 'input',
  }));
  return true;
};

/**
 * Enter anywhere else in Visual keeps the line's own indentation instead of
 * the language's, which indents body text under a heading and so shows as an
 * indented paragraph. A line ending in \begin{…} is left to the environment
 * closer.
 */
export const paragraphEnter: StateCommand = (target) => {
  const { state } = target;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  if (/\\begin\s*\{[^}]*\}[ \t]*$/.test(state.doc.sliceString(line.from, sel.head))) return false;
  return insertNewlineKeepIndent(target);
};

/** Whether `line` is hidden whole by Visual (a list's \begin/\end line, a lone \centering). */
function hiddenLine(state: EditorState, line: { from: number; to: number }): boolean {
  const deco = state.field(atomicField, false)?.deco;
  if (!deco) return false;
  let hidden = false;
  deco.between(line.from, line.to, (from, to, d) => {
    if (d.spec.block && from <= line.from && to >= line.to) hidden = true;
  });
  return hidden;
}

/**
 * Backspace at the start of a line below a hidden line, and Delete at the
 * end of a line above one, would join the hidden markup to the text and
 * delete it a character at a time. They move the caret past it instead, to
 * the nearest line that shows.
 */
function passHiddenLine(dir: -1 | 1): StateCommand {
  return ({ state, dispatch }) => {
    const sel = state.selection.main;
    if (!sel.empty || state.selection.ranges.length > 1) return false;
    const line = state.doc.lineAt(sel.head);
    if (sel.head !== (dir < 0 ? line.from : line.to)) return false;
    let n = line.number + dir;
    if (n < 1 || n > state.doc.lines || !hiddenLine(state, state.doc.line(n))) return false;
    while (n >= 1 && n <= state.doc.lines && hiddenLine(state, state.doc.line(n))) n += dir;
    if (n < 1 || n > state.doc.lines) return true;
    const target = state.doc.line(n);
    dispatch(state.update({ selection: { anchor: dir < 0 ? target.to : target.from }, scrollIntoView: true, userEvent: 'select' }));
    return true;
  };
}

export const backspaceHiddenLine = passHiddenLine(-1);
export const deleteHiddenLine = passHiddenLine(1);

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
