import { test, expect } from '../fixtures';

/**
 * OIDC sign-in behind ALDINE_BASE_PATH with ALDINE_PUBLIC_URL, in a real
 * browser: the redirect URI carries the prefix, and the state cookie (Path =
 * prefix, SameSite=Lax) comes back on the IdP's top-level redirect to the
 * callback. Server and mock IdP: the second and third webServer in
 * playwright.base-path.config.ts.
 */
const BASE = '/internal/aldine';
const ORIGIN = `http://localhost:${Number(process.env.E2E_BASE_PATH_AUTH_PORT || 3302)}`;
const OIDC = `http://localhost:${Number(process.env.E2E_BASE_PATH_OIDC_PORT || 4935)}`;

test('OIDC sign-in under a base path lands in the app with a prefixed session', async ({ page, context }) => {
  const id = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const p = { code: `bp${id}`, sub: `bp-${id}`, claims: { name: `Prefixed ${id}`, email: `bp${id}@example.org`, email_verified: true } };
  expect((await fetch(`${OIDC}/__personas`, { method: 'POST', body: JSON.stringify(p) })).ok).toBeTruthy();

  await page.goto(`${ORIGIN}${BASE}/`);
  await page.getByTestId('oauth-oidc').click();
  await expect(page).toHaveURL(/\/application\/o\/authorize\//);
  const authorize = new URL(page.url());
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${BASE}/api/auth/oauth/oidc/callback`);
  const state = (await context.cookies(`${ORIGIN}${BASE}/`)).find((c) => c.name === 'aldine_oauth_state');
  expect(state?.path).toBe(BASE);

  await page.getByTestId(`oidc-persona-${p.code}`).click();
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).pathname.startsWith(BASE)).toBeTruthy();
  const cookies = await context.cookies(`${ORIGIN}${BASE}/`);
  expect(cookies.find((c) => c.name === 'aldine_session')?.path).toBe(BASE);
  expect(cookies.find((c) => c.name === 'aldine_oauth_state')).toBeUndefined();
  const me = await (await page.request.get(`${ORIGIN}${BASE}/api/auth/me`)).json();
  expect(me.user?.email).toBe(p.claims.email);
});
