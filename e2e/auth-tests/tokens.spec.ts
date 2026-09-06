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
    const token = await page.getByTestId('agent-token-value').inputValue();
    expect(token).toMatch(/^aldn_/);
    // connector onboarding copy points at /mcp; on localhost the card says
    // claude.ai cannot reach it and gives the Claude Code command instead
    await expect(page.getByTestId('agent-connector-url')).toContainText('/mcp');
    await expect(page.getByTestId('agent-connector-unreachable')).toBeVisible();
    await expect(page.getByTestId('account-settings')).toContainText('claude mcp add');
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
      await expect(page.getByTestId('agent-token-scope')).toContainText('1 project');
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
