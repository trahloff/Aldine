import { EditorState, type Extension } from '@codemirror/state';
import type * as Y from 'yjs';

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
  let remote = false;
  ydoc.on('beforeObserverCalls', (tr: Y.Transaction) => { remote = !tr.local; });
  ydoc.on('afterTransaction', () => { remote = false; });
  return [
    EditorState.readOnly.of(true),
    EditorState.changeFilter.of(() => remote),
  ];
}
