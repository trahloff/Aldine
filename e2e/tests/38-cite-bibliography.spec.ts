import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, openPluginTab } from './helpers';

const BIB = `@article{turing1950,
  author = {Turing, Alan M.},
  title = {Computing Machinery and Intelligence},
  journal = {Mind},
  year = {1950}
}

@book{lamport1994,
  author = {Lamport, Leslie},
  title = {LaTeX: A Document Preparation System},
  publisher = {Addison-Wesley},
  year = {1994}
}
`;

test.describe('Cite panel: the project bibliography', () => {
  test('lists the .bib entries and inserts the one clicked', async ({ page, request }) => {
    const id = await createProject(request, 'Bib List');
    try {
      const put = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'refs.bib', content: BIB } });
      expect(put.ok()).toBeTruthy();
      await openProject(page, id);
      await openPluginTab(page, 'references');

      const entry = page.getByTestId('cite-bib-lamport1994');
      await expect(entry).toBeVisible();
      await expect(entry).toContainText('Document Preparation System');
      await expect(page.getByTestId('cite-bib-turing1950')).toContainText('Turing');

      await entry.click();
      await expect(page.locator('.cm-content')).toContainText('\\cite{lamport1994}');
    } finally {
      await cleanup(request, id);
    }
  });

  test('the paper search keeps focus while results arrive', async ({ page, request }) => {
    const id = await createProject(request, 'Bib Focus');
    try {
      await openProject(page, id);
      await openPluginTab(page, 'references');
      const search = page.getByTestId('reference-search');
      await search.click();
      // typed key by key, with a pause long enough for a search to come back
      await page.keyboard.type('mock sea', { delay: 30 });
      await expect(page.getByTestId('search-hit-W111')).toBeVisible({ timeout: 10_000 });
      await page.keyboard.type('rchable');
      await expect(search).toBeFocused();
      await expect(search).toHaveValue('mock searchable');
    } finally {
      await cleanup(request, id);
    }
  });
});
