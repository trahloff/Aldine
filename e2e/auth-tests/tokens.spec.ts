import { request as pwRequest } from '@playwright/test';
import { test, expect } from '../fixtures';

/** Unique email per run so re-runs don't collide with the persisted user store. */
const uniq = () => `u${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;

async function register(page: import('@playwright/test').Page, email: string, password = 'password123', name = 'Tester') {
  await page.goto('/');
  await expect(page.getByTestId('auth-email')).toBeVisible();
  await page.getByTestId('auth-switch').click(); // to register mode
  await page.getByTestId('auth-name').fill(name);
  await page.getByTestId('auth-email').fill(email);
  await page.getByTestId('auth-password').fill(password);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
}

test.describe('agent access tokens', () => {
  test('create via UI → bearer works → out-of-scope 403 → revoke via UI → 401', async ({ page, baseURL }) => {
    await register(page, uniq());
    // two projects; the token gets scoped to the first only
    const inScope = await (await page.request.post('/api/projects', { data: { name: 'Agent In Scope' } })).json();
    const outScope = await (await page.request.post('/api/projects', { data: { name: 'Agent Out Of Scope' } })).json();
    await page.request.put(`/api/projects/${inScope.id}/file`, { data: { branch: 'main', path: 'agent.tex', content: 'AGENT-READ-ME\n' } });

    // mint a scoped token through the settings card
    await page.getByTestId('user-name').click();
    await expect(page.getByTestId('account-settings')).toBeVisible();
    await page.getByTestId('agent-token-create').click();
    await page.getByTestId('agent-token-name').fill('Claude e2e');
    await page.getByTestId(`agent-token-scope-${inScope.id}`).check();
    await page.getByTestId('agent-token-submit').click();
    await expect(page.getByTestId('agent-token-value')).toBeVisible();
    const token = (await page.getByTestId('agent-token-value').textContent()) ?? '';
    expect(token).toMatch(/^aldn_/);
    // connector onboarding copy points at /mcp; on localhost the card says
    // claude.ai cannot reach it and gives the runnable Claude Code command instead
    await expect(page.getByTestId('agent-connector-url')).toHaveText(`${baseURL}/mcp`);
    await expect(page.getByTestId('agent-connector-unreachable')).toBeVisible();
    await expect(page.getByTestId('agent-claude-code-command')).toHaveText(`claude mcp add --transport http aldine ${baseURL}/mcp`);
    await expect(page.getByTestId('agent-claude-code-copy')).toBeVisible();
    // Connect connections get their own heading once one exists (oauth.spec); a hand-made token is not one
    await expect(page.getByTestId('agent-connections')).toHaveCount(0);
    await page.getByTestId('agent-token-done').click();
    // shown exactly once — dismissing removes the plaintext from the page
    await expect(page.getByTestId('agent-token-value')).toHaveCount(0);
    await expect(page.getByTestId('account-settings')).toContainText('Claude e2e');

    // the bearer credential works headlessly (this context carries no cookies)
    const agent = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
    try {
      const read = await agent.get(`/api/projects/${inScope.id}/file?branch=main&path=agent.tex`);
      expect(read.status()).toBe(200);
      expect(await read.text()).toBe('AGENT-READ-ME\n');
      const listing = await agent.get(`/api/projects/${inScope.id}/files?branch=main`);
      expect(listing.status()).toBe(200);
      expect(typeof (await listing.json()).contentVersion).toBe('number');

      // project scope: the same user's other project is out of reach
      expect((await agent.get(`/api/projects/${outScope.id}/files?branch=main`)).status()).toBe(403);
      expect((await agent.get(`/api/projects/${outScope.id}`)).status()).toBe(403);

      // revoke through the card's own dialog (names the token and its last use) — the row disappears
      // a scoped row names its project, not just a count
      await expect(page.getByTestId('agent-token-scope')).toHaveText('Agent In Scope');
      await expect(page.getByTestId('agent-token-scope')).toHaveAttribute('title', 'Agent In Scope');
      await page.getByTestId('agent-token-revoke').click();
      await expect(page.getByTestId('agent-token-revoke-dialog')).toContainText('Claude e2e');
      await page.getByTestId('agent-token-revoke-confirm').click();
      await expect(page.getByTestId('agent-token-revoke')).toHaveCount(0);

      // the same bearer is rejected on the very next request
      expect((await agent.get(`/api/projects/${inScope.id}/files?branch=main`)).status()).toBe(401);
      expect((await agent.get(`/api/projects/${inScope.id}/file?branch=main&path=agent.tex`)).status()).toBe(401);
    } finally {
      await agent.dispose();
    }
  });
});

/** Bottom edge of a card element must sit above the dialog's sticky action row. */
async function clearOfFooter(page: import('@playwright/test').Page, testId: string) {
  const el = await page.getByTestId(testId).boundingBox();
  const footer = await page.getByTestId('account-settings').locator(':scope > div > .modal__row').boundingBox();
  expect(el, `${testId} has a box`).toBeTruthy();
  expect(footer, 'the sticky footer has a box').toBeTruthy();
  expect(el!.y + el!.height, `${testId} is clear of the sticky footer`).toBeLessThanOrEqual(footer!.y);
}

test.describe('agent access card at 1280×800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the create form and the shown-once token scroll clear of the footer and take focus; an empty name is marked on the field', async ({ page }) => {
    await register(page, uniq());
    // a project makes the form grow by a checklist that loads after it opened
    await page.request.post('/api/projects', { data: { name: 'Scroll target' } });
    await page.getByTestId('user-name').click();
    await expect(page.getByTestId('account-settings')).toBeVisible();
    // opened without scrolling: the whole form, Create button included, is above the footer
    await clearOfFooter(page, 'agent-token-create');
    await page.getByTestId('agent-token-create').click();
    await expect(page.getByTestId('agent-token-name')).toBeFocused();
    await expect(page.getByTestId('agent-token-expiry')).toBeVisible();
    await expect(page.locator('[data-testid^="agent-token-scope-"]')).toHaveCount(1);
    await clearOfFooter(page, 'agent-token-submit');
    await clearOfFooter(page, 'agent-token-expiry');

    // empty name: the field is marked, not just the toast
    await page.getByTestId('agent-token-submit').click();
    await expect(page.getByTestId('agent-token-name-error')).toHaveText('Give the token a name first');
    await expect(page.getByTestId('agent-token-name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('agent-token-name')).toBeFocused();
    await expect(page.getByTestId('agent-token-value')).toHaveCount(0);
    await page.getByTestId('agent-token-name').fill('Typed blind');
    await expect(page.getByTestId('agent-token-name-error')).toHaveCount(0);
    await expect(page.getByTestId('agent-token-name')).toHaveAttribute('maxlength', '100');

    // Enter mints: the secret takes focus, sits above the footer and is not clipped
    await page.getByTestId('agent-token-name').press('Enter');
    await expect(page.getByTestId('agent-token-value')).toBeFocused();
    await expect(page.getByTestId('agent-token-value')).toContainText(/^aldn_/);
    await clearOfFooter(page, 'agent-token-value');
    await clearOfFooter(page, 'agent-token-copy');
    const clipped = await page.getByTestId('agent-token-value').evaluate((el) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
    expect(clipped, 'the whole secret is readable').toBe(false);
    // focusing selected the whole secret for a keyboard copy
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toMatch(/^aldn_/);
  });
});

test.describe('agent access card on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('tap targets are at least 32px and the connector URL wraps instead of hiding its path', async ({ page, baseURL }) => {
    await register(page, uniq());
    await page.getByTestId('user-name').click();
    await expect(page.getByTestId('account-settings')).toBeVisible();
    for (const id of ['agent-token-create', 'agent-claude-code-copy']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.height, `${id} is thumb-sized`).toBeGreaterThanOrEqual(32);
    }
    const url = page.getByTestId('agent-connector-url');
    await expect(url).toHaveText(`${baseURL}/mcp`);
    expect(await url.evaluate((el) => el.scrollWidth > el.clientWidth), 'the URL is not ellipsised').toBe(false);
  });
});
