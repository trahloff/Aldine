import { test, expect } from '../fixtures';
import type { Page, APIRequestContext, WebSocketRoute } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

const DOC = '\\documentclass{article}\n\\begin{document}\nFirst paragraph.\n\\end{document}\n';

const readFile = async (request: APIRequestContext, id: string, path = 'main.tex') =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(path)}`)).text();

/** Type `text` at the end of the line holding `anchor`. */
async function typeAfter(page: Page, anchor: string, text: string) {
  await page.locator('.cm-line', { hasText: anchor }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

/** Closing the page the way a person closes the tab: true when the page asked
 *  first (the prompt is dismissed, so the page stays open). */
async function closeAsks(page: Page): Promise<boolean> {
  const asked = page.waitForEvent('dialog', { timeout: 3000 }).then(async (d) => {
    expect(d.type()).toBe('beforeunload');
    await d.dismiss();
    return true;
  }, () => false);
  await page.close({ runBeforeUnload: true });
  return asked;
}

test.describe('offline and unsaved edits', () => {
  test('the status line says when edits are saved and when the connection is gone, and edits made offline are saved once it is back', async ({ page, request, context }) => {
    const id = await createProject(request, 'Offline Edits');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await openProject(page, id);
      const status = page.getByTestId('sync-status');
      await expect(status).toHaveAttribute('data-state', 'saved');
      await expect(status).toHaveText('Saved');

      // typing over a working connection never says anything but Saved
      await typeAfter(page, 'First paragraph.', ' Typed online.');
      await expect(status).toHaveAttribute('data-unsynced', 'false');
      await expect(status).toHaveText('Saved');
      await expect.poll(() => readFile(request, id)).toContain('Typed online.');

      await context.setOffline(true);
      await expect(status).toHaveAttribute('data-state', 'offline');
      await expect(status).toHaveText('Offline');
      // editing goes on offline, and the status says those edits wait
      await typeAfter(page, 'Typed online.', ' Typed offline.');
      await expect(page.locator('.cm-content')).toContainText('Typed online. Typed offline.');
      await expect(status).toHaveAttribute('data-unsynced', 'true');
      await expect(status).toHaveText('Not saved · offline');
      await expect(status).toHaveAttribute('title', /Keep the tab open/);
      expect(await readFile(request, id)).not.toContain('Typed offline.');

      await context.setOffline(false);
      await expect(status).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
      await expect(status).toHaveAttribute('data-unsynced', 'false');
      await expect.poll(() => readFile(request, id)).toContain('Typed online. Typed offline.');
      // merged once, not twice
      expect((await readFile(request, id)).split('Typed offline.').length).toBe(2);
    } finally { await context.setOffline(false); await cleanup(request, id); }
  });

  test('a server that stops answering shows as reconnecting, and the edits made meanwhile reach it once it is back', async ({ page, request }) => {
    const id = await createProject(request, 'Server Gone');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      // every collab socket goes through here; `down` refuses new ones
      let down = false;
      const sockets: WebSocketRoute[] = [];
      await page.routeWebSocket(/\/collab$/, (ws) => {
        if (down) { void ws.close({ code: 1011, reason: 'down' }); return; }
        sockets.push(ws, ws.connectToServer());
      });
      await openProject(page, id);
      const status = page.getByTestId('sync-status');
      await expect(status).toHaveAttribute('data-state', 'saved');

      down = true;
      for (const ws of sockets.splice(0)) await ws.close({ code: 1011, reason: 'down' });
      await expect(status).toHaveAttribute('data-state', 'offline');
      await expect(status).toHaveText('Reconnecting…');
      await typeAfter(page, 'First paragraph.', ' Written while the server was away.');
      await expect(status).toHaveText('Not saved · reconnecting');
      expect(await readFile(request, id)).not.toContain('Written while the server was away.');

      down = false;
      // the socket retries on its own, with a backoff of a few seconds by now
      await expect(status).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
      await expect.poll(() => readFile(request, id)).toContain('First paragraph. Written while the server was away.');
    } finally { await cleanup(request, id); }
  });

  test('closing the tab asks first while edits are not saved, and not once they are', async ({ browser, request }) => {
    const id = await createProject(request, 'Close Warning');
    const context = await browser.newContext();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      // saved edits: the tab closes without a word
      const saved = await context.newPage();
      await openProject(saved, id);
      await typeAfter(saved, 'First paragraph.', ' Saved edit.');
      await expect(saved.getByTestId('sync-status')).toHaveAttribute('data-unsynced', 'false');
      await expect.poll(() => readFile(request, id)).toContain('Saved edit.');
      expect(await closeAsks(saved)).toBe(false);
      await expect.poll(() => saved.isClosed()).toBe(true);

      // an edit the server does not have yet: the tab asks before it closes
      const page = await context.newPage();
      await openProject(page, id);
      await context.setOffline(true);
      await typeAfter(page, 'Saved edit.', ' Unsaved edit.');
      await expect(page.getByTestId('sync-status')).toHaveAttribute('data-unsynced', 'true');
      expect(await closeAsks(page)).toBe(true);
      expect(page.isClosed()).toBe(false);
      await expect(page.locator('.cm-content')).toContainText('Unsaved edit.');

      // once it is saved, closing is quiet again
      await context.setOffline(false);
      await expect(page.getByTestId('sync-status')).toHaveAttribute('data-unsynced', 'false', { timeout: 20_000 });
      await expect.poll(() => readFile(request, id)).toContain('Saved edit. Unsaved edit.');
      expect(await closeAsks(page)).toBe(false);
      await expect.poll(() => page.isClosed()).toBe(true);
    } finally { await context.close(); await cleanup(request, id); }
  });

  test('leaving the editor inside the app with unsaved edits asks first, for Back to projects and the browser’s Back', async ({ page, request, context }) => {
    const id = await createProject(request, 'Leave Guard');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      const dialog = page.getByTestId('app-dialog');
      const back = page.getByRole('button', { name: 'Back to projects' });
      const fromHome = async () => {
        await page.goto('/');
        await page.getByTestId(`open-${id}`).click();
        await expect(page.getByTestId('code-pane')).toHaveAttribute('data-loaded', 'true');
      };

      // everything saved: no question
      await fromHome();
      await typeAfter(page, 'First paragraph.', ' Saved.');
      await expect(page.getByTestId('sync-status')).toHaveAttribute('data-unsynced', 'false');
      await back.click();
      await expect(page).toHaveURL(/\/$/);
      await expect(dialog).toHaveCount(0);

      await fromHome();
      await context.setOffline(true);
      await typeAfter(page, 'Saved.', ' Not on the server yet.');
      await expect(page.getByTestId('sync-status')).toHaveAttribute('data-unsynced', 'true');

      // Back to projects asks; Stay is the default
      await back.click();
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('dialog-title')).toHaveText('Some edits aren’t saved yet. Leave anyway?');
      await expect(page.getByTestId('dialog-cancel')).toHaveText('Stay');
      await expect(page.getByTestId('dialog-confirm')).toHaveText('Leave');
      await expect(page.getByTestId('dialog-cancel')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/p/${id}$`));
      await expect(page.locator('.cm-content')).toContainText('Saved. Not on the server yet.');

      // so does the browser's Back, and Stay keeps the editor where it was
      await page.evaluate(() => history.back());
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/p/${id}$`));
      await page.getByTestId('dialog-cancel').click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/p/${id}$`));
      await expect(page.locator('.cm-content')).toContainText('Not on the server yet.');
      await typeAfter(page, 'Not on the server yet.', ' Still here.');
      await expect(page.locator('.cm-content')).toContainText('Not on the server yet. Still here.');

      // Leave goes where the browser was asked to go
      await page.evaluate(() => history.back());
      await expect(dialog).toBeVisible();
      await page.getByTestId('dialog-confirm').click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId('editor-shell')).toHaveCount(0);
    } finally { await context.setOffline(false); await cleanup(request, id); }
  });

  test('a file takes no typing until it has loaded from the server', async ({ page, request }) => {
    const id = await createProject(request, 'Load Gate');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      // hold what the page sends until released, as a slow server would
      let held = true;
      const queue: Array<() => void> = [];
      await page.routeWebSocket(/\/collab$/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((m) => { if (held) queue.push(() => server.send(m)); else server.send(m); });
      });
      await page.goto(`/p/${id}`);
      await expect(page.locator('.cm-content')).toBeVisible();
      const status = page.getByTestId('sync-status');
      await expect(status).toHaveAttribute('data-state', 'connecting');
      await expect(status).toHaveText('Connecting…');
      await expect(page.locator('.cm-content')).toHaveAttribute('aria-readonly', 'true');
      await page.locator('.cm-content').click();
      await page.keyboard.type('Typed too early');
      await expect(page.locator('.cm-content')).not.toContainText('Typed too early');

      held = false;
      for (const send of queue.splice(0)) send();
      await expect(page.getByTestId('code-pane')).toHaveAttribute('data-loaded', 'true');
      await expect(status).toHaveAttribute('data-state', 'saved');
      await expect(page.locator('.cm-content')).not.toHaveAttribute('aria-readonly', 'true');
      await typeAfter(page, 'First paragraph.', ' Typed after loading.');
      await expect.poll(() => readFile(request, id)).toContain('First paragraph. Typed after loading.');
      expect(await readFile(request, id)).not.toContain('Typed too early');
    } finally { await cleanup(request, id); }
  });
});
