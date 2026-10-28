/** What the share route reports about invitation mails (absent on servers
 *  from before invitations). */
export interface InviteReport {
  invited?: number;
  notEmailed?: string[];
  reason?: 'accounts-off' | 'no-mail' | 'unconfirmed' | 'limit' | 'failed';
}

const list = (xs: string[]) => xs.join(', ');

/** Addresses in `next` that `prev` did not hold, normalized the way the
 *  server stores them. ORCID iDs are never mailed. */
export function addedEmails(prev: string[], next: string[]): string[] {
  const before = new Set(prev.map((c) => c.toLowerCase()));
  return [...new Set(next.map((c) => c.trim().toLowerCase()))].filter((c) => c.includes('@') && !before.has(c));
}

/** The lines the share dialog shows after a save that added addresses. */
export function inviteSummary(added: string[], report: InviteReport): { sent: string | null; manual: string | null } {
  const notEmailed = report.notEmailed ?? (report.invited === undefined ? added : []);
  const skipped = new Set(notEmailed);
  const sentTo = added.filter((a) => !skipped.has(a));
  const invited = report.invited ?? 0;
  const sent = invited === 0 ? null
    : sentTo.length === invited ? `Invitation sent to ${list(sentTo)}.`
    : `Invitation sent to ${invited} ${invited === 1 ? 'person' : 'people'}.`;
  if (notEmailed.length === 0) return { sent, manual: null };
  const why = {
    'accounts-off': 'Not emailed',
    'no-mail': 'Not emailed (this server sends no email)',
    unconfirmed: 'Not emailed until you confirm your own email address',
    limit: 'Not emailed (invitation limit reached, try again in an hour)',
    failed: 'Could not email',
  }[report.reason ?? 'no-mail'] ?? 'Not emailed';
  const addr = notEmailed.length === 1 ? 'this address' : 'these addresses';
  return { sent, manual: `${why}: ${list(notEmailed)}. Tell them yourself: they'll see the project after signing in with ${addr}.` };
}
