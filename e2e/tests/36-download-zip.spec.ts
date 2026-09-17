import { test, expect } from '../fixtures';
import { createPaperProject, openProject, cleanup } from './helpers';
import fs from 'node:fs';
import { unzip } from '../../apps/server/src/unzip';

/**
 * #58: the mirror of the ZIP import. The archive is the branch's tracked
 * tree, taken after the live document is flushed and committed, flat like
 * an Overleaf download — so it imports back and matches what the editor showed.
 */
test.describe('download a project as ZIP', () => {
  test('the archive holds the current source and imports back', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Zip Export Paper');
    try {
      // An edit that is on disk but not yet committed: the archive must carry it.
      const main = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      const marked = main.replace('\\begin{document}', '\\begin{document}\n% ARCHIVE-MARKER');
      expect(marked).not.toBe(main);
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: marked } })).ok()).toBeTruthy();

      const res = await request.get(`/api/projects/${id}/archive?branch=main`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('application/zip');
      expect(res.headers()['content-disposition']).toContain('attachment; filename="Zip-Export-Paper.zip"');
      const zip = Buffer.from(await res.body());
      const entries = unzip(zip);
      const names = Object.keys(entries).sort();
      expect(names.length).toBeGreaterThan(1);
      expect(names).toContain('main.tex');
      expect(names.some((n) => n.startsWith('.git/') || n.includes('.aldine-out'))).toBe(false);
      expect(entries['main.tex'].toString('utf8')).toContain('% ARCHIVE-MARKER');

      // Round trip through the importer: the same files come back.
      const imported = await request.post('/api/projects/import', { multipart: { name: 'Zip Export Roundtrip', zip: { name: 'x.zip', mimeType: 'application/zip', buffer: zip } } });
      expect(imported.ok()).toBeTruthy();
      const { id: id2 } = await imported.json();
      try {
        const listing = (await (await request.get(`/api/projects/${id2}/files?branch=main`)).json()) as Array<{ path: string; type: string }>;
        const back = listing.filter((f) => f.type === 'file' && f.path !== '.gitignore').map((f) => f.path).sort();
        const sent = names.filter((n) => n !== '.gitignore').sort();
        expect(back).toEqual(sent);
        expect(await (await request.get(`/api/projects/${id2}/file?branch=main&path=main.tex`)).text()).toContain('% ARCHIVE-MARKER');
      } finally { await cleanup(request, id2); }
    } finally { await cleanup(request, id); }
  });

  test('an unknown branch is 404 and a bad name is 400', async ({ request }) => {
    const id = await createPaperProject(request, 'Zip Branches');
    try {
      expect((await request.get(`/api/projects/${id}/archive?branch=nope`)).status()).toBe(404);
      expect((await request.get(`/api/projects/${id}/archive?branch=..%2Fx`)).status()).toBe(400);
      expect((await request.get(`/api/projects/zzzzzzzzzz/archive`)).status()).toBe(404);
    } finally { await cleanup(request, id); }
  });

  test('project settings offers the download and the browser saves a .zip', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Zip From Settings');
    try {
      await openProject(page, id);
      await page.getByTestId('project-settings-open').click();
      const link = page.getByTestId('settings-download-zip');
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', /\/api\/projects\/.+\/archive\?branch=main$/);
      const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
      // Browsers prefer the UTF-8 name over the ASCII fallback in the header.
      expect(download.suggestedFilename()).toBe('Zip From Settings.zip');
      const saved = await download.path();
      expect(saved).toBeTruthy();
      const entries = unzip(fs.readFileSync(saved!));
      expect(Object.keys(entries)).toContain('main.tex');
    } finally { await cleanup(request, id); }
  });
});
