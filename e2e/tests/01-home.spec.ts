import { test, expect } from '../fixtures';

test.describe('home', () => {
  test('create a project from the home screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.home__brand')).toContainText('aldine');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('My First Paper');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('project-name')).toContainText('My First Paper');
    // seeded files are present
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
    await expect(page.getByTestId('file-references.bib')).toBeVisible();
    // and it shows up back home
    await page.goto('/');
    await expect(page.getByTestId('project-grid')).toContainText('My First Paper');
  });

  test('delete moves to trash; restore and delete-forever work', async ({ page, request }) => {
    const res = await request.post('/api/projects', { data: { name: 'Doomed Project' } });
    const { id } = await res.json();
    await page.goto('/');
    const card = page.getByTestId(`project-card-${id}`);
    await expect(card).toBeVisible();
    page.on('dialog', (d) => d.accept());
    await card.locator('.project-card__del').click();
    await expect(card).not.toBeVisible();
    // trashed → API hides it, trash lists it, restore brings it back
    await page.getByTestId('open-trash').click();
    await page.getByTestId(`restore-${id}`).click();
    await page.keyboard.press('Escape'); // close the trash modal
    await expect(page.getByTestId(`project-card-${id}`)).toBeVisible();
    // delete again, then delete forever from the trash
    await page.getByTestId(`project-card-${id}`).locator('.project-card__del').click();
    await page.getByTestId('open-trash').click();
    await page.getByTestId(`purge-${id}`).click();
    await expect(page.getByTestId(`trash-${id}`)).toHaveCount(0);
  });
});

test.describe('first-run onboarding', () => {
  test('shows on first visit and stays dismissed after', async ({ browser }) => {
    const ctx = await browser.newContext(); // raw context → no pre-dismiss, fresh localStorage
    const p = await ctx.newPage();
    try {
      await p.goto('/');
      await expect(p.getByTestId('onboarding')).toBeVisible({ timeout: 10_000 });
      await p.getByTestId('onboard-dismiss').click();
      await expect(p.getByTestId('onboarding')).toHaveCount(0);
      await p.reload();
      await expect(p.getByTestId('onboarding')).toHaveCount(0);
    } finally { await ctx.close(); }
  });
});

test.describe('source offer', () => {
  // AGPL section 13: an instance reachable over a network has to offer its
  // users the corresponding source. If this test goes red, every public
  // deployment is out of compliance, not just the UI.
  test('the home screen links to the source and the license', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('open-about').click();
    const about = page.getByTestId('about-modal');
    await expect(about).toBeVisible();
    await expect(about).toContainText('Affero General Public License');
    await expect(about.getByTestId('about-source')).toHaveAttribute(
      'href',
      'https://github.com/trahloff/Aldine',
    );
  });
});
