import { StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Registry of live visual-mode views, so async resources (KaTeX, bibliography,
 * MathLive) can poke a redraw when they arrive.
 */
const views = new Set<EditorView>();

export function registerView(view: EditorView): void {
  views.add(view);
}
export function unregisterView(view: EditorView): void {
  views.delete(view);
}
/** Carried by a poke: the widget field rebuilds on it. An empty transaction
 *  is not enough, the field returns its old value when neither the document
 *  nor the reveal ranges changed, and the widgets drawn before the resource
 *  arrived would stay as they are. */
export const resourceArrived = StateEffect.define<{ from: number; to: number } | null>({
  map: (v, changes) => v && { from: changes.mapPos(v.from, -1), to: changes.mapPos(v.to, 1) },
});

/** Each view's viewport goes along: on a long document only that part is redrawn at once. */
export function pokeViews(): void {
  for (const v of views) v.dispatch({ effects: resourceArrived.of({ from: v.viewport.from, to: v.viewport.to }) });
}
