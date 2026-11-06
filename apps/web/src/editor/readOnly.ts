import { EditorState, type Extension } from '@codemirror/state';
import type * as Y from 'yjs';

/** One gate per doc: a doc kept across file switches gets a new editor, and
 *  this extension, on every visit. */
const gates = new WeakMap<Y.Doc, { remote: boolean }>();

function gateOf(ydoc: Y.Doc): { remote: boolean } {
  let gate = gates.get(ydoc);
  if (!gate) {
    const g = { remote: false };
    ydoc.on('beforeObserverCalls', (tr: Y.Transaction) => { g.remote = !tr.local; });
    ydoc.on('afterTransaction', () => { g.remote = false; });
    gates.set(ydoc, g);
    gate = g;
  }
  return gate;
}

/**
 * A document this editor may not change (a read-only showcase): no typing,
 * paste or command, and no programmatic insert either (a palette snippet,
 * the Visual toolbar). Only the collab binding gets through, applying the
 * server's updates: it dispatches them while Yjs runs the observers of a
 * remote transaction, which is when the gate is open.
 *
 * Listens on `ydoc` for as long as the doc lives.
 */
export function readOnlyDoc(ydoc: Y.Doc): Extension {
  const gate = gateOf(ydoc);
  return [
    EditorState.readOnly.of(true),
    EditorState.changeFilter.of(() => gate.remote),
  ];
}
