/** Renders a unified git patch with per-line coloring. The four git header
 *  lines of each file (diff --git, index, ---, +++) collapse into one row
 *  naming the file: the reader is a researcher, not a git user. */
export default function DiffView({ patch }: { patch: string }) {
  if (!patch.trim()) return <p style={{ color: 'var(--text-2)', fontSize: 13, padding: 8 }}>No changes in this commit.</p>;
  const lines = patch.split('\n');
  return (
    <pre className="diff" data-testid="diff-view">
      {lines.map((l, i) => {
        let cls = 'diff__ctx';
        let text = l || ' ';
        if (l.startsWith('diff --git')) {
          cls = 'diff__file';
          const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
          text = m ? (m[1] === m[2] ? m[1] : `${m[1]} → ${m[2]}`) : l;
        } else if (l.startsWith('index ') || l.startsWith('--- ') || l.startsWith('+++ ') || l.startsWith('new file mode') || l.startsWith('deleted file mode')) {
          return null;
        } else if (l.startsWith('@@')) cls = 'diff__hunk';
        else if (l.startsWith('+')) cls = 'diff__add';
        else if (l.startsWith('-')) cls = 'diff__del';
        return <div key={i} className={cls}>{text}</div>;
      })}
    </pre>
  );
}
