import { test, expect } from '../fixtures';

/**
 * The operator's privacy policy, legal notice and terms (#125):
 * ALDINE_PRIVACY_URL, ALDINE_LEGAL_URL and ALDINE_TERMS_URL, set on the auth
 * server of playwright.base-path.config.ts. The first server of that config
 * sets none of them and shows none.
 */
const BASE = '/internal/aldine';
const ORIGIN = `http://localhost:${Number(process.env.E2E_BASE_PATH_AUTH_PORT || 3302)}`;
const OIDC = `http://localhost:${Number(process.env.E2E_BASE_PATH_OIDC_PORT || 4935)}`;
const PRIVACY = 'https://example.org/privacy';
const LEGAL = 'https://example.org/impressum';
const TERMS = 'https://example.org/terms';

test('privacy, legal notice and terms on the sign-in page, at sign-up, in the account menu and in About', async ({ page, context }) => {
  // The operator's pages are not ours to load; a stand-in answers for them.
  await context.route('https://example.org/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>Operator page</title>' }));

  await page.goto(`${ORIGIN}${BASE}/`);
  const credit = page.getByTestId('operator-credit');
  const links = credit.getByTestId('legal-links');
  await expect(links).toHaveText('Privacy · Legal notice · Terms');
  await expect(links.getByTestId('legal-privacy')).toHaveAttribute('href', PRIVACY);
  await expect(links.getByTestId('legal-legal')).toHaveAttribute('href', LEGAL);
  await expect(links.getByTestId('legal-terms')).toHaveAttribute('href', TERMS);
  await expect(links.getByTestId('legal-privacy')).toHaveAttribute('target', '_blank');
  await expect(page.getByTestId('signup-agreement')).toHaveCount(0);

  await page.getByTestId('auth-switch').click();
  const agreement = page.getByTestId('signup-agreement');
  await expect(agreement).toHaveText('By creating an account you agree to the terms and the privacy policy.');
  await expect(agreement.getByTestId('signup-terms')).toHaveAttribute('href', TERMS);
  await expect(agreement.getByTestId('signup-privacy')).toHaveAttribute('href', PRIVACY);
  await page.getByTestId('auth-switch').click();
  await expect(page.getByTestId('signup-agreement')).toHaveCount(0);

  const id = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const p = { code: `legal${id}`, sub: `legal-${id}`, claims: { name: `Legal Test ${id}`, email: `legal${id}@example.org`, email_verified: true } };
  expect((await fetch(`${OIDC}/__personas`, { method: 'POST', body: JSON.stringify(p) })).ok).toBeTruthy();
  await page.getByTestId('oauth-oidc').click();
  await page.getByTestId(`oidc-persona-${p.code}`).click();
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('account-menu').click();
  await expect(page.getByTestId('menu-legal-privacy')).toHaveText('Privacy');
  await expect(page.getByTestId('menu-legal-legal')).toHaveText('Legal notice');
  await expect(page.getByTestId('menu-legal-terms')).toHaveText('Terms');
  const [legal] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('menu-legal-legal').click()]);
  await expect(legal).toHaveURL(LEGAL);
  await legal.close();

  await page.getByTestId('account-menu').click();
  await page.getByTestId('open-about').click();
  const about = page.getByTestId('about-modal');
  await expect(about.getByTestId('legal-links')).toHaveText('Privacy · Legal notice · Terms');
  await expect(about.getByTestId('legal-terms')).toHaveAttribute('href', TERMS);
});

test('nothing appears when none of the three is set', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('home-more').click();
  await expect(page.getByTestId('open-about')).toBeVisible();
  await expect(page.locator('[data-testid^="menu-legal-"]')).toHaveCount(0);
  await page.getByTestId('open-about').click();
  await expect(page.getByTestId('about-modal')).toBeVisible();
  await expect(page.getByTestId('legal-links')).toHaveCount(0);
});
