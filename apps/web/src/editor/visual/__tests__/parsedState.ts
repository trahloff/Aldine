import { EditorState, type EditorStateConfig } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';

/**
 * A state whose syntax tree covers the whole document, and whose fields were
 * computed from that tree. A new state holds whatever 20 ms of parsing
 * reached, which on a loaded machine stops short even on a few lines.
 * ensureSyntaxTree finishes the parse, but only a later transaction adopts
 * the tree, and only one that sets the selection makes revealField read it.
 */
export function parsedState(config: EditorStateConfig): EditorState {
  const s = EditorState.create(config);
  if (!ensureSyntaxTree(s, s.doc.length, 5_000)) throw new Error('the parse did not finish');
  return s.update({ selection: s.selection }).state;
}
