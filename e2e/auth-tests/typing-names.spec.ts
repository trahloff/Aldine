import { test, expect } from '../fixtures';

/**
 * Names for typing: two signed-in people type into one file, and the
 * autosave that takes their typing names both of them. History shows the
 * names on the row; the log answer carries names, never addresses.
 */
const uniq = (tag: string) => `${tag}${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;

async function signUp(browser: import('@playwright/test').Browser, name: string, ip: string) {
  // its own client address keeps it off the sign-in limit the suite shares
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
  const page = await ctx.newPage();
  const email = uniq(name.split(' ')[0].toLowerCase());
  expect((await page.request.post('/api/auth/register', { data: { email, password: 'password123', name } })).ok()).toBeTruthy();
  const { link } = await (await page.request.get(`/api/test/confirmation-link?email=${encodeURIComponent(email)}`)).json();
  const token = new URL(link, 'http://x').searchParams.get('confirm_email');
  expect((await page.request.post('/api/auth/confirm-email', { data: { token } })).ok()).toBeTruthy();
  return { ctx, page, email };
}

test('an autosave names everyone who typed in it, and History shows them', async ({ browser }) => {
  test.setTimeout(120_000);
  const ada = await signUp(browser, 'Ada Typist', '203.0.113.81');
  const ben = await signUp(browser, 'Ben Typist', '203.0.113.82');
  const proj = await (await ada.page.request.post('/api/projects', { data: { name: 'Typing Names Paper', files: { 'main.tex': 'First line.\n\nSecond line.\n' } } })).json();
  try {
    expect((await ada.page.request.patch('/api/auth/me', { data: { commitEmail: 'ada.typist@example.org' } })).ok()).toBeTruthy();
    expect((await ada.page.request.post(`/api/projects/${proj.id}/share`, { data: { mode: 'private', collaborators: [ben.email] } })).ok()).toBeTruthy();
    const invites = await (await ben.page.request.get('/api/invitations')).json();
    const invite = invites.find((i: { project: { id: string } }) => i.project.id === proj.id);
    expect((await ben.page.request.post(`/api/invitations/${invite.id}/accept`)).ok()).toBeTruthy();

    for (const p of [ada.page, ben.page]) {
      await p.goto(`/p/${proj.id}`);
      await expect(p.locator('.cm-content')).toContainText('Second line.', { timeout: 15_000 });
    }
    const typeAtEnd = async (p: import('@playwright/test').Page, lineIndex: number, text: string) => {
      await p.locator('.cm-line').nth(lineIndex).click();
      await p.keyboard.press('End');
      await p.keyboard.type(text);
    };
    await typeAtEnd(ada.page, 0, ' Ada wrote this.');
    await expect(ben.page.locator('.cm-content')).toContainText('Ada wrote this.');
    await typeAtEnd(ben.page, 2, ' Ben wrote this.');
    await expect(ada.page.locator('.cm-content')).toContainText('Ben wrote this.');

    // the autosave lands after the edits settle (ALDINE_AUTOCOMMIT_MS, 20 s by default)
    type Entry = { message: string; author: string; coAuthors?: string[] };
    let saved: Entry | undefined;
    await expect.poll(async () => {
      const log: Entry[] = await (await ada.page.request.get(`/api/projects/${proj.id}/log?branch=main`)).json();
      saved = log.find((e) => e.message === 'aldine: autosave');
      return saved ? [saved.author, ...(saved.coAuthors ?? [])].sort() : null;
    }, { timeout: 60_000, intervals: [1000] }).toEqual(['Ada Typist', 'Ben Typist']);
    const raw = await (await ada.page.request.get(`/api/projects/${proj.id}/log?branch=main`)).text();
    expect(raw).not.toContain('ada.typist@example.org');

    await ada.page.getByTestId('tab-history').click();
    const people = ada.page.getByTestId('history-panel').getByTestId('history-people').first();
    await expect(people).toHaveText(/^(Ada Typist and Ben Typist|Ben Typist and Ada Typist)$/, { timeout: 15_000 });
    await expect(people).toHaveAttribute('title', /Everyone who typed in this save/);
  } finally {
    await ada.page.request.delete(`/api/projects/${proj.id}?permanent=1`);
    await ada.ctx.close();
    await ben.ctx.close();
  }
});
