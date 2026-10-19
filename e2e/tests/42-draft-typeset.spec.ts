import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, expectTypesetOk } from './helpers';

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{One}\\label{one}',
  'See Section~\\ref{two}.',
  '\\section{Two}\\label{two}',
  'Text.',
  '\\end{document}',
  '',
].join('\n');

type Sent = { mode?: string };

test.describe('Draft typeset while typing', () => {
  test('a typed edit gets a draft; a new reference gets the full run by itself', async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await createProject(request, 'Draft Typeset');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      const sent: Sent[] = [];
      page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/compile')) sent.push(r.postDataJSON()); });
      await openProject(page, id);
      await expectTypesetOk(page);
      expect(sent.at(-1)?.mode).toBeUndefined(); // opening the project runs the full cycle

      // a label that did not exist: one pass leaves the reference behind
      await page.locator('.cm-content').getByText('Text.').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' See also~\\ref{three}. \\section{Three}\\label{three}');
      await expect(page.getByTestId('draft-pending')).toBeVisible({ timeout: 30_000 });
      expect(sent.at(-1)?.mode).toBe('draft');

      // the full run follows without a click and settles it
      await expect(page.getByTestId('draft-pending')).toHaveCount(0, { timeout: 30_000 });
      expect(sent.at(-1)?.mode).toBeUndefined();
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in');
    } finally {
      await cleanup(request, id);
    }
  });

  test('pressing Typeset right after typing runs once, not twice', async ({ page, request }) => {
    test.setTimeout(120_000);
    const id = await createProject(request, 'Typeset Once');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await openProject(page, id);
      await expectTypesetOk(page);
      const sent: Sent[] = [];
      page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/compile')) sent.push(r.postDataJSON()); });

      await page.locator('.cm-content').getByText('Text.').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' More words.');
      // past the in-flight window, inside the 2 s auto-typeset delay
      await page.waitForTimeout(700);
      await page.getByTestId('typeset-button').click();
      await expectTypesetOk(page);
      // longer than the auto delay plus the queued-rerun pause
      await page.waitForTimeout(3_500);
      expect(sent).toHaveLength(1);
      expect(sent[0].mode).toBeUndefined();
    } finally {
      await cleanup(request, id);
    }
  });

  test('the palette turns drafts off', async ({ page, request }) => {
    const id = await createProject(request, 'Draft Off');
    try {
      await openProject(page, id);
      await page.getByTestId('palette-open').click();
      await expect(page.getByTestId('palette-input')).toBeFocused();
      await page.keyboard.type('full cycle');
      await page.getByTestId('palette-item-draft-typeset').click();
      expect(await page.evaluate(() => localStorage.getItem('aldine.draftTypeset'))).toBe('0');
    } finally {
      await cleanup(request, id);
    }
  });
});
