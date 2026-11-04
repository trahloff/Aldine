/** A list that could not be fetched says so, with a way to ask again: an
 *  empty list in its place would read as data that is gone. */
export default function LoadError({ text, onRetry, testId }: { text: string; onRetry(): void; testId: string }) {
  return (
    <div role="alert" data-testid={testId} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: 8, color: 'var(--text-2)', fontSize: 'var(--text-s)' }}>
      <span>{text}</span>
      <button type="button" className="btn btn--small" onClick={onRetry} data-testid={`${testId}-retry`}>Try again</button>
    </div>
  );
}
