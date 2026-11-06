import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import * as Y from 'yjs';
import { readOnlyDoc } from '../readOnly';

describe('readOnlyDoc', () => {
  it('refuses every change made here, typed or programmatic', () => {
    const ydoc = new Y.Doc();
    const state = EditorState.create({ doc: 'Hello', extensions: readOnlyDoc(ydoc) });
    expect(state.readOnly).toBe(true);
    const typed = state.update({ changes: { from: 5, insert: ' world' }, userEvent: 'input.type' }).state;
    expect(typed.doc.toString()).toBe('Hello');
    const inserted = state.update(state.replaceSelection('\\begin{figure}')).state;
    expect(inserted.doc.toString()).toBe('Hello');
  });

  it('lets through what the collab binding applies for a remote update', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    let state = EditorState.create({ doc: '', extensions: readOnlyDoc(ydoc) });
    // what y-codemirror does: mirror a Yjs change into the editor from its observer
    ytext.observe((e) => {
      let pos = 0;
      for (const d of e.delta) {
        if (typeof d.insert === 'string') { state = state.update({ changes: { from: pos, insert: d.insert } }).state; pos += d.insert.length; }
        else if (d.retain) pos += d.retain;
      }
    });
    const server = new Y.Doc();
    server.getText('content').insert(0, 'From the server');
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(server));
    expect(state.doc.toString()).toBe('From the server');

    // the gate closes again with the transaction
    expect(state.update({ changes: { from: 0, insert: 'x' } }).state.doc.toString()).toBe('From the server');
    // and a transaction of this client's own never opens it
    ytext.insert(0, 'Local ');
    expect(state.doc.toString()).toBe('From the server');
  });

  it('listens on a doc once, however many editors it is opened in', () => {
    const ydoc = new Y.Doc();
    const on = vi.spyOn(ydoc, 'on');
    readOnlyDoc(ydoc);
    const again = readOnlyDoc(ydoc);
    expect(on).toHaveBeenCalledTimes(2); // beforeObserverCalls and afterTransaction
    let state = EditorState.create({ doc: '', extensions: again });
    ydoc.getText('content').observe((e) => {
      const insert = e.delta.find((d) => typeof d.insert === 'string')?.insert as string | undefined;
      if (insert) state = state.update({ changes: { from: 0, insert } }).state;
    });
    const server = new Y.Doc();
    server.getText('content').insert(0, 'Shared');
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(server));
    expect(state.doc.toString()).toBe('Shared');
  });
});
