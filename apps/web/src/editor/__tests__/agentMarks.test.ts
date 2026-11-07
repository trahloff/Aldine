import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { Text } from '@codemirror/state';
import { AGENT_EDITS_KEY, markedLines, resolveMarks } from '../agentMarks';

/** What the server writes for an agent span (collab.ts markAgentSpans). */
function mark(doc: Y.Doc, key: string, from: number, to: number, t: number) {
  const text = doc.getText('content');
  const rel = (i: number, assoc?: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, i, assoc));
  doc.getMap(AGENT_EDITS_KEY).set(key, to > from ? { k: 'ins', a: rel(from), b: rel(to, -1), t } : { k: 'del', a: rel(from), t });
}

describe('resolveMarks', () => {
  it('keeps a span on the text Claude wrote while people type around it', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'intro CLAUDE outro');
    mark(doc, 'm1', 6, 12, 100);
    text.insert(0, 'xx'); // before the span
    text.insert(14, '!'); // right after it: does not grow it
    text.insert(8, '>'); // right before it: does not grow it either
    const [m] = resolveMarks(doc, text);
    expect(text.toString().slice(m.from, m.to)).toBe('CLAUDE');
    expect(m).toMatchObject({ kind: 'ins', t: 100, key: 'm1' });
  });

  it('drops a span whose text is all gone, keeps a deletion point', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'keep GONE keep');
    mark(doc, 'ins', 5, 9, 1);
    mark(doc, 'del', 10, 10, 2);
    text.delete(5, 4);
    const marks = resolveMarks(doc, text);
    expect(marks.map((m) => m.key)).toEqual(['del']);
    expect(marks[0]).toMatchObject({ kind: 'del', from: 6, to: 6 });
  });

  it('ignores entries it cannot read', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'abc');
    doc.getMap(AGENT_EDITS_KEY).set('junk', { k: 'ins', a: 'nope', t: 1 });
    doc.getMap(AGENT_EDITS_KEY).set('no-time', { k: 'del', a: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 1)) });
    expect(resolveMarks(doc, text)).toEqual([]);
  });
});

describe('markedLines', () => {
  const doc = Text.of(['one', 'two', 'three', 'four']);
  const at = (line: number, col = 0) => doc.line(line).from + col;

  it('marks every line an unseen insert touches, and the line of a deletion', () => {
    const marks = [
      { key: 'a', kind: 'ins' as const, from: at(2, 1), to: at(3, 2), t: 20 },
      { key: 'b', kind: 'del' as const, from: at(4, 2), to: at(4, 2), t: 20 },
    ];
    expect(markedLines(doc, marks, 10)).toEqual([{ line: 2, kind: 'ins' }, { line: 3, kind: 'ins' }, { line: 4, kind: 'del' }]);
  });

  it('a line holding a deletion and an insert reads as changed', () => {
    const marks = [
      { key: 'a', kind: 'del' as const, from: at(1, 1), to: at(1, 1), t: 20 },
      { key: 'b', kind: 'ins' as const, from: at(1, 2), to: at(1, 3), t: 20 },
    ];
    expect(markedLines(doc, marks, 0)).toEqual([{ line: 1, kind: 'ins' }]);
  });

  it('an insert ending in a newline marks only the line it wrote', () => {
    const marks = [{ key: 'a', kind: 'ins' as const, from: at(2), to: at(3), t: 5 }];
    expect(markedLines(doc, marks, 0)).toEqual([{ line: 2, kind: 'ins' }]);
  });

  it('shows nothing seen, and nothing while the review mark is unknown', () => {
    const marks = [{ key: 'a', kind: 'ins' as const, from: at(1), to: at(1, 3), t: 5 }];
    expect(markedLines(doc, marks, 5)).toEqual([]);
    expect(markedLines(doc, marks, null)).toEqual([]);
  });
});
