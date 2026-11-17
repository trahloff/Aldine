import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from '../fixtures';

/**
 * ALDINE_OAUTH_REGISTRATION=closed, against the second server of
 * playwright.auth.config.ts (the ALDINE_SIGNUP=approval one, which also runs
 * with registration closed). Nobody can register a client, discovery says
 * so, a metadata-document client ends on the error card, and a client the
 * administrator added with `npm run oauth:add-client` reaches the sign-in
 * step under its own name.
 */
const ORIGIN = process.env.ALDINE_AUTH_APPROVAL_URL || `http://localhost:${Number(process.env.E2E_AUTH_APPROVAL_PORT || 3210)}`;
const ROOT = path.resolve(__dirname, '../..');
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

test.use({ baseURL: ORIGIN });
test.skip(!!process.env.ALDINE_AUTH_URL && !process.env.ALDINE_AUTH_APPROVAL_URL, 'needs the server with ALDINE_OAUTH_REGISTRATION=closed (ALDINE_AUTH_APPROVAL_URL)');

const authorizeUrl = (clientId: string) => `/oauth/authorize?${new URLSearchParams({
  response_type: 'code', client_id: clientId, redirect_uri: CALLBACK,
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', state: 's', scope: 'projects',
})}`;

test('closed registration: discovery, refusal, and an administrator-added client', async ({ page }) => {
  const meta = await (await page.request.get('/.well-known/oauth-authorization-server')).json();
  expect(meta.registration_endpoint).toBeUndefined();
  expect(meta.client_id_metadata_document_supported).toBe(false);

  const reg = await page.request.post('/oauth/register', { data: { client_name: 'Anyone', redirect_uris: [CALLBACK] } });
  expect(reg.status()).toBe(403);
  const body = await reg.json();
  expect(body.error).toBe('access_denied');
  expect(body.error_description).toContain('Client registration is closed on this server');

  await page.goto(authorizeUrl('https://claude.ai/oauth/mcp-oauth-client-metadata'));
  await expect(page.getByTestId('oauth-error')).toContainText('This server accepts only apps its administrator registered');

  test.skip(!!process.env.ALDINE_AUTH_APPROVAL_URL, 'the CLI needs the server\'s data directories');
  const out = execFileSync('npm', ['run', '--silent', 'oauth:add-client', '-w', 'apps/server', '--', '--name', 'Claude', '--redirect-uri', CALLBACK, '--json'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: path.join(ROOT, '.data-auth-approval'), META_DIR: path.join(ROOT, '.secrets-auth-approval'), CACHE_DIR: path.join(ROOT, '.data-auth-approval/cache') },
    encoding: 'utf8',
  });
  const clientId = JSON.parse(out).client_id as string;
  expect(clientId).toMatch(/^aldc_/);
  await page.goto(authorizeUrl(clientId));
  await expect(page.getByText('Sign in to connect Claude.')).toBeVisible();
});
