import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, typeset, expectTypesetOk } from './helpers';

const WARNINGS = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Citing~\\cite{nothing} and pointing at~\\ref{nowhere}.',
  '\\end{document}',
  '',
].join('\n');

test.describe('Problems panel: warnings stay out of the way', () => {
  test('folds to one line, ignores a kind of warning, and brings it back', async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await createProject(request, 'Problems Fold');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: WARNINGS } });
      await openProject(page, id);
      await expectTypesetOk(page);

      const panel = page.getByTestId('errors-panel');
      const toggle = page.getByTestId('problems-toggle');
      // a document that typesets: the warnings are a single line, not a list
      await expect(panel).toHaveAttribute('data-open', 'false');
      await expect(toggle).toHaveText(/\d+ warnings/);
      const total = Number((await toggle.textContent())!.match(/(\d+) warnings/)![1]);
      await expect(page.getByTestId('problem-warning')).toHaveCount(0);
      expect((await panel.boundingBox())!.height).toBeLessThan(40);

      await toggle.click();
      await expect(panel).toHaveAttribute('data-open', 'true');
      const rows = page.getByTestId('problem-warning');
      await expect(rows).toHaveCount(total);

      const citation = rows.filter({ hasText: /Citation/ });
      await citation.hover();
      await citation.getByTestId('problem-ignore').click();
      await expect(rows).toHaveCount(total - 1);
      await expect(toggle).toHaveText(new RegExp(`${total - 1} warnings?$`));
      await expect(page.getByTestId('problems-unignore')).toHaveText('1 ignored · Show');

      // the choice holds across a typeset and a reload, open state included
      await typeset(page);
      await expectTypesetOk(page);
      await page.reload();
      await expectTypesetOk(page);
      await expect(panel).toHaveAttribute('data-open', 'true');
      await expect(rows).toHaveCount(total - 1);
      await expect(rows.filter({ hasText: /Citation/ })).toHaveCount(0);
      await expect(rows.filter({ hasText: /nowhere/ })).toHaveCount(1);

      await page.getByTestId('problems-unignore').click();
      await expect(rows).toHaveCount(total);
      await expect(page.getByTestId('problems-unignore')).toHaveCount(0);

      await toggle.click();
      await expect(panel).toHaveAttribute('data-open', 'false');
    } finally {
      await cleanup(request, id);
    }
  });

  test('errors open the panel even when warnings were folded', async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await createProject(request, 'Problems Errors');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex',
        content: WARNINGS.replace('\\end{document}', '\\thisisnotacommand\n\\end{document}') } });
      await page.addInitScript(() => localStorage.setItem('aldine.problemsOpen', '0'));
      await openProject(page, id);
      const panel = page.getByTestId('errors-panel');
      await expect(panel).toHaveAttribute('data-open', 'true', { timeout: 120_000 });
      await expect(page.getByTestId('problems-toggle')).toHaveCount(0);
      await expect(panel.locator('.errors__row').first()).toContainText(/Undefined control sequence/i);
    } finally {
      await cleanup(request, id);
    }
  });
});
