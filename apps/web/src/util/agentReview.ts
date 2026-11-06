import type { AgentActivity } from '../api';
import { dayAgo, shortDate } from './dates';

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

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * What the Revert confirmation says: whose commits go (Claude's), when they
 * were made, and whose name the undoing commit carries.
 */
export function revertSummary(r: { commits: number; files: number; branch: string; dates: string[]; author: string | null }, now = Date.now()): string {
  const times = r.dates.map((d) => Date.parse(d)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  let when = '';
  if (times.length) {
    const first = new Date(times[0]).toISOString(), last = new Date(times[times.length - 1]).toISOString();
    const a = dayAgo(first, now), b = dayAgo(last, now);
    when = a === b ? ` ${b}` : ` between ${shortDate(first, now)} and ${shortDate(last, now)}`;
  }
  const by = r.author ? `under your name, ${r.author}` : 'under your name';
  return `This undoes ${plural(r.commits, 'commit')} Claude made on ${r.branch}${when}, in ${plural(r.files, 'file')}. `
    + `It adds a new commit ${by}; the history keeps both, and Undo brings the changes back.`;
}

/** "Claude (for Ada)": who asked, from the commits' requester trailers; the
 *  server names the presence the same way (collab.ts agentDisplayName). */
export function agentName(requesters: Iterable<string | undefined>): string {
  const names = [...new Set([...requesters].filter((n): n is string => !!n))];
  return names.length ? `Claude (for ${names.join(', ')})` : 'Claude';
}
