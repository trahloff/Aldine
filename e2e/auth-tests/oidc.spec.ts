import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';

/**
 * Generic OIDC sign-in against mock-oidc.mjs (issuer with a path, like
 * Authentik). The auth server runs with OIDC_ALLOWED_GROUPS=aldine-users.
 * Every test registers its own persona with a fresh `sub` and address, so a
 * re-run against the kept .data-auth starts from the same situation.
 */
const OIDC = `http://localhost:${Number(process.env.E2E_AUTH_OIDC_PORT || 4930)}`;
const uid = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

interface Persona { code: string; sub: string; claims: Record<string, unknown> }

async function persona(claims: Record<string, unknown> = {}): Promise<Persona> {
  const id = uid();
  const p = { code: `p${id}`, sub: `e2e-${id}`, claims: { name: `Oidc Person ${id}`, email: `oidc${id}@example.org`, email_verified: true, groups: ['aldine-users'], ...claims } };
  const res = await fetch(`${OIDC}/__personas`, { method: 'POST', body: JSON.stringify(p) });
  expect(res.ok).toBeTruthy();
  return p;
}

async function toIdp(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('oauth-oidc')).toHaveText('Continue with single sign-on');
  await page.getByTestId('oauth-oidc').click();
  await expect(page).toHaveURL(/\/application\/o\/authorize\//);
}

async function signIn(page: Page, p: Persona) {
  await toIdp(page);
  await page.getByTestId(`oidc-persona-${p.code}`).click();
}

test.describe('OIDC sign-in', () => {
  test('first sign-in creates the account, the second lands in the same one', async ({ page }) => {
    const p = await persona();
    await signIn(page, p);
    await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('user-name').click();
    const settings = page.getByTestId('account-settings');
    await expect(settings.getByTestId('account-email')).toHaveText(p.claims.email as string);
    await expect(settings.getByTestId('account-sign-in')).toHaveText('Single sign-on');
    await expect(settings).toContainText('Your password is managed by your identity provider.');
    await page.keyboard.press('Escape');

    // The API refuses a password too: it would outlive the IdP account and OIDC_ALLOWED_GROUPS.
    const pw = await page.request.post('/api/auth/password', { data: { currentPassword: '', newPassword: 'contractor-pw-1' } });
    expect(pw.status()).toBe(400);
    expect((await pw.json()).error).toContain('This account signs in with single sign-on');
    expect((await page.request.post('/api/auth/login', { data: { email: p.claims.email, password: 'contractor-pw-1' } })).status()).toBe(401);

    const name = `OIDC paper ${uid()}`;
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill(name);
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();

    await page.goto('/');
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('auth-email')).toBeVisible();
    await signIn(page, p);
    await expect(page.getByTestId('project-grid')).toContainText(name, { timeout: 15_000 });
  });

  test('an unverified email does not link to an existing account with that address', async ({ page, browser }) => {
    const address = `victim${uid()}@example.org`;
    const victim = await browser.newContext();
    expect((await victim.request.post('/api/auth/register', { data: { email: address, password: 'password123', name: 'Victim' } })).ok()).toBeTruthy();
    const secret = `Victim paper ${uid()}`;
    expect((await victim.request.post('/api/projects', { data: { name: secret } })).ok()).toBeTruthy();
    await victim.close();

    await signIn(page, await persona({ email: address, email_verified: false }));
    await expect(page.getByTestId('projects-empty')).toBeVisible({ timeout: 15_000 });
    const mine = (await (await page.request.get('/api/projects')).json()) as { name: string }[];
    expect(mine.map((p) => p.name)).not.toContain(secret);
    await page.getByTestId('user-name').click();
    await expect(page.getByTestId('account-email')).toHaveText('No email address on this account');
    await page.keyboard.press('Escape');

    // The same address, verified this time, still never enters a password account.
    await page.goto('/');
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('auth-email')).toBeVisible();
    await signIn(page, await persona({ email: address }));
    await expect(page.locator('body')).toContainText('sign in with your password');
    await page.goto('/');
    await expect(page.getByTestId('auth-email')).toBeVisible();
  });

  test('someone outside OIDC_ALLOWED_GROUPS is turned away', async ({ page }) => {
    await signIn(page, await persona({ groups: ['other-team'] }));
    await expect(page.getByTestId('sign-in-error')).toContainText('not in a group that may use this Aldine instance');
    await page.getByTestId('sign-in-error-back').click();
    await expect(page.getByTestId('auth-email')).toBeVisible();
    await expect(page.getByTestId('new-project')).toHaveCount(0);
  });

  test('a tampered state is rejected and signs nobody in', async ({ page }) => {
    const p = await persona();
    await toIdp(page);
    const href = await page.getByTestId(`oidc-persona-${p.code}`).getAttribute('href');
    const url = new URL(href!, OIDC);
    const state = url.searchParams.get('state')!;
    expect(state).toBeTruthy();
    url.searchParams.set('state', state.split('').reverse().join('') + '0');
    await page.goto(url.href);
    await expect(page.locator('body')).toContainText('OAuth state mismatch');
    await page.goto('/');
    await expect(page.getByTestId('auth-email')).toBeVisible();
  });

  test('signing in with OIDC in the middle of Connect returns to the consent page', async ({ page, request, baseURL }) => {
    const reg = await request.post('/oauth/register', { data: { client_name: 'OIDC Connect e2e', redirect_uris: ['http://127.0.0.1:9/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] } });
    expect(reg.status()).toBe(201);
    const { client_id } = await reg.json();
    const q = new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: 'http://127.0.0.1:9/callback', state: 'oidc-connect',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', scope: 'projects', resource: `${baseURL}/mcp`,
    });
    const p = await persona();
    await page.goto(`/oauth/authorize?${q}`);
    await expect(page.getByTestId('oauth-oidc')).toBeVisible();
    await page.getByTestId('oauth-oidc').click();
    await page.getByTestId(`oidc-persona-${p.code}`).click();
    await expect(page.getByTestId('oauth-consent')).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain('/oauth/authorize');
    await expect(page.getByTestId('oauth-client-name')).toContainText('OIDC Connect e2e');
  });
});
