/**
 * A small OpenID Connect provider for the auth e2e suite and the server unit
 * tests, shaped like Authentik: the issuer has a path and a trailing slash
 * (http://localhost:<port>/application/o/aldine/), the endpoints sit beside
 * it. Keys are an RSA pair generated at start; the JWKS publishes the public
 * half. Personas are registered per test (POST /__personas, or
 * mock.addPersona in-process) so re-runs against a kept data dir stay
 * independent; a persona's `tamper` makes the IdP misbehave in one specific
 * way for the validation tests.
 *
 * Run standalone: E2E_AUTH_OIDC_PORT=4930 node e2e/auth-tests/mock-oidc.mjs
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64url');

/**
 * @param {object} [opts]
 * @param {number} [opts.port] 0 = any free port
 * @param {string} [opts.issuerPath] path of the issuer, trailing slash kept
 * @param {string} [opts.clientId]
 * @param {string|null} [opts.clientSecret] null = public client
 * @param {string[]} [opts.authMethods] token_endpoint_auth_methods_supported
 * @param {string[]} [opts.algs] id_token_signing_alg_values_supported (undefined = omitted)
 */
export function createMockOidc(opts = {}) {
  const issuerPath = opts.issuerPath ?? '/application/o/aldine/';
  const clientId = opts.clientId ?? 'aldine-e2e';
  const state = {
    clientSecret: opts.clientSecret === undefined ? 'aldine-e2e-secret' : opts.clientSecret,
    authMethods: opts.authMethods ?? ['client_secret_basic', 'client_secret_post'],
    algs: 'algs' in opts ? opts.algs : ['RS256'],
    /** Serve the discovery document with a 503 (IdP down). */
    down: false,
    /** Replace the issuer the discovery document reports. */
    discoveryIssuer: null,
    /** Client authentication seen on the last token request. */
    lastTokenAuth: null,
    /** Advertise RFC 9207 authorization_response_iss_parameter_supported. */
    issParam: true,
    /** Serve the JWKS with a 503 (keys unreachable after discovery worked). */
    jwksDown: false,
    /** Discovery requests served so far. */
    discoveryHits: 0,
    /** Pad the discovery document with this many bytes (oversized responses). */
    discoveryPadding: 0,
  };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = crypto.randomBytes(6).toString('hex');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };

  /** @type {Map<string, {code: string, sub: string, claims: object, groupsInUserinfo?: boolean, tamper?: string}>} */
  const personas = new Map();
  const codes = new Map();
  const tokens = new Map();
  let origin = '';
  const issuer = () => `${origin}${issuerPath}`;

  function addPersona(p) {
    personas.set(p.code, { claims: {}, ...p });
    return p;
  }

  function sign(header, payload, key = privateKey) {
    const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    if (header.alg === 'none') return `${data}.`;
    if (header.alg === 'HS256') return `${data}.${crypto.createHmac('sha256', publicKey.export({ format: 'pem', type: 'spki' })).update(data).digest('base64url')}`;
    return `${data}.${crypto.sign('sha256', Buffer.from(data), key).toString('base64url')}`;
  }

  function idToken(persona, grant) {
    const now = Math.floor(Date.now() / 1000);
    const t = persona.tamper;
    const claims = { ...persona.claims };
    if (persona.groupsInUserinfo) delete claims.groups;
    const payload = {
      iss: t === 'wrong-iss' ? `${origin}/application/o/other/` : issuer(),
      sub: persona.sub,
      aud: t === 'wrong-aud' ? 'someone-else' : t === 'multi-aud' || t === 'wrong-azp' ? [clientId, 'someone-else'] : clientId,
      exp: t === 'expired' ? now - 600 : now + 300,
      iat: t === 'expired' ? now - 900 : t === 'future-iat' ? now + 3600 : t === 'no-iat' ? undefined : now,
      nonce: t === 'wrong-nonce' ? 'not-the-nonce' : t === 'no-nonce' ? undefined : grant.nonce,
      ...(t === 'wrong-azp' ? { azp: 'someone-else' } : {}),
      ...claims,
    };
    const header = { alg: t === 'alg-none' ? 'none' : t === 'hs256' ? 'HS256' : 'RS256', typ: 'JWT', kid };
    return sign(header, payload, t === 'bad-sig' ? rogue.privateKey : privateKey);
  }

  const readBody = (req) => new Promise((resolve) => { let raw = ''; req.on('data', (d) => { raw += d; }); req.on('end', () => resolve(raw)); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    const text = (code, body) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(body); };

    if (url.pathname === `${issuerPath}.well-known/openid-configuration` || url.pathname === `${issuerPath.replace(/\/$/, '')}/.well-known/openid-configuration`) {
      state.discoveryHits++;
      if (state.down) return json(503, { error: 'temporarily_unavailable' });
      const doc = {
        issuer: state.discoveryIssuer ?? issuer(),
        authorization_endpoint: `${origin}/application/o/authorize/`,
        token_endpoint: `${origin}/application/o/token/`,
        userinfo_endpoint: `${origin}/application/o/userinfo/`,
        jwks_uri: `${origin}${issuerPath}jwks/`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: state.authMethods,
        scopes_supported: ['openid', 'email', 'profile', 'groups'],
        ...(state.discoveryPadding ? { padding: 'x'.repeat(state.discoveryPadding) } : {}),
        authorization_response_iss_parameter_supported: state.issParam,
      };
      if (state.algs) doc.id_token_signing_alg_values_supported = state.algs;
      return json(200, doc);
    }
    if (url.pathname === `${issuerPath}jwks/`) return state.jwksDown ? json(503, { error: 'unavailable' }) : json(200, { keys: [jwk] });

    if (url.pathname === '/application/o/authorize/') {
      const q = url.searchParams;
      const problems = [];
      if (q.get('response_type') !== 'code') problems.push('response_type must be code');
      if (q.get('client_id') !== clientId) problems.push('unknown client_id');
      if (!q.get('redirect_uri')) problems.push('redirect_uri missing');
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) problems.push('PKCE S256 required');
      if (!q.get('nonce')) problems.push('nonce missing');
      if (!(q.get('scope') || '').split(' ').includes('openid')) problems.push('openid scope missing');
      if (problems.length) return text(400, `mock OIDC refused the request: ${problems.join('; ')}`);
      const code = q.get('persona');
      const persona = code && personas.get(code);
      if (persona) {
        const grant = crypto.randomBytes(16).toString('hex');
        codes.set(grant, { persona, nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), used: false });
        const back = new URL(q.get('redirect_uri'));
        back.searchParams.set('code', grant);
        back.searchParams.set('state', q.get('state') || '');
        if (persona.tamper !== 'iss-param-missing') back.searchParams.set('iss', persona.tamper === 'iss-param' ? `${origin}/application/o/other/` : issuer());
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      const links = [...personas.values()].map((p) => {
        const u = new URL(url.href, origin);
        u.searchParams.set('persona', p.code);
        return `<li><a data-testid="oidc-persona-${p.code}" href="${u.pathname}${u.search}">Continue as ${p.claims.name || p.sub}</a></li>`;
      }).join('');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>Mock OIDC</title><h1>Sign in (mock OIDC)</h1><p>scope ${q.get('scope')}</p><ul>${links}</ul>`);
    }

    if (url.pathname === '/application/o/token/' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      let id = form.get('client_id'), secret = form.get('client_secret'), method = secret ? 'client_secret_post' : 'none';
      const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
      if (basic) {
        const [u, p] = Buffer.from(basic[1], 'base64').toString().split(':').map((s) => decodeURIComponent(s.replace(/\+/g, ' ')));
        id = u; secret = p; method = 'client_secret_basic';
      }
      state.lastTokenAuth = method;
      if (id !== clientId) return json(401, { error: 'invalid_client' });
      if (state.clientSecret ? (secret !== state.clientSecret || !state.authMethods.includes(method)) : method !== 'none') return json(401, { error: 'invalid_client', error_description: `client authentication failed (${method})` });
      const grant = codes.get(form.get('code') || '');
      if (!grant || grant.used || form.get('grant_type') !== 'authorization_code') return json(400, { error: 'invalid_grant' });
      grant.used = true;
      if (form.get('redirect_uri') !== grant.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (sha256(form.get('code_verifier') || '') !== grant.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const access = crypto.randomBytes(16).toString('hex');
      tokens.set(access, grant.persona);
      return json(200, { access_token: access, token_type: 'Bearer', expires_in: 300, id_token: idToken(grant.persona, grant) }, { 'cache-control': 'no-store' });
    }

    if (url.pathname === '/application/o/userinfo/') {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const persona = m && tokens.get(m[1]);
      if (!persona) return json(401, { error: 'invalid_token' });
      return json(200, { sub: persona.tamper === 'userinfo-other-sub' ? 'someone-else' : persona.sub, ...persona.claims, ...(persona.userinfo || {}) });
    }

    if (url.pathname === '/__personas' && req.method === 'POST') {
      try { return json(200, addPersona(JSON.parse(await readBody(req)))); } catch { return json(400, { error: 'bad persona' }); }
    }
    json(404, { error: 'not found' });
  });

  return {
    server,
    state,
    clientId,
    addPersona,
    get issuer() { return issuer(); },
    get origin() { return origin; },
    async listen(port = opts.port ?? 0) {
      await new Promise((r) => server.listen(port, r));
      origin = `http://localhost:${server.address().port}`;
      return this;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.E2E_AUTH_OIDC_PORT || 4930);
  const mock = createMockOidc({ port });
  await mock.listen(port);
  console.log(`mock OIDC on :${port}, issuer ${mock.issuer}`);
}
