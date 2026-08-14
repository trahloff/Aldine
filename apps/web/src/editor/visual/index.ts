import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { revealField } from './reveal';
import { atomicField } from './atomicField';
import { markPlugin } from './markPlugin';
import { visualTheme } from './theme';
import { ensureKatex } from './katex';
import { registerView, unregisterView } from './refresh';
import { setVisualContext } from './context';
import { suggestField } from './suggestions';
import { docEditBridge } from './bridge';
import { htmlToLatex } from './html2latex';
import { openMathEditor, closeMathPopover } from './mathPopover';
import { remoteCaretReveal } from './remoteCarets';

/**
 * Clicking a rendered widget: math opens the MathLive editor; chips put the
 * caret inside their construct → cursor-reveal shows the source.
 */
const widgetClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    const t = (e.target as HTMLElement).closest?.('[data-pos].cm-vis-math, [data-pos].cm-vis-chip') as HTMLElement | null;
    if (!t?.dataset.pos) return false;
    if (t.classList.contains('cm-vis-math') && t.dataset.innerFrom) {
      const innerFrom = Number(t.dataset.innerFrom);
      const innerTo = Number(t.dataset.innerTo);
      e.preventDefault();
      openMathEditor(view, {
        innerFrom,
        innerTo,
        source: view.state.doc.sliceString(innerFrom, innerTo),
        rect: t.getBoundingClientRect(),
      });
      return true;
    }
    closeMathPopover();
    const pos = Math.min(Number(t.dataset.pos) + 1, view.state.doc.length);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
    return true;
  },
});

/** Rich-text paste converts to clean LaTeX instead of dumping plain text. */
const pasteLatex = EditorView.domEventHandlers({
  paste(e, view) {
    const html = e.clipboardData?.getData('text/html');
    if (!html) return false;
    // skip clipboard that is already LaTeX-ish plain text (own-editor copies)
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (/\\(section|textbf|begin|item|cite)\b/.test(text)) return false;
    const latex = htmlToLatex(html);
    if (!latex || latex === text.trim()) return false;
    e.preventDefault();
    view.dispatch(view.state.replaceSelection(latex));
    return true;
  },
});

/** Kick the lazy KaTeX chunk and keep the view re-measurable when it lands. */
const katexLifecycle = ViewPlugin.define((view) => {
  registerView(view);
  ensureKatex();
  return { destroy: () => unregisterView(view) };
});

/** Everything the visual mode needs from the hosting CodePane. */
export interface VisualDeps {
  projectId: string;
  branch: string;
  /** Root file path — image previews resolve \includegraphics against its dir. */
  rootFile?: string;
  ydoc: Y.Doc;
  awareness: Awareness;
}

/**
 * The Visual editing mode: a pure decoration layer over the shared Y.Text.
 * It never dispatches document changes — source bytes are only ever modified
 * by explicit user edits and the formatting commands in ./commands.ts.
 */
export function visualExtensions(deps: VisualDeps): Extension {
  setVisualContext(deps.projectId, deps.branch, deps.rootFile);
  return [revealField, atomicField, markPlugin, visualTheme, widgetClick, pasteLatex, katexLifecycle, suggestField, docEditBridge, remoteCaretReveal(deps.awareness)];
}
