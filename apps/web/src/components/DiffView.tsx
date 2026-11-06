import { useMemo } from 'react';
import { parsePatch } from '../util/patch';

/** Renders a unified git patch with per-line coloring and, inside an edited
 *  line, the words that changed. The git header lines of each file collapse
 *  into one row naming the file: the reader is a researcher, not a git user. */
export default function DiffView({ patch }: { patch: string }) {
  const lines = useMemo(() => parsePatch(patch), [patch]);
  if (!patch.trim()) return <p style={{ color: 'var(--text-2)', fontSize: 'var(--text-m)', padding: 8 }}>No changes in this commit.</p>;
  return (
    <pre className="diff" data-testid="diff-view">
      {lines.map((l, i) => {
        if ((l.kind === 'add' || l.kind === 'del') && l.words) {
          const Mark = l.kind === 'add' ? 'ins' : 'del';
          return (
            <div key={i} className={`diff__${l.kind}`}>
              {l.text[0]}
              {l.words.map((s, k) => (s.changed ? <Mark key={k} className="diff__word" data-testid="diff-word">{s.text}</Mark> : s.text))}
            </div>
          );
        }
        return <div key={i} className={`diff__${l.kind}`}>{l.text}</div>;
      })}
    </pre>
  );
}
