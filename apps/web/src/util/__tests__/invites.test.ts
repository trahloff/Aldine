import { describe, expect, it } from 'vitest';
import { addedEntries, forgetInviteResume, INVITE_RESUME_KEY, INVITE_RESUME_MAX_AGE_MS, invitationStatus, inviteSummary, rememberInviteResume, takeInviteResume } from '../invites';
import { makeSafeStore } from '../safeStorage';

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
  it('splits a partial send over the hourly email limit', () => {
    const s = inviteSummary(['a@x.io', 'b@x.io', 'c@x.io'], { invited: 1, notEmailed: ['b@x.io', 'c@x.io'], reason: 'limit' });
    expect(s.sent).toBe('Invitation emailed to a@x.io.');
    expect(s.manual).toBe('Not emailed because the hourly invitation email limit is reached, so copy the invite link for b@x.io, c@x.io and send it yourself. The invitation also waits on their Home once they sign in with those addresses.');
  });
  it('splits a send where one mail failed', () => {
    const s = inviteSummary(['a@x.io', 'b@x.io'], { invited: 1, notEmailed: ['b@x.io'], reason: 'failed' });
    expect(s.sent).toBe('Invitation emailed to a@x.io.');
    expect(s.manual).toContain('The email could not be sent');
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

describe('invite resume', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return makeSafeStore(() => ({
      get length() { return m.size; },
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); },
    }));
  };
  const ID = '0123456789abcdef0123456789abcdef';
  const T0 = 1_800_000_000_000;

  it('brings a sign-in started on an invitation page back there, once', () => {
    const store = memory();
    rememberInviteResume(ID, store, T0);
    expect(takeInviteResume(store, T0 + 60_000)).toBe(`/invite/${ID}`);
    expect(takeInviteResume(store, T0 + 61_000)).toBeNull();
    expect(store.get(INVITE_RESUME_KEY)).toBeNull();
  });
  it('ignores a sign-in started longer ago than the limit, and drops it', () => {
    const store = memory();
    rememberInviteResume(ID, store, T0);
    expect(takeInviteResume(store, T0 + INVITE_RESUME_MAX_AGE_MS + 1)).toBeNull();
    expect(store.get(INVITE_RESUME_KEY)).toBeNull();
    rememberInviteResume(ID, store, T0);
    expect(takeInviteResume(store, T0 - 60_000)).toBeNull(); // written "later" than now: the clock moved
  });
  it('forgets it when a sign-in starts anywhere else', () => {
    const store = memory();
    rememberInviteResume(ID, store, T0);
    forgetInviteResume(store);
    expect(takeInviteResume(store, T0)).toBeNull();
  });
  it('honours nothing but an invitation page of this app', () => {
    const store = memory();
    for (const path of ['//evil.example/invite/x', 'https://evil.example/invite/x', '/invite/../admin', '/invite/a/b', '/invite/', '/admin', '/invite/x?next=/admin', '/invite/x#y']) {
      store.setJSON(INVITE_RESUME_KEY, { path, at: T0 });
      expect(takeInviteResume(store, T0), path).toBeNull();
    }
    rememberInviteResume('../admin', store, T0);
    expect(store.get(INVITE_RESUME_KEY)).toBeNull();
  });
  it('ignores an entry that is not a path with the time it was written', () => {
    const store = memory();
    store.set(INVITE_RESUME_KEY, `/invite/${ID}`);
    expect(takeInviteResume(store, T0)).toBeNull();
    store.setJSON(INVITE_RESUME_KEY, { path: `/invite/${ID}` });
    expect(takeInviteResume(store, T0)).toBeNull();
  });
});
