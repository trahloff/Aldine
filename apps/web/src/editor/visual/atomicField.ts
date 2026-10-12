import { StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { revealField, RevealState } from './reveal';
import { buildAtomic } from './decorations';
import { resourceArrived } from './refresh';

interface AtomicValue { deco: DecorationSet; forReveal: RevealState }

/**
 * Full-document replace decorations (hidden markup, widgets) plus the matching
 * atomic ranges so the caret skips over hidden spans. Rebuilds only when the
 * document or the reveal set actually changed; widget DOM stays lazy (CM calls
 * toDOM only for the viewport), so full-doc building stays cheap.
 */
export const atomicField = StateField.define<AtomicValue>({
  create(state) {
    const rv = state.field(revealField);
    return { deco: buildAtomic(state, rv.ranges), forReveal: rv };
  },
  update(value, tr) {
    const rv = tr.state.field(revealField);
    if (!tr.docChanged && rv === value.forReveal && !tr.effects.some((e) => e.is(resourceArrived))) return value;
    return { deco: buildAtomic(tr.state, rv.ranges), forReveal: rv };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).deco),
  ],
});
