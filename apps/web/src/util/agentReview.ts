import type { AgentActivity } from '../api';

export type AgentBatch = Omit<AgentActivity, 'sessionActive'>;

const sameMark = (a: AgentBatch['since'], b: AgentBatch['since']) =>
  (a?.head ?? '') === (b?.head ?? '') && (a?.at ?? '') === (b?.at ?? '');

/**
 * One review prompt is on screen at a time, so a newer batch replaces the
 * prompt for an older one. Acknowledging the replacement moves the mark past
 * both, so it has to carry both. `commits` stays newest first and capped at
 * `limit`; the counts are a floor where the capped lists cannot tell overlap.
 */
export function mergeAgentBatches(older: AgentBatch, newer: AgentBatch, limit: number): AgentBatch {
  // Counted from the same mark, the newer answer already holds the older batch.
  if (sameMark(older.since, newer.since)) return newer;
  const listed = new Set(newer.commits.map((c) => c.hash));
  const extra = older.commits.filter((c) => !listed.has(c.hash));
  const commits = [...newer.commits, ...extra].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const files = new Set(commits.flatMap((c) => c.files));
  return {
    since: older.since,
    head: newer.head,
    commits: commits.slice(0, limit),
    commitCount: newer.commitCount + older.commitCount - (older.commits.length - extra.length),
    fileCount: Math.max(files.size, older.fileCount, newer.fileCount),
    truncated: older.truncated || newer.truncated,
  };
}
