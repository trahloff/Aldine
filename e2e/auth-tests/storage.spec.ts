import { randomBytes } from 'node:crypto';
import { test, expect } from '../fixtures';

/**
 * Storage limit per owner (ALDINE_STORAGE_QUOTA_MB, #125). Runs against the
 * third server of playwright.auth.config.ts, started with a 1 MB limit: an
 * upload that does not fit is refused with the sentence in a toast, account
 * settings show usage against the limit, and over it typing still saves.
 */
const STORAGE = process.env.ALDINE_AUTH_LOGOUT_URL || `http://localhost:${Number(process.env.E2E_AUTH_LOGOUT_PORT || 3211)}`;
const uid = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
/** Bytes git cannot compress, so a commit stores them a second time. */
const noise = (bytes: number) => randomBytes(bytes);

test('over the storage limit, uploads are refused with a sentence and typing still saves', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: STORAGE, extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.95' } });
  const page = await ctx.newPage();
  const reg = await page.request.post('/api/auth/register', { data: { email: `storage${uid()}@example.org`, password: 'password123', name: 'Ada Storage' } });
  expect(reg.ok()).toBeTruthy();
  const proj = await (await page.request.post('/api/projects', { data: { name: 'Storage Paper' } })).json();
  const put = (path: string, bytes: number) => page.request.put(`/api/projects/${proj.id}/file`, { data: { branch: 'main', path, content: noise(bytes).toString('base64'), encoding: 'base64' } });
  expect((await put('data.bin', 600 * 1024)).ok(), 'an upload that fits goes through').toBeTruthy();

  // an upload that does not fit: the server's sentence reaches the toast
  await page.goto(`/p/${proj.id}`);
  await expect(page.getByTestId('code-pane')).toHaveAttribute('data-loaded', 'true');
  await page.getByTestId('upload-input').setInputFiles({ name: 'figure.png', mimeType: 'image/png', buffer: noise(600 * 1024) });
  await expect(page.locator('.toast', { hasText: /Could not upload figure\.png: This upload needs 0\.6 MB, and you have [\d.]+ MB of your 1 MB left\./ })).toBeVisible();
  expect((await page.request.get(`/api/projects/${proj.id}/file?branch=main&path=figure.png`)).status()).toBe(404);

  // the history copy of data.bin takes the account over the limit
  expect((await (await page.request.post(`/api/projects/${proj.id}/commit`, { data: { branch: 'main', message: 'Add data' } })).json()).committed).toBe(true);
  const refused = await put('more.bin', 1024);
  expect(refused.status()).toBe(402);
  expect((await refused.json()).error).toMatch(/^You have used [\d.]+ MB of your 1 MB\. Delete files or projects, or empty the trash, to upload again\.$/);

  // typing is never refused
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nWritten over the limit.');
  await expect.poll(async () => (await page.request.get(`/api/projects/${proj.id}/file?branch=main&path=main.tex`)).text(), { timeout: 20_000 }).toContain('Written over the limit.');

  await page.goto('/');
  await page.getByTestId('account-menu').click();
  await page.getByTestId('user-name').click();
  const settings = page.getByTestId('account-settings');
  await expect(settings.getByTestId('account-storage')).toHaveText(/^[\d.]+ MB of 1 MB$/);
  await expect(settings.getByTestId('account-storage-over')).toContainText('Editing keeps working.');
  await page.keyboard.press('Escape');

  await page.request.delete(`/api/projects/${proj.id}?permanent=1`);
  await ctx.close();
});
