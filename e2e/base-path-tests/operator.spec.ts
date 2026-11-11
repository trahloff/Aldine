import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';

/**
 * The instance operator (#288): name, logo (light and dark), website and
 * support contact from ALDINE_INSTANCE_* and ALDINE_SUPPORT, shown beside
 * Aldine's own wordmark and never in its place. The auth server of
 * playwright.base-path.config.ts sets them; the base path checks the logo URL
 * goes through withBase().
 */
const BASE = '/internal/aldine';
const ORIGIN = `http://localhost:${Number(process.env.E2E_BASE_PATH_AUTH_PORT || 3302)}`;
const OIDC = `http://localhost:${Number(process.env.E2E_BASE_PATH_OIDC_PORT || 4935)}`;
const NAME = 'Example University Computing Centre';

const loaded = (page: Page, testId: string) => page.getByTestId(testId).first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);

test('the operator shows beside Aldine on the sign-in page, the project list, the menu and About', async ({ page }) => {
  await page.goto(`${ORIGIN}${BASE}/`);
  await expect(page).toHaveTitle(`Sign in – Aldine · ${NAME}`);
  await expect(page.getByTestId('wordmark').first()).toBeVisible();
  const credit = page.getByTestId('operator-credit');
  await expect(credit).toContainText(`Provided by`);
  await expect(credit.getByTestId('operator-name')).toHaveText(NAME);
  await expect(credit.getByRole('link', { name: NAME })).toHaveAttribute('href', 'https://example.org/');
  await expect(credit.getByTestId('operator-support')).toHaveAttribute('href', 'mailto:latex-help@example.org');
  await expect(credit.getByTestId('operator-support')).toHaveText('Email latex-help@example.org');

  // Dark is the default theme: the dark logo shows, the light one is hidden.
  await expect(credit.getByTestId('operator-logo-dark')).toBeVisible();
  await expect(credit.getByTestId('operator-logo')).toBeHidden();
  expect(await credit.getByTestId('operator-logo-dark').getAttribute('src')).toMatch(new RegExp(`^${BASE}/api/instance/logo/dark\\?v=[0-9a-f]+$`));
  expect(await loaded(page, 'operator-logo-dark')).toBe(true);
  const logo = await page.request.get(`${ORIGIN}${BASE}/api/instance/logo`);
  expect(logo.status()).toBe(200);
  expect(logo.headers()['content-type']).toBe('image/svg+xml');
  expect(logo.headers()['content-security-policy']).toContain('sandbox');

  await page.evaluate(() => localStorage.setItem('aldine.theme', 'light'));
  await page.reload();
  await expect(credit.getByTestId('operator-logo')).toBeVisible();
  await expect(credit.getByTestId('operator-logo-dark')).toBeHidden();
  expect(await loaded(page, 'operator-logo')).toBe(true);

  const id = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const p = { code: `op${id}`, sub: `op-${id}`, claims: { name: `Operator Test ${id}`, email: `op${id}@example.org`, email_verified: true } };
  expect((await fetch(`${OIDC}/__personas`, { method: 'POST', body: JSON.stringify(p) })).ok).toBeTruthy();
  await page.getByTestId('oauth-oidc').click();
  await page.getByTestId(`oidc-persona-${p.code}`).click();
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });

  await expect(page).toHaveTitle(`Projects – Aldine · ${NAME}`);
  const bar = page.getByTestId('home-bar');
  await expect(bar.getByTestId('wordmark')).toBeVisible();
  const badge = bar.getByTestId('operator');
  await expect(badge).toHaveAttribute('title', `Provided by ${NAME}`);
  await expect(badge).toHaveAttribute('href', 'https://example.org/');
  await expect(badge.getByTestId('operator-name')).toHaveText(NAME);
  // The operator's mark sits after Aldine's, never before it.
  const [wx, ox] = await Promise.all([bar.getByTestId('wordmark').boundingBox(), badge.boundingBox()]);
  expect(ox!.x).toBeGreaterThan(wx!.x + wx!.width);

  await page.getByTestId('account-menu').click();
  await expect(page.getByTestId('get-help')).toHaveText('Get help…');
  await page.getByTestId('open-about').click();
  const about = page.getByTestId('about-modal');
  await expect(about.getByRole('heading', { name: 'Aldine' })).toBeVisible();
  await expect(about.getByTestId('about-operator')).toHaveText(`This instance is run by ${NAME}. For help, contact latex-help@example.org.`);
  await expect(about.getByTestId('about-source')).toBeVisible();
});
