import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { revealField } from './reveal';
import { atomicDecoAt, atomicField, atomicFiller } from './atomicField';
import { macroField } from './macros';
import { markPlugin } from './markPlugin';
import { visualTheme } from './theme';
import { ensureKatex } from './katex';
import { registerView, unregisterView } from './refresh';
import { setVisualContext, type NoticeKind } from './context';
import { suggestField, commentRangesField } from './suggestions';
import { rangeTracker, widgetPos } from './positions';
import { pasteText, rawAt } from './clipboard';
import { openMathEditor, closeMathPopover, mathliveCanEdit, preloadMathlive } from './mathPopover';
import { peerOutlines } from './remoteCarets';
import { pickedConstructs } from './picked';
import { mathSpans } from './widgets/math';
import { focusTableAt } from './widgets/table';
import { chipCaret, labelsOnlyTail, mathParts } from './decorations';
import {
  backspaceHiddenLine, backspaceIntoConstruct, breakAfterHeading, deleteHiddenLine, deleteIntoConstruct, itemBackspace, itemDelete,
  itemHome, listItemEnter, markerOn, paragraphEnter, selectConstructBackward, selectConstructForward, visibleLineAbove,
} from './commands';
import { chipClicked, clickSequence, retargetsClick } from './clicks';

/** The construct a chip drawn at `at` stands for, as the atomic decorations have it. */
function chipRange(view: EditorView, at: number): { from: number; to: number } | null {
  let hit: { from: number; to: number } | null = null;
  view.state.field(atomicField).deco.between(at, at, (from, to, d) => {
    if (from === at && d.spec.closed) hit = { from, to };
  });
  return hit;
}

/**
 * Clicking a rendered widget: math opens the MathLive editor; chips put the
 * caret inside their construct (chipCaret) → cursor-reveal shows the source,
 * and a double-click selects the construct whole (clicks.ts).
 * Positions come from where the widget is now, never from when it was drawn.
 */
const widgetClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || retargetsClick(view, e)) return false;
    const t = (e.target as HTMLElement).closest?.('.cm-vis-math, .cm-vis-chip') as HTMLElement | null;
    if (!t) return false;
    const at = widgetPos(view, t);
    if (at == null) return false;
    const math = mathSpans.get(t);
    if (math) {
      if (view.state.doc.sliceString(at, at + math.raw.length) !== math.raw) return false;
      e.preventDefault();
      openMathEditor(view, { innerFrom: at + math.innerStart, innerTo: at + math.innerEnd, rect: t.getBoundingClientRect(), el: t });
      return true;
    }
    closeMathPopover();
    const unit = chipRange(view, at);
    if (unit) chipClicked(view, unit);
    view.dispatch({ selection: { anchor: chipCaret(view.state, at) }, scrollIntoView: true });
    view.focus();
    return true;
  },
});

/**
 * Rich-text paste converts to clean LaTeX; plain prose is escaped. Text
 * dragged in from elsewhere converts the same way; a drag out of an editor
 * is its own copy (recordOwnCopies sees it) and drops as it is.
 */
const pasteLatex = EditorView.domEventHandlers({
  paste(e, view) {
    const data = e.clipboardData;
    if (!data) return false;
    const latex = pasteText(data.getData('text/html'), data.getData('text/plain'), view.state.doc.toString(), rawAt(view.state, view.state.selection.main.head));
    if (latex == null) return false;
    e.preventDefault();
    view.dispatch(view.state.replaceSelection(latex), { userEvent: 'input.paste', scrollIntoView: true });
    return true;
  },
  drop(e, view) {
    const data = e.dataTransfer;
    if (!data || data.files.length || view.state.readOnly) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    const latex = pasteText(data.getData('text/html'), data.getData('text/plain'), view.state.doc.toString(), rawAt(view.state, pos));
    if (latex == null) return false;
    e.preventDefault();
    view.focus();
    view.dispatch({ changes: { from: pos, insert: latex }, selection: { anchor: pos, head: pos + latex.length }, userEvent: 'input.drop', scrollIntoView: true });
    return true;
  },
});

/** Kick the lazy KaTeX chunk and keep the view re-measurable when it lands; MathLive follows at idle. */
const katexLifecycle = ViewPlugin.define((view) => {
  registerView(view);
  ensureKatex();
  preloadMathlive();
  return {
    destroy: () => {
      unregisterView(view);
      closeMathPopover();
    },
  };
});

/**
 * A cursor at the end of a rendered heading's line sits after its hidden `}`,
 * where typing would land outside the heading: End, a click past the text
 * and arrowing into the line all put it before the brace instead. Once the
 * caret is inside, the heading shows its source and the brace can be passed.
 */
const headingCloserStop = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged || tr.selection.ranges.length > 1) return tr;
  const head = tr.selection.main;
  if (!head.empty) return tr;
  if (tr.startState.field(atomicField, false) === undefined) return tr;
  const line = tr.startState.doc.lineAt(head.head);
  if (head.head !== line.to) return tr;
  const deco = atomicDecoAt(tr.startState, line.from, line.to);
  if (!deco) return tr;
  let stop = -1;
  deco.between(line.from, line.to, (from, to, d) => {
    if (to === line.to && d.spec.headingCloser) stop = from;
  });
  if (stop < 0) return tr;
  return [tr, { selection: EditorSelection.cursor(stop), sequential: true }];
});

/**
 * A caret at or before a bullet, where typing would land before `\item` (in
 * the previous item, or outside any item): a click there, an arrow up or
 * down onto the line or Delete from above puts it after the bullet instead.
 * Arrowing left from the item's text goes on to the line above that shows.
 */
const itemMarkerStop = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged || tr.selection.ranges.length > 1) return tr;
  const sel = tr.selection.main;
  if (!sel.empty || tr.startState.field(atomicField, false) === undefined) return tr;
  const state = tr.startState;
  const line = state.doc.lineAt(sel.head);
  const marker = markerOn(state, atomicDecoAt(state, line.from, line.to), line);
  if (!marker || sel.head > marker.from) return tr;
  const prev = state.selection.main;
  if (!tr.isUserEvent('select.pointer') && prev.empty && prev.head === marker.to) {
    const above = visibleLineAbove(state, line.number);
    if (above) return [tr, { selection: EditorSelection.cursor(above.to), sequential: true }];
  }
  return [tr, { selection: EditorSelection.cursor(marker.to), sequential: true }];
});

/**
 * Typing a letter right after a control word Visual hides (an `\item` with
 * no space after it, `\ldots` drawn as …) would run into the command name
 * and break it: a space goes between them, which TeX drops.
 */
const controlWordGap = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || !/^[A-Za-z]/.test(text) || view.state.selection.ranges.length > 1) return false;
  let word = false;
  view.state.field(atomicField).deco.between(from, from, (a, b) => {
    if (b === from && /\\[A-Za-z]+$/.test(view.state.doc.sliceString(a, b))) word = true;
  });
  if (!word) return false;
  view.dispatch({ changes: { from, insert: ` ${text}` }, selection: { anchor: from + 1 + text.length }, scrollIntoView: true, userEvent: 'input.type' });
  return true;
});

function innermost(state: EditorState, pos: number, test: (n: SyntaxNode) => boolean): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (test(n)) return n;
    }
  }
  return null;
}

/**
 * Mod-Enter with the caret in a construct that has a visual editor: a
 * formula opens the formula editor, a table moves the caret below it and puts
 * focus in its grid, and a citation, reference or figure beside the caret
 * shows its source with the caret where its chip's click puts it. 'source'
 * is a formula the formula editor would rewrite, already shown as the source
 * the caret is in; null is none of these.
 */
function openAtCursor(view: EditorView): 'opened' | 'source' | null {
  const { state } = view;
  const pos = state.selection.main.head;
  const math = innermost(state, pos, (n) => mathParts(n.name, n, state.doc) !== null);
  if (math) {
    const parts = mathParts(math.name, math, state.doc)!;
    if (!mathliveCanEdit(state.doc.sliceString(parts.innerFrom, parts.innerTo))) return 'source';
    const a = view.coordsAtPos(math.from);
    const b = view.coordsAtPos(math.to);
    if (!a || !b) return null;
    const rect = new DOMRect(a.left, Math.min(a.top, b.top), Math.max(1, b.right - a.left), Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top));
    openMathEditor(view, { innerFrom: parts.innerFrom, innerTo: parts.innerTo, rect });
    return 'opened';
  }
  // a chip at the caret's edge opens its source, which arrows step over
  const chip = innermost(state, pos, (n) => (n.name === 'Cite' || n.name === 'Ref' || n.name === 'FigureEnvironment') && (n.from === pos || n.to === pos));
  if (chip) {
    view.dispatch({ selection: { anchor: chipCaret(state, chip.from) }, scrollIntoView: true });
    return 'opened';
  }
  const table = innermost(state, pos, (n) => n.name === 'TabularEnvironment');
  if (table) {
    // the grid only draws while no caret is in its (or its table's) source
    const outer = innermost(state, table.from, (n) => n.name === 'TableEnvironment' && n.from <= table.from && n.to >= table.to) ?? table;
    const below = state.doc.sliceString(outer.to, outer.to + 1) === '\n' ? outer.to + 1 : outer.to;
    view.dispatch({ selection: { anchor: below }, scrollIntoView: true });
    focusTableAt(view, table.from);
    return 'opened';
  }
  return null;
}

/** Mod-Enter's formula and table editors for a command outside the keymap; null outside Visual mode too. */
export function editAtCursor(view: EditorView): 'opened' | 'source' | null {
  return view.state.field(atomicField, false) === undefined ? null : openAtCursor(view);
}

/**
 * End inside a heading whose `}` ends its line (or is followed by nothing
 * but its \label) goes to the end of the heading text, before the brace (where a click past the text lands too); only an
 * arrow key passes the brace.
 */
function headingEnd(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const cmd = innermost(state, sel.head, (n) => n.name === 'SectioningCommand');
  const close = cmd?.getChild('SectioningArgument')?.getChild('CloseBrace');
  if (!cmd || !close || close.to !== cmd.to || sel.head > close.from) return false;
  const line = state.doc.lineAt(sel.head);
  if (close.to > line.to || !labelsOnlyTail(state.doc.sliceString(close.to, line.to))) return false;
  if (sel.head < close.from) view.dispatch({ selection: { anchor: close.from }, scrollIntoView: true, userEvent: 'select' });
  return true;
}

/** Everything the visual mode needs from the hosting CodePane. */
export interface VisualDeps {
  projectId: string;
  branch: string;
  /** Root file path — image previews resolve \includegraphics against its dir. */
  rootFile?: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  /** Shows a short message to the person: a widget edit that could not be written or a widget that failed ('error'), why a widget opened its source ('info'). */
  notify?: (text: string, kind: NoticeKind) => void;
}

/**
 * The Visual editing mode: a pure decoration layer over the shared Y.Text.
 * It never dispatches document changes on its own — source bytes are only
 * ever modified by explicit user edits, the widget editors (table cells, the
 * formula editor) and the formatting commands in ./commands.ts.
 */
export { recordOwnCopies } from './clipboard';
export { publishEditorFocus } from './remoteCarets';

export function visualExtensions(deps: VisualDeps): Extension {
  setVisualContext(deps.projectId, deps.branch, deps.rootFile, deps.notify);
  return [
    revealField, macroField, atomicField, atomicFiller, markPlugin, visualTheme, widgetClick, clickSequence, pasteLatex, katexLifecycle,
    // after atomicField: a mark of lower precedence than a widget wraps it
    pickedConstructs, peerOutlines(deps.awareness),
    commentRangesField, suggestField, rangeTracker, headingCloserStop, itemMarkerStop, controlWordGap,
    Prec.high(keymap.of([
      // elsewhere, and in a formula that only edits as source, Mod-Enter keeps its usual meaning
      { key: 'Mod-Enter', run: (view) => openAtCursor(view) === 'opened' },
      { key: 'Enter', run: breakAfterHeading, shift: breakAfterHeading },
      { key: 'Enter', run: listItemEnter },
      { key: 'Enter', run: paragraphEnter },
      { key: 'Backspace', run: itemBackspace },
      { key: 'Backspace', run: selectConstructBackward },
      { key: 'Backspace', run: backspaceIntoConstruct },
      { key: 'Backspace', run: backspaceHiddenLine },
      { key: 'Delete', run: itemDelete },
      { key: 'Delete', run: selectConstructForward },
      { key: 'Delete', run: deleteIntoConstruct },
      { key: 'Delete', run: deleteHiddenLine },
      { key: 'Home', run: itemHome(false), shift: itemHome(true) },
      { mac: 'Cmd-ArrowLeft', run: itemHome(false), shift: itemHome(true) },
      { key: 'End', run: headingEnd },
      { mac: 'Cmd-ArrowRight', run: headingEnd },
    ])),
  ];
}
