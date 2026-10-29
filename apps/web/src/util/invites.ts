import { safeSession, type SafeStore } from './safeStorage';
import { RESUME_MAX_AGE_MS, takeResume, writeResume } from './signInResume';

/** What the share route reports about invitation mails (absent on servers
 *  from before invitations). */
export interface InviteReport {
  invited?: number;
  notEmailed?: string[];
  reason?: 'accounts-off' | 'no-mail' | 'unconfirmed' | 'limit' | 'failed';
  /** The project's open, declined and expired invitations (servers with invitations). */
  invitations?: OwnerInvitation[];
}

/** An invitation as its project's owner sees it in the share dialog. `link`
 *  is the address to copy: it works only for the person invited. */
export interface OwnerInvitation {
  id: string;
  to: string;
  state: 'pending' | 'declined' | 'expired';
  createdAt: string;
  expiresAt: string;
  emailedAt: string | null;
  respondedAt: string | null;
  link: string;
}

/** An invitation waiting on the invitee's Home. */
export interface MyInvitation {
  id: string;
  to: string;
  state: 'pending';
  createdAt: string;
  expiresAt: string;
  project: { id: string; name: string };
  ownerName: string | null;
}

/** What the invitation page learns about its link. The project is named only
 *  to the account invited (`relation` 'match'). */
export interface InvitationView {
  id: string;
  to: string;
  state: 'pending' | 'expired' | 'accepted' | 'declined' | 'withdrawn';
  expiresAt: string;
  ownerName: string | null;
  relation: 'signed-out' | 'match' | 'unconfirmed' | 'other';
  signedInAs: string | null;
  project?: { id: string; name: string };
  member?: boolean;
}

const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dXx]$/;
export const isOrcidEntry = (s: string) => ORCID_RE.test(s);

const list = (xs: string[]) => xs.join(', ');
const norm = (c: string) => (isOrcidEntry(c.trim()) ? c.trim().toUpperCase() : c.trim().toLowerCase());

/** Entries in `next` that `prev` did not hold, normalized the way the server
 *  stores them: these become invitations. */
export function addedEntries(prev: string[], next: string[]): string[] {
  const before = new Set(prev.map(norm));
  return [...new Set(next.map(norm))].filter((c) => c && !before.has(c));
}

const WHY: Record<NonNullable<InviteReport['reason']>, string> = {
  'accounts-off': 'Not emailed',
  'no-mail': 'This server doesn’t send email',
  unconfirmed: 'Not emailed while your own email address is unconfirmed',
  limit: 'Not emailed because the hourly invitation email limit is reached',
  failed: 'The email could not be sent',
};

/** The lines the share dialog shows after a save that invited someone. */
export function inviteSummary(added: string[], report: InviteReport): { sent: string | null; manual: string | null } {
  const emails = added.filter((a) => a.includes('@'));
  const orcids = added.filter((a) => !a.includes('@'));
  const notEmailed = report.notEmailed ?? (report.invited === undefined ? emails : []);
  const skipped = new Set(notEmailed);
  const sentTo = emails.filter((a) => !skipped.has(a));
  const invited = report.invited ?? 0;
  const sent = invited === 0 ? null
    : sentTo.length === invited ? `Invitation emailed to ${list(sentTo)}.`
    : `Invitation emailed to ${invited} ${invited === 1 ? 'person' : 'people'}.`;
  const lines: string[] = [];
  const one = notEmailed.length === 1;
  if (notEmailed.length && report.reason === 'accounts-off') {
    lines.push(`Not emailed: ${list(notEmailed)}. Tell them yourself: they'll see the project after signing in with ${one ? 'this address' : 'these addresses'}.`);
  } else if (notEmailed.length) {
    lines.push(`${WHY[report.reason ?? 'no-mail']}, so copy the invite link for ${list(notEmailed)} and send it yourself. The invitation also waits on their Home once they sign in with ${one ? 'that address' : 'those addresses'}.`);
  }
  if (orcids.length && report.reason !== 'accounts-off') {
    lines.push(`ORCID iDs get no email: copy the invite link for ${list(orcids)}, or tell them it waits on their Home after they sign in with ORCID.`);
  }
  return { sent, manual: lines.length ? lines.join(' ') : null };
}

/** The state line of an invitation in the share dialog. */
export function invitationStatus(inv: Pick<OwnerInvitation, 'state' | 'emailedAt' | 'to'>): string {
  if (inv.state === 'declined') return 'Declined';
  if (inv.state === 'expired') return 'Expired';
  if (inv.emailedAt) return 'Pending · emailed';
  return isOrcidEntry(inv.to) ? 'Pending' : 'Pending · not emailed';
}

/** Where a signed-out invitee returns after signing in through an SSO
 *  provider, whose callback always lands on "/". */
export const INVITE_RESUME_KEY = 'aldine.invite.resume';
export const INVITE_RESUME_MAX_AGE_MS = RESUME_MAX_AGE_MS;
/** An invitation page of this app: one path segment after /invite/, so
 *  nothing stored here can lead off the app or elsewhere in it. */
const INVITE_PATH_RE = /^\/invite\/[A-Za-z0-9_-]+$/;

/** A sign-in starts on the invitation page `id`: bring it back there. */
export function rememberInviteResume(id: string, store: SafeStore = safeSession, now = Date.now()): void {
  writeResume(store, INVITE_RESUME_KEY, `/invite/${id}`, INVITE_PATH_RE, now);
}

/** A sign-in starts anywhere else: whatever an invitation page left behind
 *  belongs to a sign-in that was abandoned. */
export function forgetInviteResume(store: SafeStore = safeSession): void {
  store.remove(INVITE_RESUME_KEY);
}

/** The invitation page to return to after signing in, once, and only
 *  within INVITE_RESUME_MAX_AGE_MS of the sign-in starting there. */
export function takeInviteResume(store: SafeStore = safeSession, now = Date.now()): string | null {
  return takeResume(store, INVITE_RESUME_KEY, INVITE_PATH_RE, now);
}
