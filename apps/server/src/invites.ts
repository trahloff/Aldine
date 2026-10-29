import crypto from 'node:crypto';
import type { Mail } from './email.js';
import type { Invitation } from './db/types.js';

/** Why some addresses were not mailed. One per response: the first cause hit. */
export type NotEmailedReason = 'accounts-off' | 'no-mail' | 'unconfirmed' | 'failed';

export interface InviteReport {
  invited: number;
  notEmailed: string[];
  reason?: NotEmailedReason;
}

/** Days a pending invitation stays open; Resend and Invite again start the count anew. */
export const INVITE_TTL_DAYS = 14;
export const INVITE_ID_RE = /^[0-9a-f]{32}$/;
/** 128 random bits: a link nobody was sent cannot be found by trying. */
export const newInvitationId = () => crypto.randomBytes(16).toString('hex');
export const inviteExpiry = (from = Date.now()) => new Date(from + INVITE_TTL_DAYS * 864e5).toISOString();

export const isOrcidId = (s: string) => /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(s);
/** No control characters: the address reaches a mail header and the datastore. */
export const isEmailAddress = (s: string) => /^[^@\s\u0000-\u001f\u007f]+@[^@\s\u0000-\u001f\u007f]+\.[^@\s\u0000-\u001f\u007f]+$/.test(s);
/** An entry as the share list stores it: an ORCID iD in upper case, an address in lower case. */
export const normalizeEntry = (c: string) => (isOrcidId(c) ? c.toUpperCase() : c.toLowerCase());

export type InvitationState = 'pending' | 'expired' | 'accepted' | 'declined' | 'withdrawn';

export function stateOf(inv: Invitation, now = Date.now()): InvitationState {
  if (inv.status === 'pending' && Date.parse(inv.expiresAt) <= now) return 'expired';
  return inv.status;
}

/** What an account may accept: invitations to its confirmed address, and to
 *  its ORCID iD. An address nobody confirmed is whatever was typed at sign-up. */
export function recipientKeys(user: { email: string | null; orcid?: string; emailPending?: true } | null): string[] {
  if (!user) return [];
  const keys: string[] = [];
  if (user.email && !user.emailPending) keys.push(user.email.toLowerCase());
  if (user.orcid) keys.push(user.orcid.toUpperCase());
  return keys;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** One line, at most `max` characters: both names reach the subject header
 *  and are chosen by whoever owns the project. */
export function clip(s: string, max: number): string {
  const line = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export const OWNER_NAME_MAX = 60;
export const PROJECT_NAME_MAX = 100;

/** The invitation. Owner and project names are the owner's own text: plain in
 *  the text part and the subject, escaped in the HTML part. The only link is
 *  the invitation on this instance's configured public URL. */
export function invitationMail(to: string, ownerName: string, projectName: string, inviteUrl: string): Mail {
  const owner = clip(ownerName, OWNER_NAME_MAX) || 'Someone';
  const project = clip(projectName, PROJECT_NAME_MAX) || 'Untitled project';
  const how = `To accept, open the link and sign in or create an account with this address (${to}). The invitation works only for this address, and it expires in ${INVITE_TTL_DAYS} days.`;
  const ignore = 'If you do not know them, ignore this email: nothing happens unless you accept.';
  return {
    to,
    subject: `${owner} invited you to “${project}” on Aldine`,
    text: `Hi there,\n\n${owner} invited you to the LaTeX project “${project}” on Aldine, a collaborative LaTeX editor.\n\n${how}\n\nAccept the invitation:\n${inviteUrl}\n\n${ignore}`,
    html: `<p>Hi there,</p><p>${escapeHtml(owner)} invited you to the LaTeX project “${escapeHtml(project)}” on Aldine, a collaborative LaTeX editor.</p><p>${escapeHtml(how)}</p><p><a href="${escapeHtml(inviteUrl)}" style="display:inline-block;padding:10px 18px;background:#1f4fd1;color:#ffffff;border-radius:6px;text-decoration:none">Accept the invitation</a></p><p>${escapeHtml(ignore)}</p>`,
  };
}
