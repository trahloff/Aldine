import { describe, it, expect } from 'vitest';
import { readAuthorizeParams, consentBody, forgetOAuthResume, OAUTH_RESUME_KEY, OAUTH_RESUME_MAX_AGE_MS, rememberOAuthResume, takeOAuthResume } from '../oauthParams';
import { makeSafeStore } from '../safeStorage';

describe('readAuthorizeParams', () => {
  it('picks the client and redirect and relays everything else', () => {
    const p = readAuthorizeParams('?response_type=code&client_id=aldc_x&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcb&state=s%201&code_challenge=abc&code_challenge_method=S256');
    expect(p.clientId).toBe('aldc_x');
    expect(p.redirectUri).toBe('http://127.0.0.1:5/cb');
    expect(p.all).toEqual({
      response_type: 'code', client_id: 'aldc_x', redirect_uri: 'http://127.0.0.1:5/cb',
      state: 's 1', code_challenge: 'abc', code_challenge_method: 'S256',
    });
  });

  it('defaults missing client and redirect to empty strings', () => {
    const p = readAuthorizeParams('');
    expect(p).toEqual({ clientId: '', redirectUri: '', all: {} });
  });
});

describe('consentBody', () => {
  const params = readAuthorizeParams('?client_id=c&redirect_uri=r&state=z');

  it('relays the params with the decision and the picked projects', () => {
    expect(consentBody(params, 'allow', ['p1', 'p2'])).toEqual({ client_id: 'c', redirect_uri: 'r', state: 'z', decision: 'allow', projectIds: ['p1', 'p2'] });
  });

  it('null projects means every project', () => {
    expect(consentBody(params, 'allow', null).projectIds).toBeNull();
  });

  it('a denial never carries a project scope', () => {
    expect(consentBody(params, 'deny', ['p1']).projectIds).toBeNull();
  });
});

describe('consent resume', () => {
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
  const SEARCH = '?response_type=code&client_id=aldc_x&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcb&state=s&code_challenge=abc&code_challenge_method=S256';
  const T0 = 1_800_000_000_000;

  it('brings a sign-in started on the consent page back there with the same request, once', () => {
    const store = memory();
    rememberOAuthResume(SEARCH, store, T0);
    expect(takeOAuthResume(store, T0 + 60_000)).toBe(`/oauth/authorize${SEARCH}`);
    expect(takeOAuthResume(store, T0 + 61_000)).toBeNull();
    expect(store.get(OAUTH_RESUME_KEY)).toBeNull();
  });
  it('ignores a sign-in started longer ago than the limit, and drops it', () => {
    const store = memory();
    rememberOAuthResume(SEARCH, store, T0);
    expect(takeOAuthResume(store, T0 + OAUTH_RESUME_MAX_AGE_MS + 1)).toBeNull();
    expect(store.get(OAUTH_RESUME_KEY)).toBeNull();
    rememberOAuthResume(SEARCH, store, T0);
    expect(takeOAuthResume(store, T0 + OAUTH_RESUME_MAX_AGE_MS)).toBe(`/oauth/authorize${SEARCH}`);
    rememberOAuthResume(SEARCH, store, T0);
    expect(takeOAuthResume(store, T0 - 60_000)).toBeNull(); // written "later" than now: the clock moved
  });
  it('forgets it when a sign-in starts anywhere else', () => {
    const store = memory();
    rememberOAuthResume(SEARCH, store, T0);
    forgetOAuthResume(store);
    expect(takeOAuthResume(store, T0)).toBeNull();
  });
  it('honours nothing but the consent page of this app', () => {
    const store = memory();
    for (const path of ['//evil.example/oauth/authorize?x=1', 'https://evil.example/oauth/authorize?x=1', '/oauth/authorize/../admin?x=1', '/oauth/authorize', '/admin?x=1', '/oauth/authorize?x=1#y', '/oauth/authorize?x=1 y']) {
      store.setJSON(OAUTH_RESUME_KEY, { path, at: T0 });
      expect(takeOAuthResume(store, T0), path).toBeNull();
    }
    for (const search of ['', '/../admin', '#x', 'x=1']) {
      rememberOAuthResume(search, store, T0);
      expect(store.get(OAUTH_RESUME_KEY), search).toBeNull();
    }
  });
  it('ignores what the page stored before: the bare query string, with no time', () => {
    const store = memory();
    store.set(OAUTH_RESUME_KEY, SEARCH);
    expect(takeOAuthResume(store, T0)).toBeNull();
    expect(store.get(OAUTH_RESUME_KEY)).toBeNull();
    store.setJSON(OAUTH_RESUME_KEY, { path: `/oauth/authorize${SEARCH}` });
    expect(takeOAuthResume(store, T0)).toBeNull();
  });
});
