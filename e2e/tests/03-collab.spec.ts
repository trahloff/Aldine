import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

test.describe('real-time collaboration', () => {
  test('edits sync live between two browsers, with presence', async ({ browser, request }) => {
    const id = await createProject(request, 'Collab Test');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      await a.addInitScript(() => { localStorage.setItem('aldine.name', 'Ada'); localStorage.setItem('aldine.color', '#e8554d'); });
      await b.addInitScript(() => { localStorage.setItem('aldine.name', 'Bob'); localStorage.setItem('aldine.color', '#2e933c'); });

      await openProject(a, id);
      await openProject(b, id);

      // A types; B sees it
      await a.locator('.cm-content').click();
      await a.keyboard.type('SYNC-FROM-ADA ');
      await expect(b.locator('.cm-content')).toContainText('SYNC-FROM-ADA', { timeout: 10_000 });

      // B types; A sees it
      await b.locator('.cm-content').click();
      await b.keyboard.press('End');
      await b.keyboard.type(' SYNC-FROM-BOB');
      await expect(a.locator('.cm-content')).toContainText('SYNC-FROM-BOB', { timeout: 10_000 });

      // presence avatars appear on both sides
      await expect(a.getByTestId('presence')).toBeVisible();
      await expect(b.getByTestId('presence')).toBeVisible();
      await expect(a.getByTestId('presence')).toContainText('B'); // Bob's initial

      // no data loss: both markers exist on both sides
      await expect(a.locator('.cm-content')).toContainText('SYNC-FROM-ADA');
      await expect(b.locator('.cm-content')).toContainText('SYNC-FROM-BOB');
    } finally {
      await ctxA.close();
      await ctxB.close();
      await cleanup(request, id);
    }
  });

  test('without accounts, Your name in This browser is what co-authors see', async ({ browser, request }) => {
    const id = await createProject(request, 'Collab Names');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      await b.addInitScript(() => { localStorage.setItem('aldine.name', 'Bob Baker'); localStorage.setItem('aldine.color', '#2e933c'); });
      await openProject(a, id);
      await openProject(b, id);
      await expect(b.getByTestId('presence')).toContainText(/W\d/); // "Writer 123": the made-up name, two initials

      await a.getByTestId('project-settings-open').click();
      const field = a.getByTestId('settings-your-name');
      await expect(field).toHaveValue(/^Writer \d{3}$/);
      await field.fill('Grace Hopper');
      await field.press('Enter');
      expect(await a.evaluate(() => localStorage.getItem('aldine.name'))).toBe('Grace Hopper');
      await a.getByTestId('settings-close').click();
      // live, without reopening the file: the avatar shows two initials and the full name
      await expect(b.getByTestId('presence').locator('[title="Grace Hopper"]')).toHaveText('GH', { timeout: 10_000 });
      await expect(a.getByTestId('presence').locator('[title="Bob Baker"]')).toHaveText('BB');

      // a blank name keeps the one it had
      await a.getByTestId('project-settings-open').click();
      await a.getByTestId('settings-your-name').fill('  ');
      await a.getByTestId('settings-your-name').blur();
      await expect(a.getByTestId('settings-your-name')).toHaveValue('Grace Hopper');
    } finally {
      await ctxA.close();
      await ctxB.close();
      await cleanup(request, id);
    }
  });

  test('edits persist to disk (survive reload)', async ({ page, request }) => {
    const id = await createProject(request, 'Persistence Test');
    try {
      await openProject(page, id);
      await page.locator('.cm-content').click();
      await page.keyboard.type('PERSISTED-TEXT ');
      // hocuspocus debounce is 1.5-8s; wait then reload
      await page.waitForTimeout(3000);
      await page.reload();
      await expect(page.locator('.cm-content')).toContainText('PERSISTED-TEXT', { timeout: 15_000 });
    } finally {
      await cleanup(request, id);
    }
  });

  test('the presence chip empties when the open file gives way to a preview', async ({ browser, request }) => {
    const id = await createProject(request, 'Presence Preview');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'figure.png', content: png, encoding: 'base64' } });
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      await openProject(a, id);
      await openProject(b, id);
      await expect(a.getByTestId('presence')).toBeVisible();

      await a.getByTestId('file-figure.png').click();
      await expect(a.getByTestId('file-preview')).toBeVisible();
      await expect(a.getByTestId('presence'), 'nobody is in a preview').toHaveCount(0);
    } finally {
      await ctxA.close();
      await ctxB.close();
      await cleanup(request, id);
    }
  });
});
