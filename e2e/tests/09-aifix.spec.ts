import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, openPluginTab } from './helpers';

/** Runs against the mock Anthropic API (tests/mock-zotero.mjs serves /v1/messages). */
test.describe('AI error fix (plugin)', () => {
  test('diagnose a broken document and apply the fix to compile green', async ({ page, request }) => {
    const id = await createProject(request, 'AI Fix');
    try {
      // inject an undefined control sequence
      await request.put(`/api/projects/${id}/file`, {
        data: { branch: 'main', path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\n\\thisisnotacommand\nHello world.\n\\end{document}\n' },
      });
      await openProject(page, id);

      // typeset → fails
      await page.getByTestId('typeset-button').click();
      await expect(page.getByTestId('pdf-status')).toContainText(/error/i, { timeout: 120_000 });

      // open the Fix plugin (proves the AI plugin loaded)
      await openPluginTab(page, 'aifix');

      // diagnose
      await page.getByTestId('aifix-diagnose').click();
      await expect(page.getByTestId('aifix-explanation')).toContainText(/not defined|undefined|removing/i, { timeout: 20_000 });

      // apply the proposed fix
      await page.getByTestId('aifix-apply-0').click();
      await expect(page.getByTestId('aifix-apply-0')).toContainText('Applied', { timeout: 10_000 });

      // the undefined command is gone from the editor, and a recompile succeeds
      await expect(page.locator('.cm-content')).not.toContainText('thisisnotacommand', { timeout: 10_000 });
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 120_000 });
    } finally {
      await cleanup(request, id);
    }
  });

  test('AI status endpoint reports configured', async ({ request }) => {
    const res = await request.get('/api/ai/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.configured).toBeTruthy();
  });
});
