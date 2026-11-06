import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { showTooltip } from '@codemirror/view';
import { commentAtCaret, commentsAt, commentTips } from '../commentTips';
import { commentRangesField } from '../visual/suggestions';
import { setComments, type CommentRange } from '../commentsEffect';

const text = 'Intro text. The method works. End.';
const method: CommentRange = { id: 'm', from: 12, to: 29, resolved: false, author: 'Ada', body: 'Say which method.' };
const works: CommentRange = { id: 'w', from: 23, to: 28, resolved: false, author: 'Bo', body: 'Works how?' };

function state(at: number) {
  const s = EditorState.create({ doc: text, selection: EditorSelection.cursor(at), extensions: [commentRangesField, commentTips(() => {}, () => {})] });
  return s.update({ effects: setComments.of([method, works]) }).state;
}
const tips = (s: EditorState) => s.facet(showTooltip).filter(Boolean);

describe('commentsAt', () => {
  it('lists the comments holding a position, innermost first, and none past their end', () => {
    expect(commentsAt([method, works], 24, text.length).map((r) => r.id)).toEqual(['w', 'm']);
    expect(commentsAt([method, works], 12, text.length).map((r) => r.id)).toEqual(['m']);
    expect(commentsAt([method, works], 29, text.length)).toEqual([]);
    expect(commentsAt([{ ...method, to: 99 }], 20, text.length), 'a range the doc does not have yet').toEqual([]);
  });
});

describe('the caret card', () => {
  it('opens while the caret is in commented text', () => {
    expect(tips(state(5))).toHaveLength(0);
    const s = state(14);
    expect(commentAtCaret(s)).toBe('m');
    expect(tips(s)).toHaveLength(1);
    expect(tips(s)[0]!.pos).toBe(12);
  });

  it('goes away while typing in the comment, and comes back once the caret leaves and returns', () => {
    let s = state(14);
    s = s.update({ changes: { from: 14, insert: 'x' }, selection: EditorSelection.cursor(15), userEvent: 'input.type' }).state;
    expect(tips(s), 'typing puts it away').toHaveLength(0);
    s = s.update({ selection: EditorSelection.cursor(16), userEvent: 'select' }).state;
    expect(tips(s), 'moving within the same comment keeps it away').toHaveLength(0);
    s = s.update({ selection: EditorSelection.cursor(2), userEvent: 'select' }).state;
    s = s.update({ selection: EditorSelection.cursor(16), userEvent: 'select' }).state;
    expect(tips(s), 'back after leaving').toHaveLength(1);
  });

  it('is no caret card for a selection, but a selection of the whole comment names it', () => {
    const s = state(5).update({ selection: EditorSelection.range(12, 29) }).state;
    expect(tips(s)).toHaveLength(0);
    expect(commentAtCaret(s)).toBe(null);
    expect(commentAtCaret(s, true)).toBe('m');
  });

  it('never changes the document', () => {
    const s = state(24);
    expect(s.doc.toString()).toBe(text);
  });
});
