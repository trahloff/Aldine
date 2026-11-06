import { EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { EditorSelection, findClusterBreak } from '@codemirror/state';
import type { EditorState, StateCommand } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { insertNewlineKeepIndent } from '@codemirror/commands';
import type { SyntaxNode } from '@lezer/common';
import { headingLineTail, labelsOnlyTail } from './decorations';
import { atomicDecoAt } from './atomicField';

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

const MATH_NODES = new Set(['DollarMath', 'BracketMath', 'ParenMath', 'Math']);

/**
 * The list environment `pos` is directly in (not in a nested one), when
 * Visual renders its items. Inside any other environment or a formula within
 * an item, an \item would be written into that construct, so there is none.
 */
function listAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    const inside = n.from < pos && pos < n.to;
    if (inside && (MATH_NODES.has(n.name) || (n.name.endsWith('Environment') && n.name !== 'ListEnvironment' && n.name !== 'KnownEnvironment'))) return null;
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
 * last item goes, and the caret lands on a new line after the list (a new
 * item of the enclosing list when it is nested). The only item of a list
 * takes the list with it, since an empty list stops the compile; a list that
 * holds more than that item is left alone.
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
  // an empty item between others stays a plain line break: leaving would jump the caret past them
  if (item !== items[items.length - 1] || !aloneOnLine(state, end)) return false;
  const endLine = state.doc.lineAt(end.from);
  if (items.length === 1) {
    const begin = list.getChild('BeginEnv');
    if (!begin || !aloneOnLine(state, begin)) return false;
    // anything else in the list (a comment, a \setlength) would go with it
    if (state.doc.sliceString(begin.to, item.from).trim() || state.doc.sliceString(item.to, end.from).trim()) return false;
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
function hiddenLine(deco: DecorationSet | undefined, line: { from: number; to: number }): boolean {
  if (!deco) return false;
  let hidden = false;
  deco.between(line.from, line.to, (from, to, d) => {
    if (d.spec.block && from <= line.from && to >= line.to) hidden = true;
  });
  return hidden;
}

/** The `\item ` a line starts with, where Visual draws it as a bullet: the span the bullet hides. */
export function markerOn(state: EditorState, deco: DecorationSet | undefined, line: { from: number; to: number }): { from: number; to: number } | null {
  let marker: { from: number; to: number } | null = null;
  deco?.between(line.from, line.to, (from, to, d) => {
    if (!marker && d.spec.itemMarker && from >= line.from && !state.doc.sliceString(line.from, from).trim()) marker = { from, to };
  });
  return marker;
}

/** The nearest line above line `n` that Visual shows, or null. */
export function visibleLineAbove(state: EditorState, n: number): { from: number; to: number } | null {
  if (n <= 1) return null;
  const deco = atomicDecoAt(state, Math.max(0, state.doc.line(n - 1).from - 2_000), state.doc.line(n - 1).to);
  for (let k = n - 1; k >= 1; k--) {
    const line = state.doc.line(k);
    if (!hiddenLine(deco, line)) return line;
  }
  return null;
}

/** What goes between two pieces of text joined into one line: a space where a control word would run into a letter. */
function joiner(before: string, after: string): string {
  return /\\[A-Za-z]+$/.test(before) && /^[A-Za-z]/.test(after) ? ' ' : '';
}

/** Whether a line has a comment, which text joined onto its end would go into. */
const hasComment = (text: string) => /(?:^|[^\\])%/.test(text);

/** The rendered list item whose bullet line `line` is, with its list's items and its index among them. */
function itemOnLine(state: EditorState, deco: DecorationSet | undefined, line: { from: number; to: number }) {
  const marker = markerOn(state, deco, line);
  const list = marker && listAt(state, marker.to);
  if (!marker || !list) return null;
  const items = listItems(list);
  const index = items.findIndex((i) => i.from === marker.from);
  return index < 0 ? null : { marker, list, items, index };
}

/**
 * Backspace with the caret just after a bullet. An item below another
 * item's text joins that item; an empty one goes with its line. Where the
 * line above is hidden (the list's first item, an item after a nested list)
 * the caret moves to the nearest line that shows instead, and an empty item
 * goes, the list with it when it was the only one. Never leaves `\itemWord`.
 */
export const itemBackspace: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.head);
  const deco = atomicDecoAt(state, Math.max(0, line.from - 2_000), line.to);
  const at = itemOnLine(state, deco, line);
  if (!at || sel.head !== at.marker.to) return false;
  const { marker, list, items, index } = at;
  const empty = !state.doc.sliceString(marker.to, line.to).trim();
  const prev = line.number > 1 ? state.doc.line(line.number - 1) : null;
  if (index > 0 && prev && prev.to >= items[index - 1].from && !hiddenLine(deco, prev) && !hasComment(prev.text)) {
    const to = empty ? line.to : marker.to;
    const insert = joiner(prev.text, state.doc.sliceString(to, line.to));
    dispatch(state.update({
      changes: { from: prev.to, to, insert },
      selection: { anchor: prev.to + insert.length },
      scrollIntoView: true,
      userEvent: 'delete.backward',
    }));
    return true;
  }
  const above = visibleLineAbove(state, line.number);
  const moveUp = () => {
    if (above) dispatch(state.update({ selection: { anchor: above.to }, scrollIntoView: true, userEvent: 'select' }));
    return true;
  };
  if (!empty) return moveUp();
  const begin = list.getChild('BeginEnv');
  const end = list.getChild('EndEnv');
  if (items.length === 1 && begin && end && aloneOnLine(state, begin) && aloneOnLine(state, end)
    && !state.doc.sliceString(begin.to, marker.from).trim() && !state.doc.sliceString(items[0].to, end.from).trim()) {
    // an empty list stops the compile: the only item takes its list along
    const beginLine = state.doc.lineAt(begin.from);
    const endLine = state.doc.lineAt(end.from);
    dispatch(state.update({
      changes: { from: beginLine.from, to: endLine.to, insert: '' },
      selection: { anchor: beginLine.from },
      scrollIntoView: true,
      userEvent: 'delete.backward',
    }));
    return true;
  }
  // anything else in the list (a comment, a \setlength) would go with it
  if (items.length === 1) return moveUp();
  dispatch(state.update({
    changes: { from: line.from, to: Math.min(line.to + 1, state.doc.length) },
    selection: { anchor: above ? above.to : line.from },
    scrollIntoView: true,
    userEvent: 'delete.backward',
  }));
  return true;
};

/**
 * Delete at the end of an item's text with the next item below: that item's
 * text joins this one (an empty one goes with its line), never `\item`
 * itself onto this line.
 */
export const itemDelete: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to || line.number >= state.doc.lines) return false;
  const next = state.doc.line(line.number + 1);
  const deco = atomicDecoAt(state, line.from, Math.min(state.doc.length, next.to + 2_000));
  const at = itemOnLine(state, deco, next);
  if (!at || at.index === 0 || line.to < at.items[at.index - 1].from || hiddenLine(deco, line) || hasComment(line.text)) return false;
  const empty = !state.doc.sliceString(at.marker.to, next.to).trim();
  const to = empty ? next.to : at.marker.to;
  const insert = joiner(line.text, state.doc.sliceString(to, next.to));
  dispatch(state.update({
    changes: { from: line.to, to, insert },
    selection: { anchor: line.to },
    scrollIntoView: true,
    userEvent: 'delete.forward',
  }));
  return true;
};

/**
 * Home on a bullet's line goes to the start of the item's text, after the
 * bullet, where typing stays in the item; Shift+Home selects to there. A
 * later line of a wrapped item keeps its own line start.
 */
export function itemHome(extend: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const sel = state.selection.main;
    if (state.selection.ranges.length > 1) return false;
    const line = state.doc.lineAt(sel.head);
    const marker = markerOn(state, atomicDecoAt(state, line.from, line.to), line);
    if (!marker || sel.head < marker.to) return false;
    if (view.moveToLineBoundary(EditorSelection.cursor(sel.head), false, true).head > marker.to) return false;
    view.dispatch({
      selection: extend ? EditorSelection.range(sel.anchor, marker.to) : EditorSelection.cursor(marker.to),
      scrollIntoView: true,
      userEvent: 'select',
    });
    return true;
  };
}

/**
 * Backspace right after a construct Visual draws as one widget (a chip, a
 * formula, a table), Delete right before one: the first press selects it
 * whole, so it shows what goes, and the next deletes the selection.
 */
function selectConstruct(dir: -1 | 1): StateCommand {
  return ({ state, dispatch }) => {
    const sel = state.selection.main;
    if (!sel.empty || state.selection.ranges.length > 1) return false;
    const pos = sel.head;
    let hit: { from: number; to: number } | null = null;
    atomicDecoAt(state, Math.max(0, pos - 1), Math.min(state.doc.length, pos + 1))?.between(pos, pos, (from, to, d) => {
      if (d.spec.closed && (dir < 0 ? to === pos : from === pos)) hit = { from, to };
    });
    if (!hit) return false;
    const { from, to } = hit;
    dispatch(state.update({
      selection: dir < 0 ? EditorSelection.range(to, from) : EditorSelection.range(from, to),
      scrollIntoView: true,
      userEvent: 'select',
    }));
    return true;
  };
}

export const selectConstructBackward = selectConstruct(-1);
export const selectConstructForward = selectConstruct(1);

const OPEN_STYLES = new Set(['TextBoldCommand', 'TextItalicCommand', 'EmphasisCommand', 'UnderlineCommand', 'TextSmallCapsCommand']);

/** A text style or heading whose markup Visual hides: its text runs from `openEnd` to `closeFrom`. */
interface OpenConstruct { from: number; to: number; openEnd: number; closeFrom: number }

function openParts(n: SyntaxNode): OpenConstruct | null {
  const arg = OPEN_STYLES.has(n.name) ? n.getChild('TextArgument') : n.name === 'SectioningCommand' ? n.getChild('SectioningArgument') : null;
  const open = arg?.getChild('OpenBrace');
  const close = arg?.getChild('CloseBrace');
  if (!arg || !open || !close || close.to !== n.to) return null;
  return { from: n.from, to: n.to, openEnd: open.to, closeFrom: close.from };
}

/** The style or heading that ends (dir -1) or starts (dir 1) exactly at `pos`. */
function openConstructAt(state: EditorState, pos: number, dir: -1 | 1): OpenConstruct | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, dir); n; n = n.parent) {
    if ((dir < 0 ? n.to : n.from) !== pos) break;
    const parts = openParts(n);
    if (parts) return parts;
  }
  return null;
}

/** A heading on a line of its own whose `}` hides with the \label after it, when `pos` is that line's end. */
function labelledHeadingEnd(state: EditorState, pos: number): OpenConstruct | null {
  const line = state.doc.lineAt(pos);
  if (pos !== line.to) return null;
  const close = headingCloserOn(state, line);
  const cmd = close?.parent?.parent;
  const parts = cmd && openParts(cmd);
  if (!parts || parts.to === line.to || state.doc.sliceString(line.from, parts.from).trim() || !labelsOnlyTail(state.doc.sliceString(parts.to, line.to))) return null;
  return parts;
}

/**
 * Backspace right after a style's or a heading's hidden `}` (Delete right
 * before its hidden `\textbf{`) takes the character inside next to it, never
 * the brace or the command: that leaves the braces unbalanced and stops the
 * typeset. Nested styles are passed through to their text; a chip or
 * formula there is selected first, an escape such as `\%` goes whole, and a
 * brace of other markup selects what it closes. A style left with no text
 * goes with its markup. The caret keeps its place outside the construct.
 */
function editIntoConstruct(dir: -1 | 1): StateCommand {
  return ({ state, dispatch }) => {
    const sel = state.selection.main;
    if (!sel.empty || state.selection.ranges.length > 1) return false;
    const pos = sel.head;
    const chain: OpenConstruct[] = [];
    for (let t = pos; ;) {
      const c = openConstructAt(state, t, dir) ?? (dir < 0 && t === pos ? labelledHeadingEnd(state, t) : null);
      if (!c || chain.some((o) => o.from === c.from && o.to === c.to)) break;
      chain.push(c);
      t = dir < 0 ? c.closeFrom : c.openEnd;
    }
    if (!chain.length) return false;
    const inner = chain[chain.length - 1];
    const t = dir < 0 ? inner.closeFrom : inner.openEnd;
    const select = (from: number, to: number) => {
      dispatch(state.update({ selection: dir < 0 ? EditorSelection.range(to, from) : EditorSelection.range(from, to), scrollIntoView: true, userEvent: 'select' }));
      return true;
    };
    let a = t;
    let b = t;
    if (inner.openEnd < inner.closeFrom) {
      let atom: { from: number; to: number } | null = null;
      atomicDecoAt(state, Math.max(0, t - 1), Math.min(state.doc.length, t + 1))?.between(t, t, (from, to, d) => {
        if (d.spec.closed && (dir < 0 ? to === t && from >= inner.openEnd : from === t && to <= inner.closeFrom)) atom = { from, to };
      });
      if (atom) {
        const { from, to } = atom;
        return select(from, to);
      }
      const text = state.doc.sliceString(inner.openEnd, inner.closeFrom);
      const at = t - inner.openEnd;
      const escape = dir < 0 ? /\\(?:[A-Za-z]+|[^A-Za-z])$/.exec(text.slice(0, at)) : /^\\(?:[A-Za-z]+|[^A-Za-z])/.exec(text.slice(at));
      const ch = dir < 0 ? text[at - 1] : text[at];
      if (escape) {
        [a, b] = dir < 0 ? [t - escape[0].length, t] : [t, t + escape[0].length];
      } else if (ch === '{' || ch === '}' || ch === '$') {
        // a brace or dollar of other markup: what it belongs to, selected whole
        for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(t, dir); n; n = n.parent) {
          if (n.from < inner.openEnd || n.to > inner.closeFrom) break;
          if ((dir < 0 ? n.to === t : n.from === t) && n.to - n.from > 1) return select(n.from, n.to);
        }
        return true;
      } else {
        const line = state.doc.lineAt(t);
        const edge = dir < 0 ? t === line.from : t === line.to;
        const next = edge ? t + dir : findClusterBreak(line.text, t - line.from, dir > 0) + line.from;
        [a, b] = dir < 0 ? [next, t] : [t, next];
      }
    }
    // a style or heading left with no text goes with its markup, and so on outwards
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i];
      if (a > c.openEnd || b < c.closeFrom) break;
      a = c.from;
      b = c.to;
    }
    const changes = state.changes({ from: a, to: b });
    dispatch(state.update({
      changes,
      selection: { anchor: changes.mapPos(pos, dir < 0 ? 1 : -1) },
      scrollIntoView: true,
      userEvent: dir < 0 ? 'delete.backward' : 'delete.forward',
    }));
    return true;
  };
}

export const backspaceIntoConstruct = editIntoConstruct(-1);
export const deleteIntoConstruct = editIntoConstruct(1);

/**
 * Backspace at the start of a line below a hidden line, and Delete at the
 * end of a line above one, would join the hidden markup to the text and
 * delete it a character at a time. They move the caret past it instead, to
 * the nearest line that shows: Delete onto an item's line lands after its
 * bullet, where typing goes into the item.
 */
function passHiddenLine(dir: -1 | 1): StateCommand {
  return ({ state, dispatch }) => {
    const sel = state.selection.main;
    if (!sel.empty || state.selection.ranges.length > 1) return false;
    const line = state.doc.lineAt(sel.head);
    if (sel.head !== (dir < 0 ? line.from : line.to)) return false;
    let n = line.number + dir;
    if (n < 1 || n > state.doc.lines) return false;
    const next = state.doc.line(n);
    // the hidden run ahead is a few lines at most; on a long paper it may not be built yet
    const deco = dir < 0
      ? atomicDecoAt(state, Math.max(0, next.from - 2_000), line.to)
      : atomicDecoAt(state, line.from, Math.min(state.doc.length, next.to + 2_000));
    if (!hiddenLine(deco, next)) return false;
    while (n >= 1 && n <= state.doc.lines && hiddenLine(deco, state.doc.line(n))) n += dir;
    if (n < 1 || n > state.doc.lines) return true;
    const target = state.doc.line(n);
    const anchor = dir < 0 ? target.to : markerOn(state, deco, target)?.to ?? target.from;
    dispatch(state.update({ selection: { anchor }, scrollIntoView: true, userEvent: 'select' }));
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
