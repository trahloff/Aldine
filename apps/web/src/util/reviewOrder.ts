/** What reviewOrder needs of a comment. */
export interface Ordered { file: string; anchor: { from: number }; createdAt: string }

/**
 * Review threads in the order a reader meets them: file by file in
 * `fileOrder` (the document's include order, root file first), then any
 * other file by path, and within a file by where the text is. Two threads on
 * one spot keep the order they were started in.
 */
export function reviewOrder<T extends Ordered>(list: readonly T[], fileOrder: readonly string[]): T[] {
  const rank = new Map(fileOrder.map((f, i) => [f, i]));
  return [...list].sort((a, b) => {
    const ra = rank.get(a.file) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.file) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.anchor.from - b.anchor.from || a.createdAt.localeCompare(b.createdAt);
  });
}
