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

  test('lists entries added after it opened, without a reload', async ({ page, request }) => {
    const id = await createProject(request, 'Bib Later');
    try {
      await openProject(page, id);
      await openPluginTab(page, 'references');
      await expect(page.getByTestId('cite-bib-list')).toBeVisible();
      await expect(page.getByTestId('cite-bib-lamport1994')).toHaveCount(0);
      // written behind the page, as a collaborator's upload or an agent would
      const put = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'more.bib', content: BIB } });
      expect(put.ok()).toBeTruthy();
      await expect(page.getByTestId('cite-bib-lamport1994')).toBeVisible({ timeout: 10_000 });
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

  test('a pick joins the citation at the cursor, and says so only when it inserted something', async ({ page, request }) => {
    const id = await createProject(request, 'Bib Join');
    try {
      await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
      const doc = '\\documentclass{article}\n\\begin{document}\nSee \\cite{turing1950}\n\\end{document}\n';
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: doc } })).ok()).toBeTruthy();
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'refs.bib', content: BIB } })).ok()).toBeTruthy();
      await openProject(page, id);
      await openPluginTab(page, 'references');

      // the cursor inside \cite{turing1950|}: one more key, not a \cite inside it
      await page.locator('.cm-line', { hasText: 'See' }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
      await page.getByTestId('cite-bib-lamport1994').click();
      await expect(page.locator('.cm-line', { hasText: 'See' })).toHaveText('See \\cite{turing1950,lamport1994}');
      await expect(page.locator('.toast', { hasText: 'Added lamport1994 to the citation' })).toBeVisible();
      // the cursor is after the citation now: a key it holds stays once
      await page.getByTestId('cite-bib-turing1950').click();
      await expect(page.locator('.toast', { hasText: 'turing1950 is in this citation already' })).toBeVisible();
      await expect(page.locator('.cm-line', { hasText: 'See' })).toHaveText('See \\cite{turing1950,lamport1994}');

      // a .bib in the editor takes no \cite, and nothing claims it did
      await page.getByTestId('tab-files').click();
      await page.getByTestId('file-refs.bib').click();
      await expect(page.getByTestId('active-file')).toHaveText('refs.bib');
      await openPluginTab(page, 'references');
      await page.getByTestId('cite-bib-lamport1994').click();
      await expect(page.locator('.toast', { hasText: 'Open a .tex file and put the cursor where \\cite{lamport1994} goes' })).toBeVisible();
      await expect(page.locator('.cm-content')).not.toContainText('\\cite');
    } finally {
      await cleanup(request, id);
    }
  });

  test('Add & cite writes to the .bib the paper reads, and names it', async ({ page, request }) => {
    const id = await createProject(request, 'Bib Target');
    try {
      await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
      // an Overleaf-style paper: BibTeX with refs.bib, no references.bib
      const doc = '\\documentclass{article}\n\\begin{document}\nPrior work\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n';
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: doc } })).ok()).toBeTruthy();
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'refs.bib', content: BIB } })).ok()).toBeTruthy();
      expect((await request.delete(`/api/projects/${id}/file?branch=main&path=references.bib`)).ok()).toBeTruthy();
      await openProject(page, id);
      await openPluginTab(page, 'references');
      await page.locator('.cm-line', { hasText: 'Prior work' }).click();
      await page.keyboard.press('End');
      await page.getByTestId('reference-query').fill('10.1145/mock.target');
      await page.getByTestId('reference-add').click();
      await expect(page.locator('.toast', { hasText: 'Added doe2020 to refs.bib; inserted \\cite{doe2020}.' })).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.cm-line', { hasText: 'Prior work' })).toHaveText('Prior work\\cite{doe2020}');
      await expect.poll(async () => (await request.get(`/api/projects/${id}/file?branch=main&path=refs.bib`)).text()).toContain('doe2020');
      expect((await request.get(`/api/projects/${id}/file?branch=main&path=references.bib`)).status()).toBe(404);

      // the same paper again: it is there, under the key it has, and cited once
      await page.getByTestId('reference-query').fill('10.1145/mock.target');
      await page.getByTestId('reference-add').click();
      await expect(page.locator('.toast', { hasText: 'doe2020 is in refs.bib already; doe2020 is in this citation already.' })).toBeVisible({ timeout: 10_000 });
      const bib = await (await request.get(`/api/projects/${id}/file?branch=main&path=refs.bib`)).text();
      expect(bib.match(/@article\{doe2020/g)).toHaveLength(1);
    } finally {
      await cleanup(request, id);
    }
  });
});
