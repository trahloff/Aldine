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
});
