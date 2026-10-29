import { describe, expect, it } from 'vitest';
import { appSignInStarts, consentSignInStarts, inviteSignInStarts } from '../signInStart';
import { INVITE_RESUME_KEY, rememberInviteResume, takeInviteResume } from '../invites';
import { OAUTH_RESUME_KEY, rememberOAuthResume, takeOAuthResume } from '../oauthParams';
import { makeSafeStore } from '../safeStorage';

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
const SEARCH = '?response_type=code&client_id=aldc_x&state=s';
const T0 = 1_800_000_000_000;

describe('a sign-in that starts', () => {
  it('on an invitation page drops what an abandoned consent-page sign-in left', () => {
    const store = memory();
    rememberOAuthResume(SEARCH, store, T0);
    inviteSignInStarts(ID, store, T0 + 60_000);
    expect(store.get(OAUTH_RESUME_KEY)).toBeNull();
    // Home asks for the consent page first: nothing there, so back to the invitation.
    expect(takeOAuthResume(store, T0 + 120_000)).toBeNull();
    expect(takeInviteResume(store, T0 + 120_000)).toBe(`/invite/${ID}`);
  });
  it('on the consent page drops what an abandoned invitation-page sign-in left', () => {
    const store = memory();
    rememberInviteResume(ID, store, T0);
    consentSignInStarts(SEARCH, store, T0 + 60_000);
    expect(store.get(INVITE_RESUME_KEY)).toBeNull();
    expect(takeOAuthResume(store, T0 + 120_000)).toBe(`/oauth/authorize${SEARCH}`);
    expect(takeInviteResume(store, T0 + 120_000)).toBeNull();
  });
  it('on the app’s own sign-in screen drops both', () => {
    const store = memory();
    rememberInviteResume(ID, store, T0);
    rememberOAuthResume(SEARCH, store, T0);
    appSignInStarts(store);
    expect(store.get(INVITE_RESUME_KEY)).toBeNull();
    expect(store.get(OAUTH_RESUME_KEY)).toBeNull();
  });
});
