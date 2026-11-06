import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, openPluginTab, typeset } from './helpers';

/** Auto-typeset compiles on open; the typesets here are the test's own. */
async function withoutAutoTypeset(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
}

/** The next typeset's response: { ok, errors, log, … }. */
async function typesetResult(page: Page): Promise<{ ok: boolean; errors: Array<{ message: string }>; log: string }> {
  const res = page.waitForResponse((r) => r.url().includes('/compile') && r.request().method() === 'POST', { timeout: 120_000 });
  await typeset(page);
  return (await res).json();
}

/** What a typeset made of a citation key: undefined in the log, or in the .bbl;
 *  `missing`, a package the compiler's TeX Live lacks. */
async function citation(page: Page, request: APIRequestContext, id: string, key: string) {
  const result = await typesetResult(page);
  const bbl = await request.get(`/api/projects/${id}/output?branch=main&path=${encodeURIComponent('.aldine-out/main.bbl')}`);
  return {
    missing: /File `([^']+\.sty)' not found/.exec(result.log)?.[1] ?? null,
    ok: result.ok,
    undefined: new RegExp(`Citation .${key}. .*undefined|could not be found in the database: ${key}`).test(result.log)
      || result.errors.some((e) => e.message.includes(key) && /undefined|not be found|didn't find/i.test(e.message)),
    inBbl: bbl.ok() && (await bbl.text()).includes(key),
  };
}

/** Put the caret at the end of the line that holds `text`. */
async function caretAfter(page: Page, text: string): Promise<void> {
  await page.locator('.cm-line', { hasText: text }).click();
  await page.keyboard.press('End');
}

/** Runs against the mock Zotero API (tests/mock-zotero.mjs, key: test-key-123). */
test.describe('Zotero integration (via plugin system)', () => {
  // The key is the account's (here the one user of a server without
  // accounts): each test starts with none saved, as a new account would.
  test.beforeEach(async ({ request }) => {
    expect((await request.delete('/api/zotero/key')).ok()).toBeTruthy();
  });

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
      // the key stays with the account: a new link starts at the library
      await expect(page.getByTestId('zotero-library')).toBeVisible();
      await page.getByTestId('zotero-other-key').click();
      await expect(page.getByTestId('zotero-key')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });

  test('a paper that does not load zotero.bib gets the line in one click, and its citations resolve', async ({ page, request }) => {
    const id = await createProject(request, 'Zotero Load Biblatex');
    try {
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await openPluginTab(page, 'zotero');
      await page.getByTestId('zotero-key').fill('test-key-123');
      await page.getByTestId('zotero-connect').click();
      await page.getByTestId('zotero-import').click();

      // the default paper loads references.bib with biblatex, not zotero.bib
      const note = page.getByTestId('zotero-bib-unloaded');
      await expect(note).toContainText('main.tex doesn’t load zotero.bib, so its citations stay undefined.', { timeout: 15_000 });
      const add = page.getByTestId('zotero-load-bib');
      await expect(add).toHaveText('Add \\addbibresource{zotero.bib} to main.tex');

      await caretAfter(page, 'Start writing here');
      await page.getByTestId('zotero-search').click();
      await page.keyboard.type('turing');
      await page.getByTestId('cite-turing1950').click();
      await expect(page.locator('.cm-content')).toContainText('\\cite{turing1950}');

      await add.click();
      await expect(page.locator('.toast', { hasText: 'Added \\addbibresource{zotero.bib} to main.tex' })).toBeVisible();
      await expect(note).toHaveCount(0);
      await expect(page.getByTestId('zotero-panel')).not.toContainText('null');
      // through the open document: the line is in the editor, after the one that was there
      await expect(page.locator('.cm-content')).toContainText('\\addbibresource{references.bib}\\addbibresource{zotero.bib}');

      const typeset = await citation(page, request, id, 'turing1950');
      test.skip(typeset.missing === 'biblatex.sty', 'BasicTeX has no biblatex; CI typesets this with its TeX Live image');
      expect(typeset).toEqual({ missing: null, ok: true, undefined: false, inBbl: true });
    } finally {
      await cleanup(request, id);
    }
  });

  test('a BibTeX paper gets zotero in its \\bibliography list; one with no bibliography is told which line to add', async ({ page, request }) => {
    const id = await createProject(request, 'Zotero Load BibTeX');
    const put = async (content: string) => {
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content } })).ok()).toBeTruthy();
    };
    const BODY = ['\\documentclass{article}', '\\usepackage{natbib}', '\\begin{document}', 'Prior work.', ''];
    try {
      await put([...BODY, '\\end{document}', ''].join('\n'));
      const link = await request.post(`/api/projects/${id}/zotero/link`, { data: { apiKey: 'test-key-123', libraryPrefix: 'users/777' } });
      expect(link.ok()).toBeTruthy();
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await openPluginTab(page, 'zotero');

      // neither biblatex nor a BibTeX style: no edit is clearly right
      const note = page.getByTestId('zotero-bib-unloaded');
      await expect(page.getByTestId('zotero-bib-hint')).toHaveText(
        'Add \\addbibresource{zotero.bib} after \\usepackage{biblatex}, or \\bibliography{zotero} after \\bibliographystyle{…} for BibTeX.');
      await expect(page.getByTestId('zotero-load-bib')).toHaveCount(0);

      // a co-author sets up BibTeX: the panel follows the file
      await put([...BODY, '\\bibliographystyle{plainnat}', '\\bibliography{references}', '\\end{document}', ''].join('\n'));
      const add = page.getByTestId('zotero-load-bib');
      await expect(add).toHaveText('Add zotero to \\bibliography in main.tex', { timeout: 15_000 });
      // BibTeX styles read journal and year, not biblatex's journaltitle and date: the library comes again with those
      await expect(page.locator('.toast', { hasText: 'Exported 2 references again with BibTeX fields, which main.tex uses' })).toBeVisible({ timeout: 15_000 });
      const zbib = await (await request.get(`/api/projects/${id}/file?branch=main&path=zotero.bib`)).text();
      expect(zbib).toContain('journal = {Mind}');
      expect(zbib).not.toContain('journaltitle');

      await caretAfter(page, 'Prior work.');
      await page.getByTestId('zotero-search').click();
      await page.keyboard.type('shannon');
      await page.getByTestId('cite-shannon1948').click();
      await expect(page.locator('.cm-content')).toContainText('Prior work.\\cite{shannon1948}');
      expect(await citation(page, request, id, 'shannon1948')).toMatchObject({ undefined: true, inBbl: false });

      await add.click();
      await expect(page.locator('.toast', { hasText: 'Added zotero to \\bibliography in main.tex' })).toBeVisible();
      await expect(note).toHaveCount(0);
      await expect(page.locator('.cm-content')).toContainText('\\bibliography{references,zotero}');
      expect(await citation(page, request, id, 'shannon1948')).toEqual({ missing: null, ok: true, undefined: false, inBbl: true });
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

  test('the key is pasted once per account; a link changes library or collection in place', async ({ page, request }) => {
    const first = await createProject(request, 'Zotero Key One');
    const second = await createProject(request, 'Zotero Key Two');
    try {
      await openProject(page, first);
      await openPluginTab(page, 'zotero');
      await page.getByTestId('zotero-key').fill('test-key-123');
      await page.getByTestId('zotero-connect').click();
      // subcollections under their parents' names, so two "Sync" tell apart
      const collection = page.getByTestId('zotero-collection');
      await expect(collection.locator('option')).toHaveText(['Entire library', 'CRDT Research', 'CRDT Research / Sync', 'Drafts', 'Drafts / Sync']);
      await page.getByTestId('zotero-import').click();
      await expect(page.getByTestId('zotero-linked')).toContainText('testuser’s library → zotero.bib', { timeout: 15_000 });

      // the server keeps the key and never hands it back
      const saved = await request.get('/api/zotero/key');
      expect(await saved.json()).toEqual({ saved: true, userID: 777, username: 'testuser' });
      expect(await (await request.get(`/api/projects/${first}`)).text()).not.toContain('test-key-123');

      // another project: no key to paste, straight to the library
      await openProject(page, second);
      await openPluginTab(page, 'zotero');
      await expect(page.getByTestId('zotero-library')).toBeVisible();
      await expect(page.getByTestId('zotero-key')).toHaveCount(0);
      await expect(page.getByTestId('zotero-panel')).toContainText('Signed in as testuser');
      await page.getByTestId('zotero-collection').selectOption('COLL1');
      await page.getByTestId('zotero-import').click();
      await expect(page.getByTestId('zotero-linked')).toContainText('testuser’s library › CRDT Research → zotero.bib', { timeout: 15_000 });

      // a different collection without unlinking, the current one chosen to start with
      await page.getByTestId('zotero-change').click();
      await expect(page.getByTestId('zotero-collection')).toHaveValue('COLL1');
      await page.getByTestId('zotero-collection').selectOption('COLL4');
      await page.getByTestId('zotero-import').click();
      await expect(page.getByTestId('zotero-linked')).toContainText('testuser’s library › Drafts / Sync → zotero.bib', { timeout: 15_000 });
      await page.getByTestId('zotero-change').click();
      await page.getByTestId('zotero-change-cancel').click();
      await expect(page.getByTestId('zotero-linked')).toContainText('Drafts / Sync');
    } finally {
      await cleanup(request, first);
      await cleanup(request, second);
    }
  });

  test('the synced .bib opens read-only under a banner', async ({ page, request }) => {
    const id = await createProject(request, 'Zotero Read Only');
    try {
      expect((await request.post(`/api/projects/${id}/zotero/link`, { data: { apiKey: 'test-key-123', libraryPrefix: 'users/777' } })).ok()).toBeTruthy();
      await openProject(page, id);
      await page.getByTestId('tab-files').click();
      await page.getByTestId('file-zotero.bib').click();
      await expect(page.getByTestId('active-file')).toHaveText('zotero.bib');
      await expect(page.getByTestId('zotero-bib-banner')).toContainText('Synced from Zotero, so it opens read-only');
      const before = await (await request.get(`/api/projects/${id}/file?branch=main&path=zotero.bib`)).text();
      await page.locator('.cm-content').click();
      await page.keyboard.type('hand edit');
      await expect(page.locator('.cm-content')).not.toContainText('hand edit');
      await page.waitForTimeout(500);
      expect(await (await request.get(`/api/projects/${id}/file?branch=main&path=zotero.bib`)).text()).toBe(before);
      // its button leads to the panel that syncs it
      await page.getByTestId('zotero-bib-banner-open').click();
      await expect(page.getByTestId('zotero-sync')).toBeVisible();
      // another .bib stays editable
      await page.getByTestId('tab-files').click();
      await page.getByTestId('file-references.bib').click();
      await expect(page.getByTestId('zotero-bib-banner')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('palette commands reach Zotero, Cite offers it, and opening a linked project asks for a sync', async ({ page, request }) => {
    const id = await createProject(request, 'Zotero Palette');
    try {
      // an empty bibliography points at Zotero
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'references.bib', content: '' } })).ok()).toBeTruthy();
      await openProject(page, id);
      await openPluginTab(page, 'references');
      await expect(page.getByTestId('cite-bib-empty')).toContainText('or import from Zotero');
      await page.getByTestId('cite-import-zotero').click();
      await expect(page.getByTestId('zotero-key')).toBeVisible();

      await page.getByTestId('tab-files').click();
      await page.getByTestId('palette-open').click();
      await page.keyboard.type('Zotero: import');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('zotero-key')).toBeVisible();

      // linked: the project asks for a sync when it opens; the server skips a fresh one
      expect((await request.post(`/api/projects/${id}/zotero/link`, { data: { apiKey: 'test-key-123', libraryPrefix: 'users/777' } })).ok()).toBeTruthy();
      const onOpen = page.waitForRequest((r) => r.url().endsWith(`/api/projects/${id}/zotero/sync`) && r.method() === 'POST');
      await openProject(page, id);
      expect((await onOpen).postDataJSON()).toMatchObject({ olderThan: 3600 });

      await page.getByTestId('palette-open').click();
      await page.keyboard.type('Zotero: sync');
      await page.keyboard.press('Enter');
      await expect(page.locator('.toast', { hasText: /Zotero library unchanged|Synced/ })).toBeVisible({ timeout: 10_000 });
    } finally {
      await cleanup(request, id);
    }
  });
});
