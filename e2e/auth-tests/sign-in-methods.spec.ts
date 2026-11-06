import { test, expect } from '../fixtures';
import type { Browser, Page } from '@playwright/test';

/**
 * Sign-in methods in Account settings: a password account connects ORCID or
 * single sign-on (mock-orcid.mjs, mock-oidc.mjs) and signs in either way
 * afterwards. Every test registers its own identities, so a re-run against
 * the kept .data-auth starts from the same situation, and has its own client
 * address, so it stays off the sign-in limits the suite shares.
 */
const ORCID = `http://localhost:${Number(process.env.E2E_AUTH_MOCK_PORT || 4929)}`;
const OIDC = `http://localhost:${Number(process.env.E2E_AUTH_OIDC_PORT || 4930)}`;
const uid = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const email = () => `link${uid()}@test.com`;

async function orcidPersona(): Promise<{ code: string; orcid: string; name: string }> {
  const digits = uid().padStart(15, '0').slice(-15);
  const orcid = `0009-${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}`;
  const p = { code: `o${uid()}`, orcid, name: `Linked Researcher ${uid()}`, email: null };
  const res = await fetch(`${ORCID}/__personas`, { method: 'POST', body: JSON.stringify(p) });
  expect(res.ok, 'the mock ORCID took the persona').toBeTruthy();
  return p;
}

async function oidcPersona(): Promise<{ code: string }> {
  const id = uid();
  const p = { code: `l${id}`, sub: `link-${id}`, claims: { name: `Linked Person ${id}`, email: `linked${id}@example.org`, email_verified: true, groups: ['aldine-users'] } };
  const res = await fetch(`${OIDC}/__personas`, { method: 'POST', body: JSON.stringify(p) });
  expect(res.ok, 'the mock OIDC took the persona').toBeTruthy();
  return p;
}

/** A signed-in password account in its own context and client address. */
async function passwordAccount(browser: Browser, ip: string): Promise<{ page: Page; address: string }> {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
  const address = email();
  const r = await ctx.request.post('/api/auth/register', { data: { email: address, password: 'password123', name: 'Linker' } });
  expect(r.ok(), 'registered').toBeTruthy();
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
  return { page, address };
}

async function openAccount(page: Page) {
  await page.getByTestId('account-menu').click();
  await page.getByTestId('user-name').click();
  await expect(page.getByTestId('account-settings')).toBeVisible();
  return page.getByTestId('account-settings');
}

async function signOut(page: Page) {
  await page.goto('/');
  await page.getByTestId('account-menu').click();
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('auth-email')).toBeVisible();
}

test.describe('sign-in methods', () => {
  test('a password account connects ORCID, signs in with it, and disconnects it', async ({ browser }) => {
    const { page, address } = await passwordAccount(browser, '203.0.113.81');
    const persona = await orcidPersona();
    const settings = await openAccount(page);
    const methods = settings.getByTestId('sign-in-methods');
    await expect(methods.getByTestId('sign-in-method-password')).toHaveText('Email & password');
    await methods.getByTestId('sign-in-method-orcid-connect').click();
    await page.getByTestId(`persona-${persona.code}`).click();

    // Back in Account settings, with the connection listed.
    await expect(page.getByTestId('account-settings')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('ORCID is connected. You can sign in with it from now on.')).toBeVisible();
    await expect(page.getByTestId('sign-in-method-orcid')).toContainText('ORCID · connected');
    await expect(page.getByTestId('sign-in-method-orcid-disconnect')).toBeVisible();
    expect(new URL(page.url()).search, 'the return parameters are gone').toBe('');

    // Signing in with ORCID now opens the password account.
    await signOut(page);
    await page.getByTestId('oauth-orcid').click();
    await page.getByTestId(`persona-${persona.code}`).click();
    await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
    const again = await openAccount(page);
    await expect(again.getByTestId('account-email')).toHaveText(address);
    await expect(again.getByTestId('account-sign-in')).toHaveText('Email & password');

    // Disconnect: ORCID is offered again, and it no longer reaches this account.
    await again.getByTestId('sign-in-method-orcid-disconnect').click();
    await expect(page.getByText('Disconnected ORCID. It no longer signs in to this account.')).toBeVisible();
    await expect(again.getByTestId('sign-in-method-orcid-connect')).toBeVisible();
    await page.context().close();
  });

  test('single sign-on connects once: another account trying the same identity is told why', async ({ browser }) => {
    const persona = await oidcPersona();
    const first = await passwordAccount(browser, '203.0.113.82');
    await (await openAccount(first.page)).getByTestId('sign-in-method-oidc-connect').click();
    await first.page.getByTestId(`oidc-persona-${persona.code}`).click();
    await expect(first.page.getByTestId('sign-in-method-oidc')).toContainText('Single sign-on · connected', { timeout: 15_000 });

    const second = await passwordAccount(browser, '203.0.113.83');
    await (await openAccount(second.page)).getByTestId('sign-in-method-oidc-connect').click();
    await second.page.getByTestId(`oidc-persona-${persona.code}`).click();
    await expect(second.page.getByRole('heading', { name: 'Couldn’t connect Single sign-on' })).toBeVisible({ timeout: 15_000 });
    await expect(second.page.getByTestId('sign-in-error')).toHaveText('This Single sign-on account already signs in to another account on this server, so it cannot be connected to yours.');
    await second.page.getByTestId('sign-in-error-back').click();
    await expect(second.page.getByTestId('sign-in-method-oidc-connect')).toBeVisible({ timeout: 15_000 });

    // The identity still signs in to the first account only.
    await signOut(second.page);
    await second.page.getByTestId('oauth-oidc').click();
    await second.page.getByTestId(`oidc-persona-${persona.code}`).click();
    await expect(second.page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
    await expect((await openAccount(second.page)).getByTestId('account-email')).toHaveText(first.address);
    await first.page.context().close();
    await second.page.context().close();
  });

  test('connecting from an older session asks for the password first', async ({ browser }) => {
    const { page } = await passwordAccount(browser, '203.0.113.84');
    const persona = await oidcPersona();
    // ALDINE_TEST_HOOKS: the session now dates from 11 minutes ago.
    expect((await page.request.post('/api/test/age-session', { data: { minutes: 11 } })).ok()).toBeTruthy();
    const settings = await openAccount(page);
    await settings.getByTestId('sign-in-method-oidc-connect').click();
    const form = settings.getByTestId('sign-in-method-reauth');
    await expect(form).toContainText('Enter your password to connect Single sign-on');
    await expect(settings.getByTestId('sign-in-method-password-input')).toBeFocused();

    await settings.getByTestId('sign-in-method-password-input').fill('not-my-password');
    await settings.getByTestId('sign-in-method-reauth-submit').click();
    await expect(settings.getByTestId('sign-in-method-reauth-error')).toHaveText('That password is incorrect.');

    await settings.getByTestId('sign-in-method-password-input').fill('password123');
    await settings.getByTestId('sign-in-method-reauth-submit').click();
    await page.getByTestId(`oidc-persona-${persona.code}`).click();
    await expect(page.getByTestId('sign-in-method-oidc')).toContainText('Single sign-on · connected', { timeout: 15_000 });
    await page.context().close();
  });

  test('an ORCID identity with an account of its own cannot be connected', async ({ browser }) => {
    const persona = await orcidPersona();
    const own = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.85' } });
    const ownPage = await own.newPage();
    await ownPage.goto('/');
    await ownPage.getByTestId('oauth-orcid').click();
    await ownPage.getByTestId(`persona-${persona.code}`).click();
    await expect(ownPage.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
    // A single sign-on account has no Sign-in methods to connect.
    await expect((await openAccount(ownPage)).getByTestId('sign-in-methods')).toHaveCount(0);
    await own.close();

    const { page } = await passwordAccount(browser, '203.0.113.86');
    await (await openAccount(page)).getByTestId('sign-in-method-orcid-connect').click();
    await page.getByTestId(`persona-${persona.code}`).click();
    await expect(page.getByTestId('sign-in-error')).toHaveText('This ORCID account already signs in to another account on this server, so it cannot be connected to yours.', { timeout: 15_000 });
    await page.context().close();
  });

  test('a connected ORCID iD receives invitations to it, until ORCID is disconnected', async ({ browser }) => {
    const persona = await orcidPersona();
    const owner = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.87' } });
    expect((await owner.request.post('/api/auth/register', { data: { email: email(), password: 'password123', name: 'Owner' } })).ok()).toBeTruthy();
    const invite = async (name: string) => {
      const proj = await (await owner.request.post('/api/projects', { data: { name } })).json();
      expect((await owner.request.post(`/api/projects/${proj.id}/invitations`, { data: { to: persona.orcid } })).ok(), `invite to ${name}`).toBeTruthy();
      return proj.id as string;
    };
    const waited = await invite(`Waited ${uid()}`);

    const { page } = await passwordAccount(browser, '203.0.113.87');
    await expect(page.locator(`[data-testid="home-invitation"][data-project="${waited}"]`)).toHaveCount(0);
    await (await openAccount(page)).getByTestId('sign-in-method-orcid-connect').click();
    await page.getByTestId(`persona-${persona.code}`).click();
    await expect(page.getByTestId('sign-in-method-orcid-disconnect')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('account-orcid')).toHaveText(persona.orcid);
    await page.keyboard.press('Escape');

    // The invitation that waited, and one sent after the connect.
    const sent = await invite(`Sent after ${uid()}`);
    await page.reload();
    for (const id of [waited, sent]) {
      const offer = page.locator(`[data-testid="home-invitation"][data-project="${id}"]`);
      await expect(offer).toContainText('Owner invited you to');
    }
    await page.locator(`[data-testid="home-invitation"][data-project="${waited}"]`).getByTestId('home-invitation-accept').click();
    await expect(page.getByTestId('project-grid')).toContainText('Waited');

    // Disconnected, a new invitation to the iD does not reach the account.
    await (await openAccount(page)).getByTestId('sign-in-method-orcid-disconnect').click();
    await expect(page.getByText('Invitations and projects shared with your ORCID iD no longer reach it either')).toBeVisible();
    await expect(page.getByTestId('account-orcid')).toHaveCount(0);
    await page.keyboard.press('Escape');
    const later = await invite(`After disconnect ${uid()}`);
    await page.reload();
    await expect(page.getByTestId('new-project')).toBeVisible();
    await expect(page.locator(`[data-testid="home-invitation"][data-project="${later}"]`)).toHaveCount(0);
    await owner.close();
    await page.context().close();
  });
});
