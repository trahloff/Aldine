/**
 * Stub of orcid.org for the auth e2e suite: the authorize page offers two
 * fictional researchers (ORCID's own example iDs), the token endpoint answers
 * with the iD and name, the public API lists an email only for the one who
 * made it public. POST /__personas adds one ({ code, orcid, name, email }),
 * so a test that binds an iD to an account has an iD no earlier run used.
 */
import http from 'node:http';

export const PERSONAS = {
  private: { code: 'private', orcid: '0000-0002-1825-0097', name: 'Josiah Carberry', email: null },
  public: { code: 'public', orcid: '0000-0001-5109-3700', name: 'Sofia Garcia', email: 'sofia.garcia@example.org' },
};

const personas = () => Object.values(PERSONAS);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  if (url.pathname === '/oauth/authorize') {
    const redirect = url.searchParams.get('redirect_uri') || '';
    const state = url.searchParams.get('state') || '';
    const link = (p) => `${redirect}${redirect.includes('?') ? '&' : '?'}code=${p.code}&state=${encodeURIComponent(state)}`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>ORCID (mock)</title><h1>Sign in to ORCID (mock)</h1>
      <p>Client: ${url.searchParams.get('client_id')} · scope ${url.searchParams.get('scope')}</p>
      ${personas().map((p) => `<a data-testid="persona-${p.code}" href="${link(p)}">Continue as ${p.name} (${p.email ? 'public' : 'no public'} email)</a><br>`).join('\n')}`);
    return;
  }
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      const p = personas().find((x) => x.code === form.get('code'));
      if (!p || form.get('grant_type') !== 'authorization_code' || !form.get('client_secret')) return json(400, { error_description: 'invalid code' });
      json(200, { access_token: `tok-${p.code}`, token_type: 'bearer', scope: '/authenticate', orcid: p.orcid, name: p.name });
    });
    return;
  }
  const m = url.pathname.match(/^\/v3\.0\/([0-9X-]+)\/email$/);
  if (m) {
    const p = personas().find((x) => x.orcid === m[1]);
    return json(200, { email: p?.email ? [{ email: p.email, verified: true, primary: true, visibility: 'public' }] : [] });
  }
  if (url.pathname === '/__personas' && req.method === 'POST') {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      try {
        const p = JSON.parse(raw);
        if (!/^[a-z0-9-]{1,40}$/.test(p.code) || !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(p.orcid) || PERSONAS[p.code]) throw new Error('bad persona');
        PERSONAS[p.code] = { code: p.code, orcid: p.orcid, name: String(p.name || p.orcid), email: p.email || null };
        json(200, PERSONAS[p.code]);
      } catch { json(400, { error: 'bad persona' }); }
    });
    return;
  }
  json(404, { error: 'not found' });
});

const port = Number(process.env.E2E_AUTH_MOCK_PORT || 4929);
server.listen(port, () => console.log(`mock orcid on :${port}`));
