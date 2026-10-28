import type { Mail } from './email.js';

/** Why some addresses were not mailed. One per response: the first cause hit. */
export type NotEmailedReason = 'accounts-off' | 'no-mail' | 'unconfirmed' | 'limit' | 'failed';

export interface InviteReport {
  invited: number;
  notEmailed: string[];
  reason?: NotEmailedReason;
}

const isEmail = (c: string) => c.includes('@');

/** Addresses in `next` that `prev` did not hold. ORCID iDs never get mail, and
 *  the owner's own address is not an invitation. Both lists are normalized
 *  (lowercased) by the share route. */
export function newInvitees(prev: string[], next: string[], ownerEmail?: string | null): string[] {
  const before = new Set(prev);
  const own = ownerEmail?.toLowerCase();
  return [...new Set(next)].filter((c) => isEmail(c) && !before.has(c) && c !== own);
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
 *  the project on this instance's configured public URL. */
export function invitationMail(to: string, ownerName: string, projectName: string, projectUrl: string): Mail {
  const owner = clip(ownerName, OWNER_NAME_MAX) || 'Someone';
  const project = clip(projectName, PROJECT_NAME_MAX) || 'Untitled project';
  const how = `To open it, sign in or create an account with this address (${to}). A new account confirms the address by email first; the project appears once it is confirmed.`;
  const ignore = 'If you do not know them, ignore this email: nothing happens unless you sign in.';
  return {
    to,
    subject: `${owner} shared “${project}” with you on Aldine`,
    text: `Hi there,\n\n${owner} shared the LaTeX project “${project}” with you on Aldine, a collaborative LaTeX editor.\n\n${how}\n\nOpen the project:\n${projectUrl}\n\n${ignore}`,
    html: `<p>Hi there,</p><p>${escapeHtml(owner)} shared the LaTeX project “${escapeHtml(project)}” with you on Aldine, a collaborative LaTeX editor.</p><p>${escapeHtml(how)}</p><p><a href="${escapeHtml(projectUrl)}" style="display:inline-block;padding:10px 18px;background:#1f4fd1;color:#ffffff;border-radius:6px;text-decoration:none">Open the project</a></p><p>${escapeHtml(ignore)}</p>`,
  };
}
