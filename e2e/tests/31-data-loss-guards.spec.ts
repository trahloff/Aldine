import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * Five ways a user lost work or saw the wrong thing, from the September QA
 * pass: a double-click on Create, an upload over an open file, a file tree
 * that never learned what another tab did, a branch delete that discarded
 * checkpoints on a one-line question, and a typeset that landed on the
 * branch switched to while it ran.
 */
test.describe('guards against losing work', () => {
  test('a double-click on Create makes one project', async ({ page, request }) => {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('Double click');
    const btn = page.getByTestId('create-project');
    await btn.dblclick();
    await page.waitForURL(/\/p\//, { timeout: 30_000 });
    const id = page.url().split('/p/')[1].split(/[?#]/)[0];
    try {
      const res = await request.get('/api/projects');
      const mine = ((await res.json()) as { id: string; name: string }[]).filter((p) => p.name === 'Double click');
      expect(mine.length, 'exactly one project named after the dialog').toBe(1);
    } finally {
      await cleanup(request, id);
    }
  });

  test('uploading over an existing file asks first, and Cancel keeps the original', async ({ page, request }) => {
    const id = await createProject(request, 'Upload guard');
    try {
      await openProject(page, id);
      const before = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      page.once('dialog', (d) => { expect(d.message()).toContain('main.tex already exists'); d.dismiss(); });
      await page.getByTestId('upload-input').setInputFiles({ name: 'main.tex', mimeType: 'text/plain', buffer: Buffer.from('REPLACED') });
      await page.waitForTimeout(800);
      const after = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(after).toBe(before);

      page.once('dialog', (d) => d.accept());
      await page.getByTestId('upload-input').setInputFiles({ name: 'main.tex', mimeType: 'text/plain', buffer: Buffer.from('REPLACED') });
      await expect.poll(async () => (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text(), { timeout: 10_000 }).toBe('REPLACED');
    } finally {
      await cleanup(request, id);
    }
  });

  test('a second tab sees files another tab creates and deletes, without reloading', async ({ browser, request }) => {
    const id = await createProject(request, 'Tree sync');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      await openProject(a, id);
      await openProject(b, id);

      await a.getByTestId('new-file').click();
      await a.locator('input[placeholder="chapter.tex"]').fill('chapter2.tex');
      await a.keyboard.press('Enter');
      await expect(a.getByTestId('file-chapter2.tex')).toBeVisible();
      await expect(b.getByTestId('file-chapter2.tex'), 'the other tab lists the new file').toBeVisible({ timeout: 10_000 });

      // The agent API path: a write and a delete with no browser involved.
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'from-agent.tex', content: 'x' } });
      await expect(b.getByTestId('file-from-agent.tex')).toBeVisible({ timeout: 10_000 });

      await b.getByTestId('file-chapter2.tex').click();
      await expect(b.getByTestId('active-file')).toHaveText('chapter2.tex');
      await request.delete(`/api/projects/${id}/file?branch=main&path=chapter2.tex`);
      await expect(b.getByTestId('file-chapter2.tex')).toHaveCount(0, { timeout: 10_000 });
      await expect(b.getByTestId('active-file'), 'the editor moved off the deleted file').not.toHaveText('chapter2.tex');
      await b.waitForTimeout(3000);
      const { files: listing } = (await (await request.get(`/api/projects/${id}/files?branch=main`)).json()) as { files: { path: string }[] };
      expect(listing.some((f) => f.path === 'chapter2.tex'), 'the deleted file did not come back').toBe(false);
    } finally {
      await ctxA.close();
      await ctxB.close();
      await cleanup(request, id);
    }
  });

  test('deleting a branch with unmerged checkpoints names them in the question', async ({ page, request }) => {
    const id = await createProject(request, 'Branch guard');
    try {
      await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft', from: 'main' } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'draft', path: 'notes.tex', content: 'three hours of work' } });
      await request.post(`/api/projects/${id}/commit`, { data: { branch: 'draft', message: 'Three hours of work' } });
      const unmerged = await (await request.get(`/api/projects/${id}/branches/unmerged?name=draft`)).json();
      expect(unmerged.count).toBeGreaterThan(0);
      expect(unmerged.newest).toBe('Three hours of work');

      await openProject(page, id);
      await page.getByTestId('branch-menu').click();
      let question = '';
      page.once('dialog', (d) => { question = d.message(); d.dismiss(); });
      await page.getByTestId('delete-draft').click();
      await expect.poll(() => question).toContain('Three hours of work');
      expect(question).toMatch(/checkpoint/);
      const branches = (await (await request.get(`/api/projects/${id}/branches`)).json()) as { name: string }[];
      expect(branches.some((b) => b.name === 'draft'), 'Cancel kept the branch').toBe(true);
    } finally {
      await cleanup(request, id);
    }
  });
});
