import { describe, expect, it } from 'vitest';
import { addedEntries, invitationStatus, inviteSummary } from '../invites';

describe('addedEntries', () => {
  it('keeps new addresses and iDs, normalized the way the server stores them', () => {
    expect(addedEntries(['ada@x.edu', '0000-0002-1825-009X'], ['Ada@x.edu', 'Grace@Y.edu', '0000-0002-1825-0097', 'grace@y.edu', '0000-0002-1825-009x', ' '])).toEqual(['grace@y.edu', '0000-0002-1825-0097']);
  });
});

describe('inviteSummary', () => {
  it('names the addresses mailed', () => {
    expect(inviteSummary(['a@x.io'], { invited: 1, notEmailed: [] })).toEqual({ sent: 'Invitation emailed to a@x.io.', manual: null });
  });
  it('offers the link when the server sends no email', () => {
    const s = inviteSummary(['a@x.io'], { invited: 0, notEmailed: ['a@x.io'], reason: 'no-mail' });
    expect(s.sent).toBeNull();
    expect(s.manual).toBe('This server doesn’t send email, so copy the invite link for a@x.io and send it yourself. The invitation also waits on their Home once they sign in with that address.');
  });
  it('splits a partial send over the limit', () => {
    const s = inviteSummary(['a@x.io', 'b@x.io'], { invited: 1, notEmailed: ['b@x.io'], reason: 'limit' });
    expect(s.sent).toBe('Invitation emailed to a@x.io.');
    expect(s.manual).toContain('hourly invitation limit is reached');
    expect(s.manual).toContain('copy the invite link for b@x.io');
    expect(s.manual).toContain('once they sign in with that address');
  });
  it('says ORCID iDs get no email, whatever the server can send', () => {
    const s = inviteSummary(['a@x.io', '0000-0002-1825-0097'], { invited: 1, notEmailed: [] });
    expect(s.sent).toBe('Invitation emailed to a@x.io.');
    expect(s.manual).toBe('ORCID iDs get no email: copy the invite link for 0000-0002-1825-0097, or tell them it waits on their Home after they sign in with ORCID.');
  });
  it('without accounts there is no link to copy', () => {
    const s = inviteSummary(['a@x.io', 'b@x.io'], { invited: 0, notEmailed: ['a@x.io', 'b@x.io'], reason: 'accounts-off' });
    expect(s.manual).toBe("Not emailed: a@x.io, b@x.io. Tell them yourself: they'll see the project after signing in with these addresses.");
  });
  it('treats an answer without a report as not emailed', () => {
    expect(inviteSummary(['a@x.io'], {}).manual).toContain('copy the invite link for a@x.io');
  });
});

describe('invitationStatus', () => {
  it('names each state for the share dialog', () => {
    expect(invitationStatus({ state: 'pending', emailedAt: '2026-10-29T08:00:00Z', to: 'a@x.io' })).toBe('Pending · emailed');
    expect(invitationStatus({ state: 'pending', emailedAt: null, to: 'a@x.io' })).toBe('Pending · not emailed');
    expect(invitationStatus({ state: 'pending', emailedAt: null, to: '0000-0002-1825-0097' })).toBe('Pending');
    expect(invitationStatus({ state: 'declined', emailedAt: null, to: 'a@x.io' })).toBe('Declined');
    expect(invitationStatus({ state: 'expired', emailedAt: '2026-10-29T08:00:00Z', to: 'a@x.io' })).toBe('Expired');
  });
});
