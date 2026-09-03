import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, buildZip, expectTypesetOk } from './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

async function meta(request: import('@playwright/test').APIRequestContext, id: string) {
  return (await request.get(`/api/projects/${id}`)).json();
}

/** Zip a fixture directory (flat, text files) into a temp file for the import input. */
function zipFixture(name: string, extra: Record<string, Buffer | string> = {}): { dir: string; file: string; stem: string } {
  const src = path.join(FIXTURES, name);
  const entries: Record<string, Buffer | string> = { ...extra };
  for (const f of fs.readdirSync(src)) entries[f] = fs.readFileSync(path.join(src, f));
  const stem = `${name}-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-engine-'));
  const file = path.join(dir, `${stem}.zip`);
  fs.writeFileSync(file, buildZip(entries));
  return { dir, file, stem };
}

/** Import through the Home input and assert the import toast (it lives 3.4 s,
 *  so it is checked before the editor finishes loading), then return the id. */
async function importFile(page: import('@playwright/test').Page, file: string, stem: string, toastText: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('import-input').setInputFiles(file);
  await expect(page.locator('.toast').filter({ hasText: `Imported ${stem}` })).toContainText(toastText, { timeout: 20_000 });
  await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 20_000 });
  return new URL(page.url()).pathname.split('/')[2];
}

test.describe('engine detection on import', () => {
  test('a latexmkrc with $pdf_mode 4 selects XeLaTeX and the import typesets with it', async ({ page, request }) => {
    const { dir, file, stem } = zipFixture('import-latexmkrc');
    let id: string | null = null;
    try {
      id = await importFile(page, file, stem, 'XeLaTeX (latexmkrc in the archive)');
      expect((await meta(request, id)).engine).toBe('xelatex');
      await expect(page.getByTestId('engine-select')).toHaveValue('xelatex');
      // auto-typeset is on by default: the first build runs without any click
      await expectTypesetOk(page);
      await page.getByTestId('view-log').click();
      await expect(page.getByTestId('log-view')).toContainText('XeTeX');
      await page.keyboard.press('Escape');
      // the panel is the permanent home and agrees
      await page.getByTestId('project-settings-open').click();
      await expect(page.getByTestId('compiler-settings')).toBeVisible();
      await expect(page.getByTestId('settings-engine')).toHaveValue('xelatex');
      await expect(page.getByTestId('settings-engine-note')).toHaveText('Set on import because of latexmkrc in the archive');
      await expect(page.getByTestId('settings-root-file')).toHaveValue('main.tex');
    } finally {
      if (id) await cleanup(request, id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a root using xepersian selects XeLaTeX', async ({ page, request }) => {
    // BasicTeX has no xepersian; the detection is the point, not the build
    await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
    const { dir, file, stem } = zipFixture('import-xepersian');
    let id: string | null = null;
    try {
      id = await importFile(page, file, stem, 'XeLaTeX (the xepersian package in the main document)');
      expect((await meta(request, id)).engine).toBe('xelatex');
      await expect(page.getByTestId('engine-select')).toHaveValue('xelatex');
    } finally {
      if (id) await cleanup(request, id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a Latin-1 source is transcoded to UTF-8 and its inputenc follows', async ({ page, request }) => {
    await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
    const latin1 = Buffer.concat([
      Buffer.from('\\documentclass{article}\n\\usepackage[latin1]{inputenc}\n\\begin{document}\nLATIN1-BODY caf'),
      Buffer.from([0xe9]),
      Buffer.from('\n\\end{document}\n'),
    ]);
    const stem = `latin1-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-latin1-'));
    const file = path.join(dir, `${stem}.zip`);
    fs.writeFileSync(file, buildZip({ 'main.tex': latin1 }));
    let id: string | null = null;
    try {
      id = await importFile(page, file, stem, 'main.tex was not UTF-8 and has been transcoded');
      await expect(page.locator('.cm-content')).toContainText('LATIN1-BODY café');
      await expect(page.locator('.cm-content')).toContainText('[utf8]{inputenc}');
      expect((await meta(request, id)).engine).toBe('pdf');
    } finally {
      if (id) await cleanup(request, id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('compiler settings panel', () => {
  test('every compile option lives in the panel and persists', async ({ page, request }) => {
    await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
    const id = await createProject(request, 'Compiler Settings');
    try {
      const doc = '\\documentclass{article}\\begin{document}Second root\\end{document}\n';
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'other.tex', content: doc } })).ok()).toBeTruthy();
      await openProject(page, id);

      await page.getByTestId('project-settings-open').click();
      const panel = page.getByTestId('compiler-settings');
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('settings-texlive')).not.toHaveText('Checking the compiler');
      const texlive = (await page.getByTestId('settings-texlive').textContent()) || '';
      // a current compiler image says "2026, full"; the local script says what it can
      expect(texlive).toMatch(/^(20\d\d, (full|medium)|20\d\d|Not reported by this compiler)$/);

      await page.getByTestId('settings-engine').selectOption('lualatex');
      await expect.poll(async () => (await meta(request, id)).engine).toBe('lualatex');
      await expect(page.getByTestId('engine-select')).toHaveValue('lualatex');

      await page.getByTestId('settings-stop-on-error').check();
      await expect.poll(async () => (await meta(request, id)).stopOnFirstError).toBe(true);
      await expect(page.locator('.toast').filter({ hasText: 'stops at the first error' })).toBeVisible();

      await expect(page.getByTestId('settings-auto-typeset')).not.toBeChecked();
      await page.getByTestId('settings-auto-typeset').check();
      await expect.poll(() => page.evaluate(() => window.localStorage.getItem('aldine.autoTypeset'))).toBe('1');
      await expect(page.getByTestId('auto-toggle')).toHaveClass(/auto-toggle--on/);

      await page.getByTestId('settings-root-file').selectOption('other.tex');
      await expect.poll(async () => (await meta(request, id)).rootFile).toBe('other.tex');
      await expect(page.locator('.toast').filter({ hasText: 'Main document is now other.tex' })).toBeVisible();

      await page.getByTestId('settings-name').fill('Renamed via settings');
      await page.getByTestId('settings-name').press('Enter');
      await expect.poll(async () => (await meta(request, id)).name).toBe('Renamed via settings');
      await expect(page.getByTestId('project-name')).toHaveText('Renamed via settings');

      // Escape closes the dialog without a blur: the typed name must still land
      await page.getByTestId('settings-name').fill('Renamed on Escape');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('project-settings')).toHaveCount(0);
      await expect.poll(async () => (await meta(request, id)).name).toBe('Renamed on Escape');
      await expect(page.getByTestId('project-name')).toHaveText('Renamed on Escape');

      await page.getByTestId('project-settings-open').click();
      await page.getByTestId('settings-close').click();
      await expect(page.getByTestId('project-settings')).toHaveCount(0);

      // the project options are meta and survive a reload; auto-typeset is
      // browser state, and the init script above turns it off again on reload
      await page.reload();
      await expect(page.getByTestId('editor-shell')).toBeVisible();
      await page.keyboard.press(`${mod}+k`);
      await page.getByTestId('palette-input').fill('Project settings');
      await page.getByTestId('palette-item-settings').click();
      await expect(page.getByTestId('settings-engine')).toHaveValue('lualatex');
      await expect(page.getByTestId('settings-stop-on-error')).toBeChecked();
      await expect(page.getByTestId('settings-auto-typeset')).not.toBeChecked();
      await expect(page.getByTestId('settings-root-file')).toHaveValue('other.tex');
    } finally { await cleanup(request, id); }
  });

  test('GET /api/compiler reports the connected compiler', async ({ request }) => {
    const res = await request.get('/api/compiler');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.texlive.release).toMatch(/^(20\d\d|unknown)$/);
    expect(body.texlive.scheme).toMatch(/^(full|medium|unknown)$/);
  });
});
