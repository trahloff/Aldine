import { ViewPlugin, ViewUpdate, EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { DecorationSet } from '@codemirror/view';
import { revealField, RevealState } from './reveal';
import { buildMarks } from './decorations';

/** Viewport-only styling marks (headings, bold, italic, …). */
export const markPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private forReveal: RevealState;

    constructor(view: EditorView) {
      this.forReveal = view.state.field(revealField);
      this.decorations = buildMarks(view.state, this.forReveal.ranges, view.visibleRanges);
    }

    update(u: ViewUpdate) {
      const rv = u.state.field(revealField);
      // the tree also grows on its own while the parser catches up with a long file
      if (u.docChanged || u.viewportChanged || rv !== this.forReveal || syntaxTree(u.state) !== syntaxTree(u.startState)) {
        this.forReveal = rv;
        this.decorations = buildMarks(u.state, rv.ranges, u.view.visibleRanges);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
