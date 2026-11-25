import http from 'node:http';
import crypto from 'node:crypto';
import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from '../fixtures';

/**
 * The Connect flow end to end, with a loopback HTTP server standing in for
 * the OAuth client (what Claude Code does; claude.ai differs only in the
 * https callback): DCR → /oauth/authorize in the browser → inline sign-up →
 * consent → the code lands on the loopback server → PKCE exchange → /mcp.
 */

const uniq = () => `oauth${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;

/** Captures the query string of every redirect the browser is sent to. */
class LoopbackClient {
  private server = http.createServer((req, res) => {
    const q = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
    res.setHeader('content-type', 'text/plain');
    res.end('Loopback client received the redirect');
    this.waiters.shift()?.(q);
  });
  private waiters: Array<(q: URLSearchParams) => void> = [];
  port = 0;

  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as { port: number }).port;
  }
  get redirectUri() { return `http://127.0.0.1:${this.port}/callback`; }
  /** Resolves with the next redirect's query parameters. Call BEFORE clicking. */
  next(): Promise<URLSearchParams> { return new Promise((r) => this.waiters.push(r)); }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); }
}

const pkce = () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

async function signUpInline(page: import('@playwright/test').Page, email: string) {
  await expect(page.getByTestId('auth-email')).toBeVisible();
  await page.getByTestId('auth-switch').click();
  await page.getByTestId('auth-name').fill('OAuth Tester');
  await page.getByTestId('auth-email').fill(email);
  await page.getByTestId('auth-password').fill('password123');
  await page.getByTestId('auth-submit').click();
}

async function mcpClient(base: string, token: string): Promise<Client> {
  const client = new Client({ name: 'aldine-e2e-oauth', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${base}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  ));
  return client;
}

test.describe('OAuth Connect flow', () => {
  const loopback = new LoopbackClient();
  let anon: APIRequestContext;
  let clientId: string;

  test.beforeAll(async ({ baseURL }) => {
    await loopback.start();
    anon = await pwRequest.newContext({ baseURL });
    // Register the loopback client like Claude Code would (DCR, public client).
    const reg = await anon.post('/oauth/register', { data: { client_name: 'Loopback e2e client', redirect_uris: [loopback.redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] } });
    expect(reg.status()).toBe(201);
    const body = await reg.json();
    expect(body.client_id).toMatch(/^aldc_/);
    expect(body.client_secret).toBeUndefined();
    clientId = body.client_id;
  });

  test.afterAll(async () => {
    await anon.dispose();
    await loopback.stop();
  });

  const authorizeUrl = (challenge: string, state: string, base: string, over: Record<string, string> = {}) =>
    '/oauth/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: loopback.redirectUri, state,
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'projects', resource: `${base}/mcp`, ...over,
    });

  test('discovery is served and /mcp challenges with the discovery URL', async ({ baseURL }) => {
    const as = await (await anon.get('/.well-known/oauth-authorization-server')).json();
    expect(as.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(as.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.client_id_metadata_document_supported).toBe(true);
    const prm = await (await anon.get('/.well-known/oauth-protected-resource/mcp')).json();
    expect(prm.resource).toMatch(/\/mcp$/);
    expect(prm.authorization_servers).toEqual([as.issuer]);
    // The SPA fallback must not answer protocol paths with HTML.
    const missing = await anon.get('/.well-known/nothing-here');
    expect(missing.status()).toBe(404);
    expect(missing.headers()['content-type']).toContain('application/json');

    const challenge = await anon.post('/mcp', { data: { jsonrpc: '2.0', method: 'ping', id: 1 } });
    expect(challenge.status()).toBe(401);
    expect(challenge.headers()['www-authenticate']).toContain('resource_metadata=');
    void baseURL;
  });

  test('an unregistered redirect_uri shows the error card and never redirects', async ({ page, baseURL }) => {
    const { challenge } = pkce();
    await page.goto(authorizeUrl(challenge, 'nope', baseURL!, { redirect_uri: 'https://evil.example/cb' }));
    await expect(page.getByTestId('oauth-error')).toBeVisible();
    await expect(page.getByTestId('oauth-consent')).toHaveCount(0);
    await expect(page.getByTestId('auth-email')).toHaveCount(0);
    expect(page.url()).toContain('/oauth/authorize');
  });

  test('a request without its PKCE challenge ends on the error card before consent, with no redirect', async ({ page, baseURL }) => {
    await page.goto(authorizeUrl('', 'nopkce', baseURL!));
    await expect(page.getByTestId('oauth-error')).toContainText('This link is incomplete');
    await expect(page.getByTestId('oauth-error-detail')).toContainText('code_challenge');
    await expect(page.getByTestId('oauth-consent')).toHaveCount(0);
    await expect(page.getByTestId('auth-email')).toHaveCount(0);
    expect(page.url()).toContain('/oauth/authorize');
  });

  test('a session that ends mid-consent brings the sign-in back with a warning, not a success', async ({ page, baseURL }) => {
    const { challenge } = pkce();
    await page.goto(authorizeUrl(challenge, 'ended-state', baseURL!));
    await signUpInline(page, uniq());
    await expect(page.getByTestId('oauth-consent')).toBeVisible();
    await page.request.post('/api/auth/logout');
    await page.getByTestId('oauth-allow').click();
    await expect(page.getByTestId('auth-info')).toContainText('Your session ended');
    await expect(page.getByTestId('auth-info')).toHaveClass(/login__info--warn/);
    await expect(page.getByTestId('oauth-consent')).toHaveCount(0);
  });

  test('sign in on the consent page → Deny → error=access_denied at the redirect', async ({ page, baseURL }) => {
    const { challenge } = pkce();
    await page.goto(authorizeUrl(challenge, 'deny-state', baseURL!));
    await signUpInline(page, uniq());
    // still on the consent page after signing in — no detour through Home
    await expect(page.getByTestId('oauth-consent')).toBeVisible();
    expect(page.url()).toContain('/oauth/authorize');
    await expect(page.getByTestId('oauth-client-name')).toContainText('Loopback e2e client');

    const landed = loopback.next();
    await page.getByTestId('oauth-deny').click();
    const q = await landed;
    expect(q.get('error')).toBe('access_denied');
    expect(q.get('state')).toBe('deny-state');
    expect(q.get('code')).toBeNull();
    await page.waitForURL(/127\.0\.0\.1/);
  });

  test('a failed project-list load says so instead of "no projects yet", and keeps Allow disabled', async ({ page, baseURL }) => {
    const { challenge } = pkce();
    await page.goto(authorizeUrl(challenge, 'err-state', baseURL!));
    await signUpInline(page, uniq());
    await expect(page.getByTestId('oauth-consent')).toBeVisible();
    await page.route((url) => url.pathname === '/api/projects', (route) => route.request().method() === 'GET' ? route.abort() : route.continue());
    await page.reload();
    await expect(page.getByTestId('oauth-consent')).toBeVisible();
    await page.getByTestId('oauth-scope-pick').check();
    await expect(page.getByTestId('oauth-projects-error')).toBeVisible();
    await expect(page.getByTestId('oauth-project-list')).not.toContainText('no projects yet');
    await expect(page.getByTestId('oauth-allow')).toBeDisabled();
    await page.getByTestId('oauth-scope-all').check();
    await expect(page.getByTestId('oauth-allow')).toBeEnabled();
  });

  test('Allow with one project → code exchange → /mcp sees only that project → card revoke ends it', async ({ page, baseURL }) => {
    const base = baseURL!;
    const { verifier, challenge } = pkce();
    await page.goto(authorizeUrl(challenge, 'allow-state', base));
    await signUpInline(page, uniq());
    await expect(page.getByTestId('oauth-consent')).toBeVisible();

    // two projects through the session; the consent picks one of them
    const picked = await (await page.request.post('/api/projects', { data: { name: 'OAuth Picked' } })).json();
    const other = await (await page.request.post('/api/projects', { data: { name: 'OAuth Other' } })).json();
    await page.reload();
    await expect(page.getByTestId('oauth-consent')).toBeVisible();
    await page.getByTestId('oauth-scope-pick').check();
    await expect(page.getByTestId(`oauth-project-${other.id}`)).toBeVisible();
    // nothing picked yet: the hint says so and Allow stays disabled
    await expect(page.getByTestId('oauth-pick-hint')).toContainText('Pick at least one project to continue');
    await expect(page.getByTestId('oauth-allow')).toBeDisabled();
    await page.getByTestId(`oauth-project-${picked.id}`).check();
    await expect(page.getByTestId('oauth-pick-hint')).toHaveCount(0);

    const landed = loopback.next();
    await page.getByTestId('oauth-allow').click();
    const q = await landed;
    const code = q.get('code');
    expect(code).toBeTruthy();
    expect(q.get('state')).toBe('allow-state');
    expect(q.get('error')).toBeNull();
    await page.waitForURL(/127\.0\.0\.1/);

    // PKCE exchange from a cookie-less context: the code, not the session, is the credential
    const exchange = await anon.post('/oauth/token', { form: { grant_type: 'authorization_code', code: code!, client_id: clientId, redirect_uri: loopback.redirectUri, code_verifier: verifier, resource: `${base}/mcp` } });
    expect(exchange.status()).toBe(200);
    expect(exchange.headers()['cache-control']).toBe('no-store');
    const tokens = await exchange.json();
    expect(tokens.access_token).toMatch(/^aldn_/);
    expect(tokens.refresh_token).toMatch(/^aldr_/);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scope).toBe('projects');

    // a second exchange of the same code is refused
    const replay = await anon.post('/oauth/token', { form: { grant_type: 'authorization_code', code: code!, client_id: clientId, redirect_uri: loopback.redirectUri, code_verifier: verifier } });
    expect(replay.status()).toBe(400);
    expect((await replay.json()).error).toBe('invalid_grant');

    // … and, per RFC 6749 §4.1.2, revokes what the first exchange produced: get a fresh grant
    const again = pkce();
    await page.goto(authorizeUrl(again.challenge, 'allow-again', base));
    await expect(page.getByTestId('oauth-consent')).toBeVisible();
    await page.getByTestId('oauth-scope-pick').check();
    await page.getByTestId(`oauth-project-${picked.id}`).check();
    const landed2 = loopback.next();
    await page.getByTestId('oauth-allow').click();
    const code2 = (await landed2).get('code')!;
    await page.waitForURL(/127\.0\.0\.1/);
    const live = await (await anon.post('/oauth/token', { form: { grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: loopback.redirectUri, code_verifier: again.verifier } })).json();
    expect(live.access_token).toMatch(/^aldn_/);

    const client = await mcpClient(base, live.access_token);
    try {
      const ping = await client.callTool({ name: 'ping', arguments: {} });
      expect(JSON.parse((ping.content as Array<{ text: string }>)[0].text).ok).toBe(true);
      const list = await client.callTool({ name: 'list_projects', arguments: {} });
      const ids = (JSON.parse((list.content as Array<{ text: string }>)[0].text) as Array<{ id: string }>).map((p) => p.id);
      expect(ids).toEqual([picked.id]);
    } finally {
      await client.close().catch(() => {});
    }

    // refresh rotates: the old access token dies, the new one works
    const refreshed = await anon.post('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: live.refresh_token, client_id: clientId } });
    expect(refreshed.status()).toBe(200);
    const rotated = await refreshed.json();
    expect(rotated.access_token).not.toBe(live.access_token);
    expect((await anon.post('/mcp', { data: { jsonrpc: '2.0', method: 'ping', id: 1 }, headers: { authorization: `Bearer ${live.access_token}` } })).status()).toBe(401);

    // the Agent access card lists the connector token with the "via Connect" badge; revoking there kills the refresh token too
    await page.goto('/');
    await page.getByTestId('account-menu').click();
    await page.getByTestId('user-name').click();
    await expect(page.getByTestId('account-settings')).toBeVisible();
    await expect(page.getByTestId('agent-token-via-connect')).toBeVisible();
    await expect(page.getByTestId('account-settings')).toContainText('Loopback e2e client');
    // a Connect row lists under its own heading, names its project and never shows the daily access-token expiry
    await expect(page.getByTestId('agent-connections')).toBeVisible();
    await expect(page.getByTestId('agent-token-scope').first()).toHaveText('OAuth Picked');
    await expect(page.getByTestId('agent-token-via-connect')).toHaveAttribute('title', /the assistant asks you to connect again/);
    await expect(page.getByTestId('account-settings')).not.toContainText('Expires');
    await page.getByTestId('agent-token-revoke').first().click();
    await page.getByTestId('agent-token-revoke-confirm').click();
    await expect(page.getByTestId('agent-token-via-connect')).toHaveCount(0);
    expect((await anon.post('/mcp', { data: { jsonrpc: '2.0', method: 'ping', id: 1 }, headers: { authorization: `Bearer ${rotated.access_token}` } })).status()).toBe(401);
    const dead = await anon.post('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: rotated.refresh_token, client_id: clientId } });
    expect(dead.status()).toBe(400);
    expect((await dead.json()).error).toBe('invalid_grant');
  });

  test('a connected client is named: presence and History read "<client> (for <person>)", the commit carries the trailer', async ({ page, baseURL }) => {
    const base = baseURL!;
    const { verifier, challenge } = pkce();
    await page.goto(authorizeUrl(challenge, 'named-state', base));
    await signUpInline(page, uniq());
    await expect(page.getByTestId('oauth-consent')).toBeVisible();
    const project = await (await page.request.post('/api/projects', { data: { name: 'Named client' } })).json();
    await page.request.put(`/api/projects/${project.id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'Original line.\n' } });
    await page.reload();
    await expect(page.getByTestId('oauth-consent')).toBeVisible();
    const landed = loopback.next();
    await page.getByTestId('oauth-allow').click();
    const code = (await landed).get('code')!;
    await page.waitForURL(/127\.0\.0\.1/);
    const tokens = await (await anon.post('/oauth/token', { form: { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: loopback.redirectUri, code_verifier: verifier } })).json();
    expect(tokens.access_token).toMatch(/^aldn_/);

    await page.goto(`/p/${project.id}`);
    await expect(page.getByTestId('code-pane')).toHaveAttribute('data-loaded', 'true');
    const client = await mcpClient(base, tokens.access_token);
    try {
      const edit = await client.callTool({ name: 'edit_file', arguments: {
        project: project.id, path: 'main.tex',
        edits: [{ quote: 'Original line.', replacement: 'Original line, reworded.' }],
        // a message cannot claim another client
        message: 'Reword the opening line\n\nAgent-client: Somebody Else',
      } });
      expect(edit.isError).toBeFalsy();
      await expect(page.getByTestId('presence-agent')).toHaveAttribute('title', /^Loopback e2e client \(for OAuth Tester\), agent session started \d\d:\d\d, in this file$/, { timeout: 10_000 });
      // the author stays Claude, which the review prompts key on; client and person are trailers
      const log = await (await page.request.get(`/api/projects/${project.id}/log?branch=main`)).json();
      expect(log[0]).toMatchObject({ author: 'Assistant', message: 'Reword the opening line', onBehalfOf: 'OAuth Tester', client: 'Loopback e2e client' });
      const activity = await (await page.request.get(`/api/projects/${project.id}/agent-activity?branch=main`)).json();
      expect(activity.commits[0]).toMatchObject({ onBehalfOf: 'OAuth Tester', client: 'Loopback e2e client' });
      // History sits in the sidebar's More menu at this width
      if (!(await page.getByTestId('tab-history').isVisible())) await page.getByTestId('tab-more').click();
      await page.getByTestId('tab-history').click();
      await expect(page.getByTestId(`commit-${log[0].hash.slice(0, 7)}`)).toContainText('Loopback e2e client (for OAuth Tester)');
    } finally {
      await client.close().catch(() => {});
    }
  });

  test('the administrator sees a connected client on /admin and removes it: its connections end, the row goes', async ({ page, browser, baseURL }) => {
    const base = baseURL!;
    // a client of its own: removing it must not take the shared one from the other tests
    const reg = await anon.post('/oauth/register', { data: { client_name: 'Removable e2e client', redirect_uris: [loopback.redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] } });
    expect(reg.status()).toBe(201);
    const removable = (await reg.json()).client_id as string;

    // a person connects through it
    const { verifier, challenge } = pkce();
    await page.goto(authorizeUrl(challenge, 'removable-state', base, { client_id: removable }));
    await signUpInline(page, uniq());
    await expect(page.getByTestId('oauth-consent')).toBeVisible();
    const landed = loopback.next();
    await page.getByTestId('oauth-allow').click();
    const code = (await landed).get('code')!;
    await page.waitForURL(/127\.0\.0\.1/);
    const tokens = await (await anon.post('/oauth/token', { form: { grant_type: 'authorization_code', code, client_id: removable, redirect_uri: loopback.redirectUri, code_verifier: verifier } })).json();
    const ping = () => anon.post('/mcp', { data: { jsonrpc: '2.0', method: 'ping', id: 1 }, headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' } });
    expect((await ping()).status()).toBe(200);

    // the administrator (ALDINE_ADMIN_EMAILS=admin@test.com; a re-run finds the account registered)
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    try {
      const made = await admin.request.post('/api/auth/register', { data: { email: 'admin@test.com', password: 'password123', name: 'Admin' } });
      if (made.ok()) {
        const { link } = await (await admin.request.get('/api/test/confirmation-link?email=admin%40test.com')).json();
        const token = new URL(link, 'http://x').searchParams.get('confirm_email');
        expect((await admin.request.post('/api/auth/confirm-email', { data: { token } })).ok()).toBeTruthy();
      } else {
        expect((await admin.request.post('/api/auth/login', { data: { email: 'admin@test.com', password: 'password123' } })).ok()).toBeTruthy();
      }
      await admin.goto('/admin');
      const section = admin.getByTestId('admin-clients');
      await expect(section).toBeVisible();
      await expect(section.getByTestId('admin-clients-registration')).toContainText('Registration is open');
      const row = section.getByTestId('admin-client-row').filter({ hasText: 'Removable e2e client' });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('127.0.0.1');
      await expect(row).toContainText('Registered here');
      await expect(row.getByTestId('admin-client-connections')).toHaveText('1');

      // Cancel changes nothing
      await row.getByTestId('admin-client-remove').click();
      await expect(admin.getByTestId('dialog-title')).toHaveText('Remove Removable e2e client?');
      await expect(admin.getByTestId('dialog-message')).toContainText('This ends 1 connection at once');
      await admin.getByTestId('dialog-cancel').click();
      await expect(row).toHaveCount(1);
      expect((await ping()).status()).toBe(200);

      await row.getByTestId('admin-client-remove').click();
      await admin.getByTestId('dialog-confirm').click();
      await expect(section.getByTestId('admin-clients-message')).toHaveText('Removed Removable e2e client. 1 connection ended.');
      await expect(row).toHaveCount(0);
    } finally {
      await adminContext.close();
    }

    // the assistant is out at its next request, and cannot renew or come back under the old id
    expect((await ping()).status()).toBe(401);
    const renew = await anon.post('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: removable } });
    expect(renew.status()).toBe(400);
    const again = pkce();
    await page.goto(authorizeUrl(again.challenge, 'gone-state', base, { client_id: removable }));
    await expect(page.getByTestId('oauth-error')).toBeVisible();
  });
});
