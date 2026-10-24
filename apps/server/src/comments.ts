import crypto from 'node:crypto';
import { db } from './db/index.js';
import type { Comment } from './db/types.js';

/**
 * Review comments — anchored to a text range in a file, threaded, resolvable,
 * optionally carrying a suggested replacement the author can accept. Persisted
 * per project through the DataStore; this module owns validation and caps.
 */

export type { Reply, Comment } from './db/types.js';

const MAX_COMMENTS = 2000;
const cap = (s: string | undefined, n: number) => (s == null ? s : s.slice(0, n));

export async function listComments(projectId: string, branch: string): Promise<Comment[]> {
  return (await db().loadComments(projectId)).filter((c) => c.branch === branch).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addComment(projectId: string, c: Omit<Comment, 'id' | 'createdAt' | 'resolved' | 'replies'>): Promise<Comment> {
  const list = await db().loadComments(projectId);
  if (list.length >= MAX_COMMENTS) throw new Error('comment limit reached for this project');
  const comment: Comment = {
    ...c,
    body: cap(c.body, 8000)!,
    suggestion: cap(c.suggestion, 8000),
    anchor: { ...c.anchor, quote: cap(c.anchor.quote, 2000)! },
    id: crypto.randomBytes(8).toString('base64url'),
    createdAt: new Date().toISOString(),
    resolved: false,
    replies: [],
  };
  list.push(comment);
  await db().saveComments(projectId, list);
  return comment;
}

export async function replyComment(projectId: string, id: string, author: string, body: string, authorId?: string): Promise<Comment | null> {
  const list = await db().loadComments(projectId);
  const c = list.find((x) => x.id === id);
  if (!c) return null;
  if (c.replies.length >= 500) throw new Error('reply limit reached');
  c.replies.push({ author, ...(authorId ? { authorId } : {}), body: cap(body, 8000)!, createdAt: new Date().toISOString() });
  await db().saveComments(projectId, list);
  return c;
}

export async function resolveComment(projectId: string, id: string, resolved: boolean): Promise<Comment | null> {
  const list = await db().loadComments(projectId);
  const c = list.find((x) => x.id === id);
  if (!c) return null;
  c.resolved = resolved;
  await db().saveComments(projectId, list);
  return c;
}

export async function deleteComment(projectId: string, id: string): Promise<void> {
  const list = await db().loadComments(projectId);
  await db().saveComments(projectId, list.filter((c) => c.id !== id));
}
