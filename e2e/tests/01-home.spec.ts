import { test, expect } from '../fixtures';
import { moreAction, projectAction, trashAction } from './helpers';

test.describe('home', () => {
  test('create a project from the home screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('img', { name: 'Aldine' })).toBeVisible();
    await expect(page).toHaveTitle('Projects – Aldine');
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('My First Paper');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('project-name')).toContainText('My First Paper');
    await expect(page).toHaveTitle('My First Paper – Aldine');
    // seeded files are present
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
    await expect(page.getByTestId('file-references.bib')).toBeVisible();
    // and it shows up back home
    await page.goto('/');
    await expect(page.getByTestId('project-grid')).toContainText('My First Paper');
  });

  test('move to trash; Undo, restore and delete forever work', async ({ page, request }) => {
    const res = await request.post('/api/projects', { data: { name: 'Doomed Project' } });
    const { id } = await res.json();
    await page.goto('/');
    const card = page.getByTestId(`project-card-${id}`);
    await expect(card).toBeVisible();
    // no question for the trash: it is undoable, and the notification says how
    await projectAction(page, id, 'menu-trash');
    await expect(card).toHaveCount(0);
    await page.getByTestId('undo-trash').click();
    await expect(card).toBeVisible();
    await projectAction(page, id, 'menu-trash');
    await expect(card).toHaveCount(0);
    // the trash is a place: restore brings the project back
    await page.getByTestId('open-trash').click();
    await expect(page).toHaveURL(/\?show=trash$/);
    await expect(page.getByTestId(`trash-${id}`)).toContainText(/Deleted today · gone \w{3} \d{1,2}/);
    await trashAction(page, id, `restore-${id}`);
    await expect(page.getByTestId(`trash-${id}`)).toHaveCount(0);
    await page.getByTestId('filter-all').click();
    await expect(page.getByTestId(`project-card-${id}`)).toBeVisible();
    // trash again, then delete forever, which is the one that asks
    await projectAction(page, id, 'menu-trash');
    await page.getByTestId('open-trash').click();
    await trashAction(page, id, `purge-${id}`);
    await expect(page.getByTestId('dialog-message')).toContainText('cannot be undone');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId(`trash-${id}`)).toHaveCount(0);
  });
});

test.describe('first visit', () => {
  test('an empty list offers starting points in place of a welcome dialog', async ({ page }) => {
    await page.route(/\/api\/projects$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
    await page.goto('/');
    const start = page.getByTestId('projects-empty');
    await expect(start).toBeVisible();
    await expect(start.getByRole('heading', { name: 'Start your first project' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('start-blank')).toBeVisible();
    await expect(page.getByTestId('start-more')).toBeVisible();
    // the hosts the server offers, as a line of links
    await expect(page.getByTestId('empty-import-zip')).toHaveText('Import a ZIP from Overleaf');
    await expect(page.getByTestId('empty-clone-github')).toBeVisible();
    // a template's sheet opens New project with that template chosen, ready for Enter
    await page.getByTestId('start-article').click();
    await expect(page.getByTestId('new-project-name')).toBeFocused();
    await expect(page.getByTestId('template-article')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await page.getByTestId('start-beamer').click();
    await expect(page.getByTestId('template-beamer')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    // nothing is stored to remember a welcome by
    expect(await page.evaluate(() => localStorage.getItem('aldine.onboarded'))).toBeNull();
  });
});

test.describe('source offer', () => {
  // AGPL section 13: an instance reachable over a network has to offer its
  // users the corresponding source. If this test goes red, every public
  // deployment is out of compliance, not just the UI.
  test('the home screen links to the source and the license', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('colophon-source')).toHaveAttribute('href', 'https://github.com/trahloff/Aldine');
    await expect(page.getByTestId('colophon')).toContainText('AGPL-3.0');
    await moreAction(page, 'open-about');
    const about = page.getByTestId('about-modal');
    await expect(about).toBeVisible();
    await expect(about).toContainText('Affero General Public License');
    await expect(about.getByTestId('about-source')).toHaveAttribute(
      'href',
      'https://github.com/trahloff/Aldine',
    );
  });
});
