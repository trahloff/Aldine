import { test, expect } from '../fixtures';

/**
 * @mentions and assignment on review comments: a collaborator types @ in the
 * composer, picks the owner from the project's people, and assigns the
 * thread to her. The owner finds it under For you on Home, which opens the
 * project at the thread, and under For me in the Review panel.
 */
const uniq = (tag: string) => `${tag}${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;

async function signUp(browser: import('@playwright/test').Browser, name: string, ip: string) {
  // its own client address keeps it off the sign-in limit the suite shares
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
  const page = await ctx.newPage();
  const email = uniq(name.split(' ')[0].toLowerCase());
  expect((await page.request.post('/api/auth/register', { data: { email, password: 'password123', name } })).ok()).toBeTruthy();
  // a share entry names an account once its address is confirmed (ALDINE_TEST_HOOKS hands over the link)
  const { link } = await (await page.request.get(`/api/test/confirmation-link?email=${encodeURIComponent(email)}`)).json();
  const token = new URL(link, 'http://x').searchParams.get('confirm_email');
  expect((await page.request.post('/api/auth/confirm-email', { data: { token } })).ok()).toBeTruthy();
  return { ctx, page, email };
}

test('mention someone with @, assign them the thread, and they find it under For you', async ({ browser }) => {
  const ada = await signUp(browser, 'Ada Lovelace', '203.0.113.71');
  const bea = await signUp(browser, 'Bea Reviewer', '203.0.113.72');
  const proj = await (await ada.page.request.post('/api/projects', { data: { name: 'Mention Paper', files: { 'main.tex': 'PLACEHOLDER needs a source.\n' } } })).json();
  try {
    expect((await ada.page.request.post(`/api/projects/${proj.id}/share`, { data: { mode: 'private', collaborators: [bea.email] } })).ok()).toBeTruthy();
    // sharing invites; Bea accepts (Home's Invitations strip does the same)
    const invites = await (await bea.page.request.get('/api/invitations')).json();
    const invite = invites.find((i: { project: { id: string } }) => i.project.id === proj.id);
    expect(invite).toBeTruthy();
    expect((await bea.page.request.post(`/api/invitations/${invite.id}/accept`)).ok()).toBeTruthy();

    // ---- Bea comments and mentions Ada ----
    const page = bea.page;
    await page.goto(`/p/${proj.id}`);
    await expect(page.locator('.cm-content')).toContainText('PLACEHOLDER', { timeout: 15_000 });
    const line = await page.locator('.cm-line').first().boundingBox();
    await page.mouse.dblclick(line!.x + 30, line!.y + line!.height / 2);
    await expect.poll(async () => await page.evaluate(() => window.getSelection()?.toString())).toBe('PLACEHOLDER');
    await page.getByTestId('add-comment').click();
    const body = page.getByTestId('comment-body');
    await body.pressSequentially('Can you cite this, @lov');
    const menu = page.getByTestId('mention-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('mention-option')).toHaveText(['Ada Lovelace']);
    await body.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(body).toHaveValue('Can you cite this, @Ada Lovelace ');
    await body.pressSequentially('?');
    // Escape closes the menu and leaves the composer open
    await body.pressSequentially(' @');
    await expect(menu).toBeVisible();
    await body.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('comment-composer')).toBeVisible();
    await body.press('Backspace');
    await body.press('Backspace');
    await page.getByTestId('comment-submit').click();

    const panel = page.getByTestId('review-panel');
    await expect(panel.getByTestId('mention')).toHaveText('@Ada Lovelace', { timeout: 10_000 });
    const [thread] = await (await page.request.get(`/api/projects/${proj.id}/comments?branch=main`)).json();
    const me = (await (await ada.page.request.get('/api/auth/me')).json()).user;
    expect(thread.mentions).toEqual([me.id]);

    // ---- and assigns it to her ----
    await panel.getByTestId(`assign-${thread.id}`).selectOption({ label: 'Ada Lovelace' });
    await expect.poll(async () => (await (await page.request.get(`/api/projects/${proj.id}/comments?branch=main`)).json())[0].assignee?.id).toBe(me.id);
    await expect(panel.getByTestId('review-filter-mine')).toHaveText('For me');

    // ---- Ada finds it on Home and opens it there ----
    await ada.page.goto('/');
    const forYou = ada.page.getByTestId('home-for-you');
    await expect(forYou).toBeVisible({ timeout: 15_000 });
    await expect(forYou.getByTestId('home-for-you-item')).toContainText(['Assigned to you in Mention Paper']);
    await forYou.getByTestId('home-for-you-item').first().getByRole('link').click();
    await expect(ada.page).toHaveURL(new RegExp(`/p/${proj.id}$`));
    const adaPanel = ada.page.getByTestId('review-panel');
    await expect(adaPanel).toBeVisible({ timeout: 15_000 });
    await expect(adaPanel.getByTestId(`comment-${thread.id}`)).toHaveAttribute('aria-current', 'true');
    await expect(adaPanel.getByTestId('review-filter-mine')).toHaveText('For me (1)');
    await adaPanel.getByTestId('review-filter-mine').click();
    await expect(adaPanel.locator('[data-comment-card]')).toHaveCount(1);

    // ---- a reply mention ----
    const reply = adaPanel.getByTestId(`reply-${thread.id}`);
    await reply.pressSequentially('Done, thanks @Bea');
    await expect(ada.page.getByTestId('mention-menu').getByTestId('mention-option')).toHaveText(['Bea Reviewer']);
    await reply.press('Tab');
    await reply.press('Enter');
    await expect(adaPanel.locator('.review__reply .mention')).toHaveText('@Bea Reviewer', { timeout: 10_000 });

    // resolved, it no longer waits on anyone
    await adaPanel.getByTestId(`resolve-${thread.id}`).click();
    await expect.poll(async () => (await (await ada.page.request.get('/api/for-me')).json()).length).toBe(0);
  } finally {
    await ada.page.request.delete(`/api/projects/${proj.id}?permanent=1`);
    await ada.ctx.close();
    await bea.ctx.close();
  }
});
