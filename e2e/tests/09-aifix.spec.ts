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

  test('a fix made by hand clears the diagnosis', async ({ page, request }) => {
    const id = await createProject(request, 'AI Fix By Hand');
    try {
      await request.put(`/api/projects/${id}/file`, {
        data: { branch: 'main', path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\n\\thisisnotacommand\nHello world.\n\\end{document}\n' },
      });
      await openProject(page, id);
      await page.getByTestId('typeset-button').click();
      await expect(page.getByTestId('pdf-status')).toContainText(/error/i, { timeout: 120_000 });
      await openPluginTab(page, 'aifix');
      await page.getByTestId('aifix-diagnose').click();
      await expect(page.getByTestId('aifix-apply-0')).toBeVisible({ timeout: 20_000 });

      // the user deletes the broken line in the editor, not with Apply fix
      await page.locator('.cm-line', { hasText: 'thisisnotacommand' }).click();
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      await page.keyboard.press('Backspace');
      await expect(page.locator('.cm-content')).not.toContainText('thisisnotacommand');
      await page.getByTestId('typeset-button').click();
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 120_000 });

      await expect(page.getByTestId('aifix-explanation')).toHaveCount(0, { timeout: 5_000 });
      await expect(page.getByTestId('aifix-apply-0')).toHaveCount(0);
      await expect(page.getByTestId('aifix-panel')).toContainText('compiles cleanly');
    } finally {
      await cleanup(request, id);
    }
  });

  test('with ALDINE_AI_AUTOFIX a failed typeset opens Fix and diagnoses once', async ({ page, request }) => {
    const id = await createProject(request, 'AI Fix Auto');
    try {
      // the e2e server runs without the flag; the client only reads it from here
      await page.route('**/api/ai/status', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), autoFix: true } });
      });
      let diagnoses = 0;
      page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/ai/fix')) diagnoses++; });
      await request.put(`/api/projects/${id}/file`, {
        data: { branch: 'main', path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\n\\thisisnotacommand\nHello world.\n\\end{document}\n' },
      });
      await openProject(page, id);
      await expect(page.getByTestId('tab-files')).toHaveAttribute('aria-selected', 'true');

      await page.getByTestId('typeset-button').click();
      await expect(page.getByTestId('pdf-status')).toContainText(/error/i, { timeout: 120_000 });
      await expect(page.getByTestId('tab-more')).toHaveText(/^Fix/, { timeout: 10_000 });
      await expect(page.getByTestId('aifix-explanation')).toContainText(/not defined/, { timeout: 20_000 });
      await expect(page.getByTestId('aifix-auto')).toBeVisible();
      expect(diagnoses).toBe(1);

      // the same failure again is not a new error: no second model call
      await page.getByTestId('typeset-button').click();
      await expect(page.getByTestId('pdf-status')).toContainText(/error/i, { timeout: 120_000 });
      await page.waitForTimeout(3_500); // two of the panel's 1.5 s checks
      expect(diagnoses).toBe(1);
      await expect(page.getByTestId('aifix-explanation')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });

  test('AI status endpoint reports configured, auto-fix off by default', async ({ request }) => {
    const res = await request.get('/api/ai/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.configured).toBeTruthy();
    expect(body.autoFix).toBe(false);
  });
});
