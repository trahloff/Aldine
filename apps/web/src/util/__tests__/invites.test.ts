import { describe, expect, it } from 'vitest';
import { addedEmails, inviteSummary } from '../invites';

describe('addedEmails', () => {
  it('keeps only new email addresses, normalized', () => {
    expect(addedEmails(['ada@x.edu'], ['Ada@x.edu', 'Grace@Y.edu', '0000-0002-1825-0097', 'grace@y.edu'])).toEqual(['grace@y.edu']);
  });
});

describe('inviteSummary', () => {
  it('names the addresses mailed', () => {
    expect(inviteSummary(['a@x.io'], { invited: 1, notEmailed: [] })).toEqual({ sent: 'Invitation sent to a@x.io.', manual: null });
  });
  it('tells the owner to pass it on when mail is off', () => {
    const s = inviteSummary(['a@x.io'], { invited: 0, notEmailed: ['a@x.io'], reason: 'no-mail' });
    expect(s.sent).toBeNull();
    expect(s.manual).toBe("Not emailed (this server sends no email): a@x.io. Tell them yourself: they'll see the project after signing in with this address.");
  });
  it('splits a partial send over the limit', () => {
    const s = inviteSummary(['a@x.io', 'b@x.io'], { invited: 1, notEmailed: ['b@x.io'], reason: 'limit' });
    expect(s.sent).toBe('Invitation sent to a@x.io.');
    expect(s.manual).toContain('invitation limit reached');
    expect(s.manual).toContain('b@x.io');
  });
  it('treats a server without invitations as not emailed', () => {
    expect(inviteSummary(['a@x.io'], {}).manual).toContain('Tell them yourself');
  });
});
