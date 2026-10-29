import type { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { SECTION_RANK } from './decorations';

export interface OutlineEntry { level: number; title: string; line: number }

/** Headings of the document, in order, for the Contents dropdown. */
export function documentOutline(state: EditorState): OutlineEntry[] {
  // The tree ensureSyntaxTree returns: syntaxTree(state) is the one the
  // state was made with, and the background parse stops 100,000 characters
  // past the viewport, so on a long paper it lacks the last chapters.
  const tree = ensureSyntaxTree(state, state.doc.length, 300) ?? syntaxTree(state);
  const out: OutlineEntry[] = [];
  tree.iterate({
    enter(n) {
      const rank = SECTION_RANK[n.name];
      if (!rank) return;
      const cmd = n.node.getChild('SectioningCommand');
      const arg = cmd?.getChild('SectioningArgument');
      const open = arg?.getChild('OpenBrace');
      const close = arg?.getChild('CloseBrace');
      if (!cmd || !open || !close) return;
      out.push({
        level: rank,
        title: state.doc.sliceString(open.to, close.from).trim().slice(0, 80) || '(untitled)',
        line: state.doc.lineAt(cmd.from).number,
      });
    },
  });
  return out;
}
