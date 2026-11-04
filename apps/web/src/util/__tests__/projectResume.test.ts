import { describe, expect, it } from 'vitest';
import { PROJECT_RESUME_KEY, projectOfPath, rememberProjectResume, takeProjectResume } from '../projectResume';
import { appSignInStarts, consentSignInStarts, inviteSignInStarts, projectSignInStarts } from '../signInStart';
import { INVITE_RESUME_KEY, rememberInviteResume, takeInviteResume } from '../invites';
import { OAUTH_RESUME_KEY, rememberOAuthResume } from '../oauthParams';
import { RESUME_MAX_AGE_MS } from '../signInResume';
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
const ID = 'aB3_x-9';
const T0 = 1_800_000_000_000;

describe('the project a path opens', () => {
  it('is the id of a project page', () => {
    expect(projectOfPath(`/p/${ID}`)).toBe(ID);
    expect(projectOfPath(`/p/${'a'.repeat(64)}`)).toBe('a'.repeat(64));
  });
  it('is nothing for any other path', () => {
    for (const path of ['/', '/p/', `/p/${ID}/`, `/p/${ID}/x`, '/p/../admin', '/p/a.b', `//evil.example/p/${ID}`, `https://evil.example/p/${ID}`, `/p/${'a'.repeat(65)}`, `/invite/${ID}`]) {
      expect(projectOfPath(path), path).toBeNull();
    }
  });
});

describe('coming back to a project after signing in', () => {
  it('returns to the project page once, while it is fresh', () => {
    const store = memory();
    rememberProjectResume(ID, store, T0);
    expect(takeProjectResume(store, T0 + 60_000)).toBe(`/p/${ID}`);
    expect(takeProjectResume(store, T0 + 60_000)).toBeNull();
    rememberProjectResume(ID, store, T0);
    expect(takeProjectResume(store, T0 + RESUME_MAX_AGE_MS + 1)).toBeNull();
  });
  it('stores nothing for an id that is not a project page', () => {
    const store = memory();
    rememberProjectResume('../admin', store, T0);
    expect(store.get(PROJECT_RESUME_KEY)).toBeNull();
    store.setJSON(PROJECT_RESUME_KEY, { path: '//evil.example', at: T0 });
    expect(takeProjectResume(store, T0)).toBeNull();
  });
  it('drops what other pages left when it starts on a project page, and is dropped when one starts elsewhere', () => {
    const store = memory();
    rememberInviteResume('0123456789abcdef0123456789abcdef', store, T0);
    rememberOAuthResume('?client_id=x', store, T0);
    projectSignInStarts(ID, store, T0);
    expect(store.get(INVITE_RESUME_KEY)).toBeNull();
    expect(store.get(OAUTH_RESUME_KEY)).toBeNull();
    expect(takeInviteResume(store, T0)).toBeNull();
    for (const start of [() => appSignInStarts(store), () => inviteSignInStarts('0123456789abcdef0123456789abcdef', store, T0), () => consentSignInStarts('?client_id=x', store, T0)]) {
      projectSignInStarts(ID, store, T0);
      start();
      expect(store.get(PROJECT_RESUME_KEY)).toBeNull();
    }
  });
});
