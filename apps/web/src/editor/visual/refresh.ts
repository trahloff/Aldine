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
export const resourceArrived = StateEffect.define<null>();

export function pokeViews(): void {
  for (const v of views) v.dispatch({ effects: resourceArrived.of(null) });
}
