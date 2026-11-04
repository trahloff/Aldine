import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, openPluginTab } from './helpers';

/** Runs against the mock Zotero API (tests/mock-zotero.mjs, key: test-key-123). */
test.describe('Zotero integration (via plugin system)', () => {
  test('link library, import bib, insert citation, autocomplete', async ({ page, request }) => {
    const id = await createProject(request, 'Zotero Test');
    try {
      await openProject(page, id);

      // the Zotero plugin registered a sidebar tab — proves the plugin system loads
      await openPluginTab(page, 'zotero');

      // connect with the mock key
      await page.getByTestId('zotero-key').fill('test-key-123');
      await page.getByTestId('zotero-connect').click();
      await expect(page.getByTestId('zotero-library')).toBeVisible({ timeout: 10_000 });

      // library picker shows My Library + the group
      await expect(page.getByTestId('zotero-library')).toContainText('My Library');
      await expect(page.getByTestId('zotero-library')).toContainText('Space Lab');

      // import whole library
      await page.getByTestId('zotero-import').click();
      await expect(page.getByTestId('zotero-sync')).toBeVisible({ timeout: 15_000 });

      // zotero.bib landed in the file tree
      await page.getByRole('tab', { name: 'Files' }).click();
      await expect(page.getByTestId('file-zotero.bib')).toBeVisible({ timeout: 10_000 });

      // citation insert via panel
      await openPluginTab(page, 'zotero');
      await page.getByTestId('zotero-search').click();
      // key by key: each keystroke redraws the list, the field keeps focus
      await page.keyboard.type('turing');
      await expect(page.getByTestId('zotero-search')).toHaveValue('turing');
      await page.getByTestId('cite-turing1950').click();
      await expect(page.locator('.cm-content')).toContainText('\\cite{turing1950}');

      // \cite autocomplete from the editor
      await page.locator('.cm-content').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' \\cite{shan');
      // Enter falls through to a newline while the list is stale (a query
      // pending) and for CodeMirror's interactionDelay (75 ms) after it opens.
      await expect(page.locator('.cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled) li[aria-selected]'))
        .toContainText('shannon1948', { timeout: 10_000 });
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter');
      await expect(page.locator('.cm-content')).toContainText('\\cite{shannon1948}');

      // sync-now round trip (mock returns 304 → "unchanged")
      await openPluginTab(page, 'zotero');
      await page.getByTestId('zotero-sync').click();
      await expect(page.locator('.toast').last()).toContainText(/unchanged|Synced/i, { timeout: 10_000 });
    } finally {
      await cleanup(request, id);
    }
  });

  test('a link on a branch imports there, and another branch syncs the whole library', async ({ page, request }) => {
    const id = await createProject(request, 'Zotero Branches');
    try {
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'revision', from: 'main' } })).ok()).toBeTruthy();
      await openProject(page, id, 'revision');
      await openPluginTab(page, 'zotero');
      await page.getByTestId('zotero-key').fill('test-key-123');
      await page.getByTestId('zotero-connect').click();
      await page.getByTestId('zotero-collection').selectOption('COLL1');
      await page.getByTestId('zotero-import').click();
      await expect(page.getByTestId('zotero-linked')).toContainText('testuser’s library › CRDT Research → zotero.bib', { timeout: 15_000 });
      const bibOn = async (branch: string) => (await request.get(`/api/projects/${id}/file?branch=${branch}&path=zotero.bib`)).status();
      expect(await bibOn('revision')).toBe(200);
      expect(await bibOn('main')).toBe(404);

      // the Cite tab, mounted before the import, lists what it brought in
      await openPluginTab(page, 'references');
      await expect(page.getByTestId('cite-bib-turing1950')).toBeVisible();

      // main never had the file: its sync fetches the library in full
      // although Zotero reports no change since the import
      await openProject(page, id);
      await openPluginTab(page, 'zotero');
      await page.getByTestId('zotero-sync').click();
      await expect(page.locator('.toast', { hasText: 'Synced 2 references' })).toBeVisible({ timeout: 10_000 });
      expect(await bibOn('main')).toBe(200);
      await page.getByTestId('zotero-search').click();
      await expect(page.getByTestId('cite-shannon1948')).toBeVisible();

      // an unlink the server refuses says so, and the link stays on screen
      page.on('dialog', (d) => d.accept());
      const unlinkRoute = `**/api/projects/${id}/zotero`;
      await page.route(unlinkRoute, (route) => route.request().method() === 'DELETE'
        ? route.fulfill({ status: 403, json: { error: 'Only the owner can unlink the Zotero library' } })
        : route.fallback());
      await page.getByTestId('zotero-unlink').click();
      await expect(page.locator('.toast', { hasText: 'Unlink failed: Only the owner can unlink the Zotero library' })).toBeVisible();
      await expect(page.getByTestId('zotero-linked')).toBeVisible();
      await page.unroute(unlinkRoute);
      await page.getByTestId('zotero-unlink').click();
      await expect(page.getByTestId('zotero-key')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });

  test('co-authors are offered only what they can do', async ({ page, request }) => {
    const id = await createProject(request, 'Zotero Co-author');
    try {
      // Accounts are off in this suite, so the page is told who it is.
      let role = { isOwner: false, isMember: true };
      await page.route(`**/api/projects/${id}`, async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), ...role, ownerName: 'Ada Owner' } });
      });
      await openProject(page, id);
      await openPluginTab(page, 'zotero');
      await expect(page.getByTestId('zotero-ask-owner')).toContainText('Only Ada Owner, the project owner, can link a Zotero library.');
      await expect(page.getByTestId('zotero-key')).toHaveCount(0);

      // once the owner has linked it: a collaborator syncs, never unlinks
      const link = await request.post(`/api/projects/${id}/zotero/link`, { data: { apiKey: 'test-key-123', libraryPrefix: 'users/777', collectionKey: 'COLL1' } });
      expect(link.ok()).toBeTruthy();
      await openProject(page, id);
      await openPluginTab(page, 'zotero');
      await expect(page.getByTestId('zotero-linked')).toContainText('testuser’s library › CRDT Research → zotero.bib');
      await expect(page.getByTestId('zotero-sync')).toBeVisible();
      await expect(page.getByTestId('zotero-unlink')).toHaveCount(0);

      // a link visitor only cites from it
      role = { isOwner: false, isMember: false };
      await openProject(page, id);
      await openPluginTab(page, 'zotero');
      await expect(page.getByTestId('zotero-search')).toBeVisible();
      await expect(page.getByTestId('zotero-sync')).toHaveCount(0);
      await expect(page.getByTestId('zotero-unlink')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });
});
