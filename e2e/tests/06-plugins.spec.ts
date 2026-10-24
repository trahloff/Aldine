import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, openPluginTab, expectTypesetOk } from './helpers';

const PROBE_DIR = path.resolve(__dirname, '..', 'fixtures', 'plugins', 'api-probe');

/** Serves the fixture plugin beside the instance's own, as if PLUGINS_DIR
 *  held it, so the test runs against any stack (ALDINE_URL included). */
async function installProbe(page: Page): Promise<void> {
  const manifest = JSON.parse(fs.readFileSync(path.join(PROBE_DIR, 'manifest.json'), 'utf8'));
  await page.route('**/api/plugins', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: [...(await res.json()), manifest] });
  });
  await page.route('**/plugins/api-probe/index.js', (route) =>
    route.fulfill({ path: path.join(PROBE_DIR, 'index.js'), contentType: 'text/javascript' }));
}

test.describe('plugin system', () => {
  test('registry lists plugins with manifests', async ({ request }) => {
    const res = await request.get('/api/plugins');
    expect(res.ok()).toBeTruthy();
    const plugins = await res.json();
    expect(Array.isArray(plugins)).toBeTruthy();
    const zotero = plugins.find((p: { id: string }) => p.id === 'zotero');
    expect(zotero).toBeTruthy();
    expect(zotero.entry).toBe('index.js');
    expect(zotero.version).toBeTruthy();
  });

  test('plugin entry is served as an ES module and registers UI', async ({ page, request }) => {
    const res = await request.get('/plugins/zotero/index.js');
    expect(res.ok()).toBeTruthy();
    expect(res.headers()['content-type']).toContain('javascript');

    const id = await createProject(request, 'Plugin Host Test');
    try {
      await openProject(page, id);
      await openPluginTab(page, 'zotero');
      await expect(page.getByTestId('zotero-panel')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });

  // docs/STABILITY.md, "Plugin API": every member listed there, each checked
  // by what it does rather than by its presence.
  test('every member of the plugin API does what it says', async ({ page, request }) => {
    // Typesets come only from aldine.compile(), never from the edits below.
    await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
    await installProbe(page);
    const id = await createProject(request, 'Plugin API Test');
    try {
      // the starter main.tex loads biblatex, which a basic TeX Live lacks
      const minimal = '\\documentclass{article}\n\\begin{document}\nTypeset through the plugin API.\n\\end{document}\n';
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: minimal } })).ok()).toBeTruthy();
      await openProject(page, id);

      // version, project.id and project.branch as activate() saw them, in a
      // panel that ui.registerSidebarPanel put in the sidebar
      await openPluginTab(page, 'api-probe');
      const panel = page.getByTestId('api-probe-panel');
      await expect(panel).toHaveText(`version 1, project ${id}, branch main`);
      expect(await page.evaluate(() => {
        const a = (window as any).__aldineProbe;
        return { version: a.version, id: a.project.id, branch: a.project.branch, activeFile: a.project.activeFile() };
      })).toEqual({ version: 1, id, branch: 'main', activeFile: 'main.tex' });

      // ui.showPanel selects the plugin's own panel from another tab
      await page.getByTestId('tab-files').click();
      await expect(panel).toBeHidden();
      await page.evaluate(() => (window as any).__aldineProbe.ui.showPanel('api-probe'));
      await expect(panel).toBeVisible();

      await page.evaluate(() => (window as any).__aldineProbe.toast('Probe says hello', 'ok'));
      await expect(page.locator('.toast', { hasText: 'Probe says hello' }).locator('.dot--ok')).toBeVisible();

      // fetch reaches the REST API root-relatively, with the page's session
      expect(await page.evaluate(async (pid) => {
        const res = await (window as any).__aldineProbe.fetch(`/api/projects/${pid}`);
        return { status: res.status, name: (await res.json()).name };
      }, id)).toEqual({ status: 200, name: 'Plugin API Test' });

      // project.refresh re-reads the project; nothing else reloads it
      expect((await request.patch(`/api/projects/${id}`, { data: { name: 'Renamed behind the page' } })).ok()).toBeTruthy();
      await expect(page.getByTestId('project-name')).toHaveText('Plugin API Test');
      await page.evaluate(() => (window as any).__aldineProbe.project.refresh());
      await expect(page.getByTestId('project-name')).toHaveText('Renamed behind the page');

      // project.refreshFiles re-reads the file list: a listing that names one
      // more file shows in the tree, and the real one takes it out again
      const listing = (url: URL) => url.pathname.endsWith(`/api/projects/${id}/files`);
      await page.route(listing, async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        await route.fulfill({ response: res, json: { ...body, files: [...body.files, { path: 'listed-by-probe.tex', type: 'file', size: 1 }] } });
      });
      await page.getByTestId('tab-files').click();
      await page.evaluate(() => (window as any).__aldineProbe.project.refreshFiles());
      await expect(page.getByTestId('file-listed-by-probe.tex')).toBeVisible();
      await page.unroute(listing);
      await page.evaluate(() => (window as any).__aldineProbe.project.refreshFiles());
      await expect(page.getByTestId('file-listed-by-probe.tex')).toHaveCount(0);

      // editor.insertAtCursor: the cursor of a fresh editor is at the start
      const inserted = '% inserted by the plugin API probe';
      await page.evaluate((text) => (window as any).__aldineProbe.editor.insertAtCursor(`${text}\n`), inserted);
      await expect(page.locator('.cm-line').first()).toHaveText(inserted);
      await expect.poll(async () => (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text(), { timeout: 15_000 })
        .toMatch(new RegExp(`^${inserted}\\n\\\\documentclass`));

      // compile typesets, and lastCompile reports that run
      expect(await page.evaluate(() => (window as any).__aldineProbe.project.lastCompile())).toBeNull();
      const compiled = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/projects/${id}/compile`));
      await page.evaluate(() => (window as any).__aldineProbe.compile());
      await compiled;
      await expectTypesetOk(page);
      const last = await page.evaluate(() => (window as any).__aldineProbe.project.lastCompile());
      expect(last.ok).toBe(true);
      expect(Array.isArray(last.errors)).toBe(true);
      expect(last.log).toContain('main.tex');

      // project.branch follows the branch the editor has open
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'probe', from: 'main' } })).ok()).toBeTruthy();
      await openProject(page, id, 'probe');
      await openPluginTab(page, 'api-probe');
      await expect(panel).toHaveText(`version 1, project ${id}, branch probe`);
      expect(await page.evaluate(() => (window as any).__aldineProbe.project.branch)).toBe('probe');
    } finally {
      await cleanup(request, id);
    }
  });
});
