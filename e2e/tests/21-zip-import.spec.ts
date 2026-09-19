/**
 * ZIP import hardening (issue #11): archives the reader used to misread or
 * skip silently, each with the message the user sees, plus a 60 MB import
 * through the browser's multipart upload.
 */
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildZip, cleanup } from './helpers';

const IMPORT_MAX_ZIP_BYTES = 60 * 1024 * 1024;
const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

const tmpZip = (name: string, zip: Buffer) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-zip11-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, zip);
  return { dir, file };
};

const projectNamed = async (page: Page, name: string) => {
  const list = await (await page.request.get('/api/projects')).json();
  return list.find((p: { name: string }) => p.name === name);
};

const importFromHome = async (page: Page, file: string) => {
  await page.goto('/');
  await page.getByTestId('import-input').setInputFiles(file);
};

test.describe('ZIP import hardening', () => {
  test('a bzip2 entry is refused with the method named, no project created', async ({ page }) => {
    const name = `bzip2-${Date.now()}`;
    const { dir, file } = tmpZip(`${name}.zip`, buildZip({ 'main.tex': doc('x'), 'figs/plot.pdf': { data: 'BZh91AY&SY', method: 12 } }));
    try {
      await importFromHome(page, file);
      await expect(page.locator('.toast').filter({ hasText: 'entry "figs/plot.pdf" uses bzip2 compression (method 12); only store and deflate are supported' })).toBeVisible();
      await expect(page.getByTestId('editor-shell')).toHaveCount(0);
      expect(await projectNamed(page, name)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a password-protected entry is refused, not imported as garbage', async ({ page }) => {
    const name = `encrypted-${Date.now()}`;
    const { dir, file } = tmpZip(`${name}.zip`, buildZip({ 'main.tex': { data: crypto.randomBytes(64), flags: 0x1 } }));
    try {
      await importFromHome(page, file);
      await expect(page.locator('.toast').filter({ hasText: 'entry "main.tex" is password protected (ZipCrypto); remove the password and export the archive again' })).toBeVisible();
      expect(await projectNamed(page, name)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a ZIP64 archive imports with its root detected', async ({ page, request }) => {
    const name = `zip64-${Date.now()}`;
    const { dir, file } = tmpZip(`${name}.zip`, buildZip({
      'paper/main.tex': doc('ZIP64-IMPORTED'),
      'paper/refs.bib': { data: '@book{k, title={T}}\n', method: 8 },
    }, { zip64: true }));
    let id: string | null = null;
    try {
      await importFromHome(page, file);
      await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 20_000 });
      id = new URL(page.url()).pathname.split('/')[2];
      const meta = await (await request.get(`/api/projects/${id}`)).json();
      expect(meta.rootFile).toBe('paper/main.tex');
      await expect(page.locator('.cm-content')).toContainText('ZIP64-IMPORTED');
      await expect(page.getByTestId('file-paper/refs.bib')).toBeVisible();
    } finally {
      if (id) await cleanup(request, id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cp437 file names from a Windows archive are decoded', async ({ page, request }) => {
    const name = `cp437-${Date.now()}`;
    // "résumé.tex" as Windows Explorer writes it: cp437 bytes, UTF-8 flag unset
    const raw = Buffer.concat([Buffer.from('r'), Buffer.from([0x82]), Buffer.from('sum'), Buffer.from([0x82]), Buffer.from('.tex')]);
    const { dir, file } = tmpZip(`${name}.zip`, buildZip({ x: { data: doc('CP437-NAME'), nameBytes: raw } }));
    let id: string | null = null;
    try {
      await importFromHome(page, file);
      await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 20_000 });
      id = new URL(page.url()).pathname.split('/')[2];
      const meta = await (await request.get(`/api/projects/${id}`)).json();
      expect(meta.rootFile).toBe('résumé.tex');
      await expect(page.getByTestId('file-résumé.tex')).toBeVisible();
      await expect(page.locator('.cm-content')).toContainText('CP437-NAME');
    } finally {
      if (id) await cleanup(request, id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a 60 MB archive uploads as multipart and imports', async ({ page, request }) => {
    test.setTimeout(180_000);
    const name = `sixty-${Date.now()}`;
    const asset = crypto.randomBytes(IMPORT_MAX_ZIP_BYTES - 4096);
    const zip = buildZip({ 'main.tex': doc('SIXTY-MB'), 'assets/blob.bin': asset });
    expect(zip.length).toBeLessThanOrEqual(IMPORT_MAX_ZIP_BYTES);
    expect(zip.length).toBeGreaterThan(IMPORT_MAX_ZIP_BYTES - 4096);
    const { dir, file } = tmpZip(`${name}.zip`, zip);
    let id: string | null = null;
    try {
      await page.goto('/');
      const upload = page.waitForRequest((r) => r.url().endsWith('/api/projects/import') && r.method() === 'POST');
      await page.getByTestId('import-input').setInputFiles(file);
      const req = await upload;
      // the browser streams the File in a form; no base64 or JSON copy is made
      expect(req.headers()['content-type']).toMatch(/^multipart\/form-data; boundary=/);
      await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 120_000 });
      id = new URL(page.url()).pathname.split('/')[2];
      const meta = await (await request.get(`/api/projects/${id}`)).json();
      expect(meta.name).toBe(name);
      expect(meta.rootFile).toBe('main.tex');
      const { files } = (await (await request.get(`/api/projects/${id}/files?branch=main`)).json()) as { files: { path: string; size: number }[] };
      const blob = files.find((f: { path: string }) => f.path === 'assets/blob.bin');
      expect(blob?.size).toBe(asset.length);
    } finally {
      if (id) await cleanup(request, id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('over 60 MB: the browser and the multipart API both state the size and the limit', async ({ page, request }) => {
    const name = `toobig-${Date.now()}`;
    const zip = buildZip({ 'main.tex': doc('x'), 'pad.bin': Buffer.alloc(IMPORT_MAX_ZIP_BYTES + 1024 * 1024) });
    const { dir, file } = tmpZip(`${name}.zip`, zip);
    try {
      await importFromHome(page, file);
      await expect(page.locator('.toast').filter({ hasText: /ZIP is 61(\.\d)? MB; the limit is 60 MB/ })).toBeVisible();
      const res = await request.post('/api/projects/import', { multipart: { name, zip: { name: `${name}.zip`, mimeType: 'application/zip', buffer: zip } } });
      expect(res.status()).toBe(413);
      expect((await res.json()).error).toBe('ZIP is 61 MB; the limit is 60 MB');
      expect(await projectNamed(page, name)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the JSON base64 body keeps working for API clients', async ({ request }) => {
    const name = `base64-${Date.now()}`;
    const res = await request.post('/api/projects/import', { data: { name, zipBase64: buildZip({ 'main.tex': doc('B64') }).toString('base64') } });
    expect(res.ok()).toBeTruthy();
    const meta = await res.json();
    try {
      expect(meta.name).toBe(name);
      expect(meta.rootFile).toBe('main.tex');
    } finally {
      await cleanup(request, meta.id);
    }
  });
});
