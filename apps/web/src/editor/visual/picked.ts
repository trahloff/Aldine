import { Decoration, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import type { EditorState, Range } from '@codemirror/state';
import { atomicField } from './atomicField';

// inclusive: a mark exactly as wide as a widget wraps it only if it opens before and closes after it
const picked = Decoration.mark({ class: 'cm-vis-picked', inclusive: true });

function build(state: EditorState): DecorationSet {
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  if (!ranges.length) return Decoration.none;
  const deco = state.field(atomicField).deco;
  const out: Range<Decoration>[] = [];
  for (const r of ranges) {
    deco.between(r.from, r.to, (from, to, d) => {
      if (d.spec.closed && from >= r.from && to <= r.to) out.push(picked.range(from, to));
    });
  }
  return Decoration.set(out, true);
}

/**
 * A chip, formula or table a selection covers whole stays drawn, its source
 * in the selection: it is marked, so what a copy or a delete takes shows.
 * Must come after atomicField, so the mark wraps the widget.
 */
export const pickedConstructs = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = build(view.state);
  }

  update(u: ViewUpdate) {
    if (u.selectionSet || u.docChanged || u.state.field(atomicField) !== u.startState.field(atomicField)) this.decorations = build(u.state);
  }
}, { decorations: (v) => v.decorations });
