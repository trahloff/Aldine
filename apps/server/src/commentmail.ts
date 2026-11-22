import { config } from './config.js';
import { db } from './db/index.js';
import type { Comment, ProjectMeta } from './db/types.js';
import { emailConfigured, escapeHtml, sendMail, type Mail } from './email.js';

/**
 * The email a person gets when someone @mentions them in a review comment or
 * assigns them a thread. Sent only by an instance with a transport (the
 * e2e suite reads logged mails under ALDINE_TEST_HOOKS) and a public URL to
 * link to; never to the person who acted, to an account without a confirmed
 * address, or to one that turned the emails off (Account settings).
 */

export type CommentEvent = 'mention' | 'assign';

/** Mails one person may get from comments per hour: a burst of edits to a
 *  thread is one conversation, not a reason to flood an inbox. */
const PER_HOUR = 30;
const sent = new Map<string, number[]>();
function take(userId: string, now = Date.now()): boolean {
  const recent = (sent.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_HOUR) { sent.set(userId, recent); return false; }
  recent.push(now);
  sent.set(userId, recent);
  return true;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The link that opens the project at this thread. */
export const commentLink = (projectId: string, c: Pick<Comment, 'id' | 'branch'>) =>
  `${config.publicUrl}/p/${encodeURIComponent(projectId)}?${c.branch !== 'main' ? `branch=${encodeURIComponent(c.branch)}&` : ''}comment=${encodeURIComponent(c.id)}`;

export function commentMail(to: string, m: { event: CommentEvent; actor: string; project: string; quote: string; text: string; link: string }): Mail {
  const actor = clip(m.actor, 80) || 'Someone';
  const project = clip(m.project, 120) || 'Untitled project';
  const what = m.event === 'assign' ? `${actor} assigned you a comment in “${project}”` : `${actor} mentioned you in “${project}”`;
  const quote = clip(m.quote.replace(/\s+/g, ' ').trim(), 200);
  const text = clip(m.text.trim(), 1000);
  const off = 'You get this email because of your Aldine account. Turn them off in Aldine under Account settings → Email me about comments.';
  return {
    to,
    subject: what,
    text: `${what}.\n\nOn the passage: “${quote}”\n\n${text}\n\nOpen the comment:\n${m.link}\n\n${off}`,
    html: `<p>${escapeHtml(what)}.</p><p style="color:#555">On the passage: “${escapeHtml(quote)}”</p><blockquote style="margin:0 0 1em;padding-left:1em;border-left:3px solid #ccc;white-space:pre-wrap">${escapeHtml(text)}</blockquote><p><a href="${escapeHtml(m.link)}" style="display:inline-block;padding:10px 18px;background:#1f4fd1;color:#ffffff;border-radius:6px;text-decoration:none">Open the comment</a></p><p style="color:#555">${escapeHtml(off)}</p>`,
  };
}

/** Email each of `recipients` about `event` on thread `c`; `text` is what
 *  mentioned them (the comment or the reply) or the thread for an assignment.
 *  Fire and forget: a mail failure never fails the request that caused it. */
export function notifyComment(meta: ProjectMeta, c: Comment, event: CommentEvent, recipients: string[], actor: { id?: string; name: string }, text: string): void {
  if (!config.publicUrl || (!emailConfigured() && process.env.ALDINE_TEST_HOOKS !== '1')) return;
  const link = commentLink(meta.id, c);
  for (const id of new Set(recipients)) {
    if (id === actor.id) continue;
    void (async () => {
      const u = await db().getUser(id);
      if (!u?.email || u.emailPending || u.disabledAt || u.commentMail === 'off' || !take(id)) return;
      await sendMail(commentMail(u.email, { event, actor: actor.name, project: meta.name, quote: c.anchor.quote, text, link }));
    })().catch((err) => console.error('[aldine] comment email failed:', err?.message || err));
  }
}
