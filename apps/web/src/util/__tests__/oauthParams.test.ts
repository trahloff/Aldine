import { describe, it, expect } from 'vitest';
import { readAuthorizeParams, consentBody } from '../oauthParams';

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
