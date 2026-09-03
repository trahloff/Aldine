import { test, expect } from '../fixtures';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execSync } from 'node:child_process';

/**
 * Runs against the :3101 app server, which has GITLAB_DEFAULT_GROUP set. The
 * main suite deliberately runs without it, so together they cover both the
 * configured and the default (off) path.
 */
const MOCK = 'http://localhost:4921';

test.describe('GitLab as the default project home', () => {
  test.afterEach(async ({ request }) => {
    // Leave the mock healthy even if a test failed mid-way.
    await request.post(`${MOCK}/__fail?on=0`);
  });

  test('a new project is created inside the configured group', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('Group Paper');
    // The picker only renders when a default group is configured.
    await expect(page.getByTestId('namespace-select')).toBeVisible();
    await page.getByTestId('create-project').click();

    await expect(page).toHaveURL(/\/p\//);
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    // Linked on creation: the sync control replaces the Publish button.
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
    await expect(page.getByTestId('remote-pending')).toHaveCount(0);
  });

  test('a project can be created in a chosen subgroup', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('Thesis Paper');
    await page.getByTestId('namespace-select').selectOption('research/latex/theses');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
    await expect(page.getByTestId('gitlab-sync')).toHaveAttribute('title', /research\/latex\/theses\/thesis-paper/);
  });

  test('a subgroup can be created from the modal', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('namespace-new').click();
    await page.getByTestId('namespace-new-name').fill('Grants 2026');
    await page.getByTestId('namespace-new-create').click();
    // The new subgroup is selected, so the next project lands in it.
    await expect(page.getByTestId('namespace-select')).toHaveValue('research/latex/grants-2026');
  });

  test('an unreachable GitLab degrades to a local project with a retry', async ({ page, request }) => {
    await request.post(`${MOCK}/__fail?on=1`);
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('Offline Paper');
    await page.getByTestId('create-project').click();

    // Creation still succeeds — the work is never blocked on GitLab.
    await expect(page).toHaveURL(/\/p\//);
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
    await expect(page.getByTestId('remote-pending')).toBeVisible();

    await request.post(`${MOCK}/__fail?on=0`);
    await page.getByTestId('remote-pending-retry').click();
    await expect(page.getByTestId('remote-pending')).toHaveCount(0);
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
  });

  test('trashing a project deletes it from GitLab; restore puts it back', async ({ page, request }) => {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('Trash Me');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
    const id = new URL(page.url()).pathname.split('/p/')[1];

    await page.goto('/');
    page.on('dialog', (d) => d.accept());
    await page.getByTestId(`project-card-${id}`).locator('.project-card__del').click();
    await expect(page.getByTestId(`project-card-${id}`)).not.toBeVisible();

    let deleted = await (await request.get(`${MOCK}/__deleted`)).json();
    expect(deleted).toContain('research/latex/trash-me');
    // Really gone, not just marked: GitLab keeps a deleted project for its
    // retention period, so a delete that stops at the first call leaves the
    // repo sitting in the group under a -deleted-<id> path.
    const remaining = await (await request.get(`${MOCK}/api/v4/projects`)).json();
    expect(remaining.filter((x: any) => x.path_with_namespace.startsWith('research/latex/trash-me'))).toEqual([]);

    // Aldine's own trash still holds it, and restoring re-creates the mirror
    // from the local repo, which survives the trash intact.
    await page.getByTestId('open-trash').click();
    await page.getByTestId(`restore-${id}`).click();
    await page.goto(`/p/${id}`);
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
  });

  test('a ZIP import is uploaded to GitLab too', async ({ page, request }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-provzip-'));
    fs.writeFileSync(path.join(tmp, 'main.tex'), '\\documentclass{article}\\begin{document}ZIP-TO-GITLAB\\end{document}');
    const zip = path.join(tmp, 'zipped-import.zip');
    execSync(`cd ${tmp} && zip -q -r ${zip} main.tex`);

    await page.goto('/');
    await page.getByTestId('import-input').setInputFiles(zip);
    await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.cm-content')).toContainText('ZIP-TO-GITLAB');
    // Linked on import, exactly like a new project.
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
    await expect(page.getByTestId('gitlab-sync')).toHaveAttribute('title', /research\/latex\/.*zipped-import/);

    const projects = await (await request.get(`${MOCK}/api/v4/projects`)).json();
    expect(projects.map((p: { path_with_namespace: string }) => p.path_with_namespace))
      .toContain('research/latex/zipped-import');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a GitLab group of template repos populates the New project dialog', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    const tile = page.getByTestId('template-gitlab:research/latex/templates/poster');
    // The tile's label and icon come from the template repo's template.json,
    // which is fetched from GitLab rather than read off disk.
    await expect(tile).toBeVisible();
    await expect(tile).toContainText('Conference poster');
    await expect(tile).toContainText('From GitLab');

    await page.getByTestId('new-project-name').fill('Big Poster');
    await tile.click();
    await page.getByTestId('create-project').click();

    await expect(page.getByTestId('editor-shell')).toBeVisible();
    // Cloned from the template, with the placeholder filled in. (That
    // template.json is excluded is asserted in gitlab-templates.integration:
    // the tree's source-only default would hide it either way.)
    await expect(page.locator('.cm-content')).toContainText('POSTER TEMPLATE for Big Poster', { timeout: 20_000 });
    // A template is a starting point, not a parent: the new project's own
    // GitLab home is its mirror, never the template repo.
    await expect(page.getByTestId('gitlab-sync')).toHaveAttribute('title', /research\/latex\/big-poster/);
  });

  test('auto-sync is on by default for a provisioned project', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('Autosync Paper');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('gitlab-auto')).toHaveClass(/gh-sync__auto--on/);
  });
});
