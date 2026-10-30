import { test, expect } from '../fixtures';
import type { Browser, Page } from '@playwright/test';

/**
 * ALDINE_SIGNUP=approval, against the second server of
 * playwright.auth.config.ts (ALDINE_ADMIN_EMAILS=admin@test.com, no email
 * transport, ALDINE_TEST_HOOKS for the logged confirmation links, and the
 * suite's mock OpenID Connect provider). Every test uses fresh addresses, so a
 * re-run against the kept .data-auth-approval starts from the same situation.
 */
const ORIGIN = process.env.ALDINE_AUTH_APPROVAL_URL || `http://localhost:${Number(process.env.E2E_AUTH_APPROVAL_PORT || 3210)}`;
const OIDC = `http://localhost:${Number(process.env.E2E_AUTH_OIDC_PORT || 4930)}`;
const ADMIN_EMAIL = 'admin@test.com';
const WAITING = 'An administrator of this server approves new accounts. You can sign in once they have.';
const uid = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

test.use({ baseURL: ORIGIN });
test.skip(!!process.env.ALDINE_AUTH_URL && !process.env.ALDINE_AUTH_APPROVAL_URL, 'needs a server with ALDINE_SIGNUP=approval (ALDINE_AUTH_APPROVAL_URL)');

/** A browser of its own, from its own address (TRUST_PROXY=1 on this server). */
async function ownBrowser(browser: Browser): Promise<Page> {
  const addr = `198.19.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
  return (await browser.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { 'x-forwarded-for': addr } })).newPage();
}

async function confirmationToken(page: Page, email: string): Promise<string> {
  const r = await page.request.get(`/api/test/confirmation-link?email=${encodeURIComponent(email)}`);
  expect(r.ok(), 'the server logged a confirmation link').toBeTruthy();
  return new URL((await r.json()).link, 'http://x').searchParams.get('confirm_email')!;
}

/** The administrator: a typed address on the admin list waits like any
 *  other until its link confirms it, then approves itself (first run);
 *  a re-run signs in. */
async function signInAdmin(page: Page) {
  const reg = await page.request.post('/api/auth/register', { data: { email: ADMIN_EMAIL, password: 'password123', name: 'Admin' } });
  if (reg.ok()) {
    expect((await reg.json()).awaitingApproval).toBe(true);
    const confirmToken = await confirmationToken(page, ADMIN_EMAIL);
    const r = await page.request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: 'password123', confirmToken } });
    expect(r.ok(), await r.text()).toBeTruthy();
  } else {
    expect((await page.request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: 'password123' } })).ok()).toBeTruthy();
  }
  await page.goto('/admin');
  await expect(page.getByTestId('admin-page')).toBeVisible();
}

async function approve(admin: Page, email: string) {
  await admin.goto('/admin');
  const row = admin.getByTestId('admin-user-row').filter({ hasText: email });
  await expect(row.getByTestId('admin-status-waiting')).toHaveText('Waiting for approval');
  await row.getByTestId('admin-manage').click();
  await expect(admin.getByTestId('admin-account-status')).toContainText('Waiting for approval since');
  await expect(admin.getByTestId('admin-enable')).toHaveCount(0);
  await expect(admin.getByTestId('admin-disable')).toHaveCount(0);
  await admin.getByTestId('admin-approve').click();
  await expect(admin.getByTestId('admin-action-message')).toHaveText('They can sign in from now on.');
  await admin.getByTestId('admin-action-confirm').click();
  await expect(admin.getByTestId('admin-account-status')).toHaveText('Active');
  await admin.getByTestId('admin-account-close').click();
  await expect(row.getByTestId('admin-status-active')).toBeVisible();
}

test.describe('sign-up with approval', () => {
  test('a password sign-up waits, confirms its address from the sign-in form, and signs in once approved', async ({ browser }) => {
    const email = `wait${uid()}@test.com`;
    const person = await ownBrowser(browser);
    await person.goto('/');
    await expect(person.getByTestId('auth-email')).toBeVisible();
    await person.getByTestId('auth-switch').click();
    await expect(person.getByTestId('auth-approval-note')).toHaveText('An administrator of this server approves new accounts before they can sign in.');
    await person.getByTestId('auth-name').fill('Waiting Person');
    await person.getByTestId('auth-email').fill(email);
    await person.getByTestId('auth-password').fill('password123');
    await person.getByTestId('auth-submit').click();
    await expect(person.getByTestId('auth-waiting')).toHaveText(`Your account is created. ${WAITING}`);
    await expect(person.getByTestId('new-project')).toHaveCount(0);
    await expect(person.getByTestId('auth-submit')).toHaveText('Sign in');

    // Signing in before anyone approved: refused with the approval message.
    await person.getByTestId('auth-password').fill('password123');
    await person.getByTestId('auth-submit').click();
    await expect(person.getByTestId('auth-waiting')).toHaveText(WAITING);
    await expect(person.getByTestId('auth-error')).toHaveCount(0);

    // The confirmation link, opened while signed out: the sign-in confirms the address.
    await person.goto(`/?confirm_email=${encodeURIComponent(await confirmationToken(person, email))}`);
    await expect(person.getByTestId('auth-info')).toHaveText('Sign in to confirm your email address.');
    await person.getByTestId('auth-email').fill(email);
    await person.getByTestId('auth-password').fill('password123');
    await person.getByTestId('auth-submit').click();
    await expect(person.getByTestId('auth-waiting')).toHaveText(`Your email address is confirmed. ${WAITING}`);
    await expect(person).not.toHaveURL(/confirm_email/);

    const admin = await ownBrowser(browser);
    await signInAdmin(admin);
    await expect(admin.getByTestId('stat-users-waiting')).toBeVisible();
    expect(Number(await admin.getByTestId('stat-users-waiting').locator('.admin__stat-value').textContent())).toBeGreaterThanOrEqual(1);
    // Waiting accounts are listed first.
    await expect(admin.getByTestId('admin-user-row').first().getByTestId('admin-status-waiting')).toBeVisible();
    await approve(admin, email);

    await person.getByTestId('auth-submit').click();
    await expect(person.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
    const me = await (await person.request.get('/api/auth/me')).json();
    expect(me.user.email).toBe(email);
    expect(me.user.emailPending).toBeUndefined();
    await person.context().close();
    await admin.context().close();
  });

  test('a first single sign-on sign-in waits, and gets in once approved', async ({ browser }) => {
    const id = uid();
    const persona = { code: `w${id}`, sub: `wait-${id}`, claims: { name: `Sso Waiting ${id}`, email: `ssowait${id}@example.org`, email_verified: true } };
    expect((await fetch(`${OIDC}/__personas`, { method: 'POST', body: JSON.stringify(persona) })).ok).toBeTruthy();
    const signIn = async (page: Page) => {
      await page.goto('/');
      await page.getByTestId('oauth-oidc').click();
      await page.getByTestId(`oidc-persona-${persona.code}`).click();
    };

    const person = await ownBrowser(browser);
    await signIn(person);
    await expect(person.locator('h1')).toHaveText('Waiting for approval');
    await expect(person.getByTestId('sign-in-error')).toHaveText(`Your account is created. ${WAITING}`);
    await person.getByTestId('sign-in-error-back').click();
    await expect(person.getByTestId('auth-email')).toBeVisible();

    const admin = await ownBrowser(browser);
    await signInAdmin(admin);
    await approve(admin, persona.claims.email);

    await signIn(person);
    await expect(person.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
    await person.context().close();
    await admin.context().close();
  });

  test('disabling and enabling an approved account works as before', async ({ browser }) => {
    const email = `plain${uid()}@test.com`;
    const person = await ownBrowser(browser);
    expect((await (await person.request.post('/api/auth/register', { data: { email, password: 'password123', name: 'Plain' } })).json()).awaitingApproval).toBe(true);
    const admin = await ownBrowser(browser);
    await signInAdmin(admin);
    await approve(admin, email);

    const row = admin.getByTestId('admin-user-row').filter({ hasText: email });
    await row.getByTestId('admin-manage').click();
    await expect(admin.getByTestId('admin-approve')).toHaveCount(0);
    await admin.getByTestId('admin-disable').click();
    await admin.getByTestId('admin-action-confirm').click();
    await expect(admin.getByTestId('admin-account-status')).toContainText('Disabled since');
    await admin.getByTestId('admin-account-close').click();
    await expect(row.getByTestId('admin-status-disabled')).toBeVisible();
    const refused = await person.request.post('/api/auth/login', { data: { email, password: 'password123' } });
    expect(refused.status()).toBe(401);
    expect((await refused.json()).error).toContain('This account is disabled');

    await row.getByTestId('admin-manage').click();
    await expect(admin.getByTestId('admin-approve')).toHaveCount(0);
    await admin.getByTestId('admin-enable').click();
    await admin.getByTestId('admin-action-confirm').click();
    await expect(admin.getByTestId('admin-account-status')).toHaveText('Active');
    expect((await person.request.post('/api/auth/login', { data: { email, password: 'password123' } })).ok()).toBeTruthy();
    await person.context().close();
    await admin.context().close();
  });
});
