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
import { setVisualContext } from './context';
import { suggestField, commentRangesField } from './suggestions';
import { rangeTracker, widgetPos } from './positions';
import { pasteText, rawAt } from './clipboard';
import { openMathEditor, closeMathPopover, mathliveCanEdit, preloadMathlive } from './mathPopover';
import { remoteCaretReveal } from './remoteCarets';
import { mathSpans } from './widgets/math';
import { focusTableAt } from './widgets/table';
import { labelsOnlyTail, mathParts } from './decorations';
import { backspaceHiddenLine, breakAfterHeading, deleteHiddenLine, listItemEnter, paragraphEnter } from './commands';

/**
 * Clicking a rendered widget: math opens the MathLive editor; chips put the
 * caret inside their construct → cursor-reveal shows the source. Positions
 * come from where the widget is now, never from when it was drawn.
 */
const widgetClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0) return false;
    const t = (e.target as HTMLElement).closest?.('.cm-vis-math, .cm-vis-chip') as HTMLElement | null;
    if (!t) return false;
    const at = widgetPos(view, t);
    if (at == null) return false;
    const math = mathSpans.get(t);
    if (math) {
      if (view.state.doc.sliceString(at, at + math.raw.length) !== math.raw) return false;
      e.preventDefault();
      openMathEditor(view, { innerFrom: at + math.innerStart, innerTo: at + math.innerEnd, rect: t.getBoundingClientRect() });
      return true;
    }
    closeMathPopover();
    view.dispatch({ selection: { anchor: Math.min(at + 1, view.state.doc.length) }, scrollIntoView: true });
    view.focus();
    return true;
  },
});

/** Rich-text paste converts to clean LaTeX; plain prose is escaped. */
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
 * focus in its grid. 'source' is a formula the formula editor would rewrite,
 * already shown as the source the caret is in; null is neither construct.
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
  /** Shows a short message to the person, for a widget edit that could not be written. */
  notify?: (text: string) => void;
}

/**
 * The Visual editing mode: a pure decoration layer over the shared Y.Text.
 * It never dispatches document changes on its own — source bytes are only
 * ever modified by explicit user edits, the widget editors (table cells, the
 * formula editor) and the formatting commands in ./commands.ts.
 */
export { recordOwnCopies } from './clipboard';

export function visualExtensions(deps: VisualDeps): Extension {
  setVisualContext(deps.projectId, deps.branch, deps.rootFile, deps.notify);
  return [
    revealField, macroField, atomicField, atomicFiller, markPlugin, visualTheme, widgetClick, pasteLatex, katexLifecycle,
    commentRangesField, suggestField, rangeTracker, remoteCaretReveal(deps.awareness), headingCloserStop,
    Prec.high(keymap.of([
      // elsewhere, and in a formula that only edits as source, Mod-Enter keeps its usual meaning
      { key: 'Mod-Enter', run: (view) => openAtCursor(view) === 'opened' },
      { key: 'Enter', run: breakAfterHeading, shift: breakAfterHeading },
      { key: 'Enter', run: listItemEnter },
      { key: 'Enter', run: paragraphEnter },
      { key: 'Backspace', run: backspaceHiddenLine },
      { key: 'Delete', run: deleteHiddenLine },
      { key: 'End', run: headingEnd },
      { mac: 'Cmd-ArrowRight', run: headingEnd },
    ])),
  ];
}
