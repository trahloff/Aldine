import { test, expect } from '../fixtures';
import AxeBuilder from '@axe-core/playwright';

/** Unique email per run so re-runs don't collide with the persisted user store. */
const uniq = () => `u${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;

/** The confirmation link the server logged for `email` (ALDINE_TEST_HOOKS). */
async function confirmationLink(request: import('@playwright/test').APIRequestContext, email: string): Promise<string> {
  const r = await request.get(`/api/test/confirmation-link?email=${encodeURIComponent(email)}`);
  expect(r.ok(), 'the server logged a confirmation link').toBeTruthy();
  return (await r.json()).link;
}
/** Confirm the address of the account `request` is signed in to, as following the link would. */
async function confirmEmail(request: import('@playwright/test').APIRequestContext, email: string) {
  const token = new URL(await confirmationLink(request, email), 'http://x').searchParams.get('confirm_email');
  const r = await request.post('/api/auth/confirm-email', { data: { token } });
  expect(r.ok(), `confirming ${email}`).toBeTruthy();
}

async function register(page: import('@playwright/test').Page, email: string, password = 'password123', name = 'Tester') {
  await page.goto('/');
  await expect(page.getByTestId('auth-email')).toBeVisible();
  await page.getByTestId('auth-switch').click(); // to register mode
  await page.getByTestId('auth-name').fill(name);
  await page.getByTestId('auth-email').fill(email);
  await page.getByTestId('auth-password').fill(password);
  await page.getByTestId('auth-submit').click();
  // wait for a signed-in-only control — NOT .home__brand, which also renders on
  // the login screen (so it wouldn't confirm the session actually established).
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
}

test.describe('auth', () => {
  test('gate blocks unauthenticated access and shows login', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('auth-email')).toBeVisible();
    await expect(page.getByTestId('auth-submit')).toBeVisible();
  });

  test('register, create a project, sign out, sign back in — project persists', async ({ page }) => {
    const email = uniq();
    await register(page, email);
    // signed in — create a project
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('My Private Paper');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('code-pane')).toBeVisible();

    // back home, sign out
    await page.goto('/');
    await expect(page.getByTestId('account-menu')).toBeVisible();
    // the avatar is a circle, not squeezed by the button around it
    const face = (await page.locator('.home-avatar__face').boundingBox())!;
    expect(Math.abs(face.width - face.height)).toBeLessThan(0.5);
    await page.getByTestId('account-menu').click();
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('auth-email')).toBeVisible();

    // sign back in — project is still there
    await page.getByTestId('auth-email').fill(email);
    await page.getByTestId('auth-password').fill('password123');
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('project-grid')).toContainText('My Private Paper', { timeout: 15_000 });
  });

  test('sign-in is a labelled form a password manager can fill', async ({ page }) => {
    const email = uniq();
    await register(page, email);
    await page.goto('/');
    await page.getByTestId('account-menu').click();
    await page.getByTestId('logout').click();
    await expect(page).toHaveTitle('Sign in – Aldine');
    await expect(page.getByRole('main')).toBeVisible();
    const emailField = page.getByLabel('Email');
    const password = page.getByLabel('Password');
    await expect(emailField).toHaveAttribute('autocomplete', 'username');
    await expect(emailField).toHaveAttribute('type', 'email');
    await expect(password).toHaveAttribute('autocomplete', 'current-password');
    await expect(password).toHaveAttribute('type', 'password');

    await emailField.fill(email);
    await password.fill('wrongpassword');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/api/auth/login', async (route) => { await held; await route.continue(); });
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('auth-submit')).toHaveText('Signing in…');
    await expect(page.getByTestId('auth-submit')).toBeDisabled();
    release();
    await expect(page.getByRole('alert')).toContainText(/incorrect/i);
    await expect(page.getByTestId('auth-submit')).toHaveText('Sign in');
  });

  test('wrong password is rejected', async ({ page }) => {
    const email = uniq();
    await register(page, email);
    await page.goto('/');
    await page.getByTestId('account-menu').click();
    await page.getByTestId('logout').click();
    await page.getByTestId('auth-email').fill(email);
    await page.getByTestId('auth-password').fill('wrongpassword');
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('auth-error')).toContainText(/incorrect/i);
  });

  test('a second user cannot access a private project but can after it is shared', async ({ browser, request }) => {
    // Alice (API) creates a project
    const alice = await browser.newContext();
    const aEmail = uniq();
    const reg = await alice.request.post('/api/auth/register', { data: { email: aEmail, password: 'password123', name: 'Alice' } });
    expect(reg.ok()).toBeTruthy();
    const proj = await (await alice.request.post('/api/projects', { data: { name: 'Alice Secret' } })).json();

    // Bob cannot open it
    const bob = await browser.newContext();
    const bEmail = uniq();
    await bob.request.post('/api/auth/register', { data: { email: bEmail, password: 'password123' } });
    const denied = await bob.request.get(`/api/projects/${proj.id}`);
    expect(denied.status()).toBe(403);

    // Alice shares with Bob
    const shared = await alice.request.post(`/api/projects/${proj.id}/share`, { data: { mode: 'private', collaborators: [bEmail] } });
    expect(shared.ok()).toBeTruthy();

    // …which applies once Bob has confirmed the address
    expect((await bob.request.get(`/api/projects/${proj.id}`)).status()).toBe(403);
    await confirmEmail(bob.request, bEmail);

    // Bob can now open it and it shows in his list
    const allowed = await bob.request.get(`/api/projects/${proj.id}`);
    expect(allowed.ok()).toBeTruthy();
    const bobList = await (await bob.request.get('/api/projects')).json();
    expect(bobList.some((p: { id: string }) => p.id === proj.id)).toBeTruthy();

    // Bob cannot delete (owner-only)
    const del = await bob.request.delete(`/api/projects/${proj.id}`);
    expect(del.status()).toBe(403);

    await alice.close();
    await bob.close();
  });

  test('link sharing grants access by URL and lists the project only for those who open it, until they remove it', async ({ browser }) => {
    const alice = await browser.newContext();
    await alice.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123', name: 'Alice' } });
    const proj = await (await alice.request.post('/api/projects', { data: { name: 'Linked Paper' } })).json();
    const dEmail = uniq();
    const shared = await alice.request.post(`/api/projects/${proj.id}/share`, { data: { mode: 'link', collaborators: [dEmail] } });
    expect(shared.ok()).toBeTruthy();

    const carol = await browser.newContext();
    const carolReg = await carol.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    expect(carolReg.ok()).toBeTruthy();
    // direct URL works…
    const opened = await carol.request.get(`/api/projects/${proj.id}`);
    expect(opened.ok()).toBeTruthy();
    // …but reading it does not put it on Carol's list
    const listRes = await carol.request.get('/api/projects');
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    expect(Array.isArray(list)).toBeTruthy();
    expect(list.some((p: { id: string }) => p.id === proj.id)).toBeFalsy();
    // opening it in the editor does, through the link, until she removes it
    const carolPage = await carol.newPage();
    await carolPage.goto(`/p/${proj.id}`);
    const listedRow = async () => (await (await carol.request.get('/api/projects')).json()).find((p: { id: string }) => p.id === proj.id);
    await expect.poll(async () => (await listedRow())?.access).toBe('link');
    await carolPage.close();
    const listed = await listedRow();
    expect(listed?.opened?.branch).toBe('main');
    expect((await carol.request.delete(`/api/projects/${proj.id}/listing`)).ok()).toBeTruthy();
    expect((await (await carol.request.get('/api/projects')).json()).some((p: { id: string }) => p.id === proj.id)).toBeFalsy();
    expect((await carol.request.get(`/api/projects/${proj.id}`)).ok()).toBeTruthy();

    // Positive controls — "not listed" must not be passing because nothing is
    // listed: the owner still sees it, and so does a collaborator invited by
    // email even though the mode is 'link'.
    const aliceList = await (await alice.request.get('/api/projects')).json();
    expect(aliceList.some((p: { id: string }) => p.id === proj.id)).toBeTruthy();

    const dana = await browser.newContext();
    await dana.request.post('/api/auth/register', { data: { email: dEmail, password: 'password123' } });
    await confirmEmail(dana.request, dEmail);
    const danaList = await (await dana.request.get('/api/projects')).json();
    expect(danaList.some((p: { id: string }) => p.id === proj.id)).toBeTruthy();

    await alice.close();
    await carol.close();
    await dana.close();
  });

  test('a file preview is served to people who can open the project and to nobody else', async ({ browser }) => {
    const alice = await browser.newContext();
    await alice.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123', name: 'Alice' } });
    const proj = await (await alice.request.post('/api/projects', { data: { name: 'Figures' } })).json();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    expect((await alice.request.put(`/api/projects/${proj.id}/file`, { data: { branch: 'main', path: 'fig.svg', content: svg } })).ok()).toBeTruthy();
    const url = `/api/projects/${proj.id}/file?branch=main&path=fig.svg`;
    const own = await alice.request.get(url);
    expect(own.status()).toBe(200);
    expect(own.headers()['content-type']).toBe('image/svg+xml');

    const bob = await browser.newContext();
    await bob.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    expect((await bob.request.get(url)).status()).toBe(403);
    const anon = await browser.newContext();
    expect((await anon.request.get(url)).status()).toBe(401);

    // a link lets a signed-in visitor in, and the editor previews the file
    expect((await alice.request.post(`/api/projects/${proj.id}/share`, { data: { mode: 'link', collaborators: [] } })).ok()).toBeTruthy();
    expect((await bob.request.get(url)).status()).toBe(200);
    expect((await anon.request.get(url)).status()).toBe(401);
    const bobPage = await bob.newPage();
    await bobPage.goto(`/p/${proj.id}`);
    await bobPage.getByTestId('file-fig.svg').click();
    await expect(bobPage.getByTestId('preview-dimensions')).toHaveText('10 × 10 px');

    await alice.close();
    await bob.close();
    await anon.close();
  });

  test('a link visitor gets the document, not the project: no roster, no rename, no Zotero, no remote', async ({ browser }) => {
    const alice = await browser.newContext();
    await alice.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123', name: 'Alice' } });
    const proj = await (await alice.request.post('/api/projects', { data: { name: 'Link Limits' } })).json();
    const invitee = uniq();
    await alice.request.post(`/api/projects/${proj.id}/share`, { data: { mode: 'link', collaborators: [invitee] } });

    const carol = await browser.newContext();
    await carol.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });

    // opens the project, but the owner's invite list is not disclosed
    const detail = await (await carol.request.get(`/api/projects/${proj.id}`)).json();
    expect(detail.share.mode).toBe('link');
    expect(detail.share.collaborators).toEqual([]);
    expect(detail.isOwner).toBeFalsy();
    expect(detail.isMember).toBeFalsy();
    // …while the owner still sees who she invited
    const own = await (await alice.request.get(`/api/projects/${proj.id}`)).json();
    expect(own.share.collaborators).toEqual([invitee]);

    // and cannot reconfigure the project or reach the owner's linked accounts
    expect((await carol.request.patch(`/api/projects/${proj.id}`, { data: { name: 'Renamed by a stranger' } })).status()).toBe(403);
    expect((await carol.request.get(`/api/projects/${proj.id}/zotero/search?q=a`)).status()).toBe(403);
    expect((await carol.request.delete(`/api/projects/${proj.id}/zotero`)).status()).toBe(403);
    expect((await carol.request.post(`/api/projects/${proj.id}/github/reset-to-remote`)).status()).toBe(403);
    expect((await carol.request.post(`/api/projects/${proj.id}/remote/reset-to-remote`)).status()).toBe(403);
    // the name is untouched
    expect((await (await alice.request.get(`/api/projects/${proj.id}`)).json()).name).toBe('Link Limits');

    await alice.close();
    await carol.close();
  });

  test('share from the editor toolbar: owner-only access, link mode, copyable link', async ({ page, browser }) => {
    const email = uniq();
    await register(page, email);
    const proj = await (await page.request.post('/api/projects', { data: { name: 'Toolbar Share' } })).json();
    await page.goto(`/p/${proj.id}`);
    await expect(page.getByTestId('editor-shell')).toBeVisible();

    // the owner sees Share; the dialog opens with the current (private) mode
    await page.getByTestId('share-project').click();
    await expect(page.getByTestId('share-modal')).toBeVisible();
    await expect(page.getByTestId('share-private')).toBeChecked();

    // switching to link mode reveals the URL to send
    await page.getByTestId('share-link').check();
    await expect(page.getByTestId('share-url')).toContainText(`/p/${proj.id}`);
    await page.getByTestId('share-emails').fill('not-an-email');
    await page.getByTestId('share-save').click();
    await expect(page.getByTestId('share-modal')).toBeVisible(); // refused, still open

    // this server sends no email, so the dialog says to pass it on by hand
    const invitee = uniq();
    await page.getByTestId('share-emails').fill(`${invitee}, 0000-0002-1825-0097`);
    await page.getByTestId('share-save').click();
    await expect(page.getByTestId('share-invite-manual')).toContainText(invitee);
    await expect(page.getByTestId('share-invite-manual')).toContainText("Tell them yourself: they'll see the project after signing in with this address.");
    await expect(page.getByTestId('share-invite-manual')).not.toContainText('0000-0002-1825-0097');
    await expect(page.getByTestId('share-invite-sent')).toHaveCount(0);
    await page.getByTestId('share-done').click();
    await expect(page.getByTestId('share-modal')).toHaveCount(0);
    // saving the same list again adds nobody, so the dialog just closes
    await page.getByTestId('share-project').click();
    await page.getByTestId('share-save').click();
    await expect(page.getByTestId('share-modal')).toHaveCount(0);
    const after = await (await page.request.get(`/api/projects/${proj.id}`)).json();
    expect(after.share.mode).toBe('link');

    // a link visitor opens the same project: Share holds only the downloads
    const carol = await browser.newContext();
    await carol.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    const carolPage = await carol.newPage();
    await carolPage.goto(`/p/${proj.id}`);
    await expect(carolPage.getByTestId('editor-shell')).toBeVisible();
    await carolPage.getByTestId('share-project').click();
    await expect(carolPage.getByTestId('share-downloads')).toBeVisible();
    await expect(carolPage.getByTestId('share-private')).toHaveCount(0);
    await expect(carolPage.getByTestId('share-save')).toHaveCount(0);
    await carolPage.getByTestId('share-close').click();
    await carolPage.getByTestId('branch-menu').click();
    await expect(carolPage.getByTestId('branch-list')).toBeVisible();
    await expect(carolPage.getByTestId('remote-publish-open')).toHaveCount(0);
    await carol.close();
  });

  test('collaborators see each other under their account names, not the anonymous writer', async ({ page, browser }) => {
    const email = uniq();
    await register(page, email, 'password123', 'Ada Presence');
    const proj = await (await page.request.post('/api/projects', { data: { name: 'Presence Names' } })).json();
    await page.request.post(`/api/projects/${proj.id}/share`, { data: { mode: 'link', collaborators: [] } });
    await page.goto(`/p/${proj.id}`);
    await expect(page.locator('.cm-content')).toBeVisible();

    const carol = await browser.newContext();
    await carol.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123', name: 'Carol Visitor' } });
    const carolPage = await carol.newPage();
    await carolPage.goto(`/p/${proj.id}`);
    await expect(carolPage.locator('.cm-content')).toBeVisible();

    // awareness carries the account, so History's author and the avatar agree
    await expect(carolPage.getByTestId('presence')).toHaveAttribute('title', /Ada Presence/, { timeout: 15_000 });
    await expect(page.getByTestId('presence')).toHaveAttribute('title', /Carol Visitor/, { timeout: 15_000 });
    await expect(page.getByTestId('presence')).not.toHaveAttribute('title', /Writer \d+/);
    await carol.close();
  });

  test('percent-encoded project id cannot bypass the access guard (C1)', async ({ browser }) => {
    const alice = await browser.newContext();
    await alice.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    const proj = await (await alice.request.post('/api/projects', { data: { name: 'Alice C1' } })).json();

    const bob = await browser.newContext();
    await bob.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    // encode the first character of the id — the old raw-URL regex would skip the guard
    const enc = '%' + proj.id.charCodeAt(0).toString(16) + proj.id.slice(1);
    const res = await bob.request.get(`/api/projects/${enc}`);
    expect(res.status()).toBe(403);
    await alice.close();
    await bob.close();
  });

  test('imported projects are owned (not world-accessible) (H1)', async ({ browser }) => {
    const alice = await browser.newContext();
    await alice.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    // minimal zip built inline
    const { execSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-imp-'));
    fs.writeFileSync(path.join(tmp, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}');
    execSync(`cd ${tmp} && zip -q -r p.zip main.tex`);
    const b64 = fs.readFileSync(path.join(tmp, 'p.zip')).toString('base64');
    const proj = await (await alice.request.post('/api/projects/import', { data: { name: 'Imported', zipBase64: b64 } })).json();
    fs.rmSync(tmp, { recursive: true, force: true });

    const bob = await browser.newContext();
    await bob.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    expect((await bob.request.get(`/api/projects/${proj.id}`)).status()).toBe(403);
    expect((await bob.request.delete(`/api/projects/${proj.id}`)).status()).toBe(403);
    await alice.close();
    await bob.close();
  });

  test('project id path traversal is rejected in comments (H2)', async ({ browser }) => {
    const alice = await browser.newContext();
    await alice.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    // traversal id targeting the users store — must not read/write outside the comments dir
    const res = await alice.request.get('/api/projects/..%2f..%2fusers/comments');
    expect([400, 403, 404].includes(res.status())).toBeTruthy();
    await alice.close();
  });
});

test.describe('abuse controls', () => {
  test('login is rate-limited after repeated failures', async ({ request }) => {
    const email = uniq();
    let got429 = false;
    // isolate this test's limiter bucket via a dedicated client IP (server runs with TRUST_PROXY=1)
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < 15; i++) {
      const res = await request.post('/api/auth/login', { headers, data: { email, password: 'definitely-wrong' } });
      if (res.status() === 429) { got429 = true; break; }
    }
    expect(got429).toBeTruthy();
  });
});

test.describe('email confirmation', () => {
  test('an invite by email applies once the invitee confirms the address', async ({ page, browser }) => {
    const alice = await browser.newContext();
    await alice.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123', name: 'Alice' } });
    const proj = await (await alice.request.post('/api/projects', { data: { name: 'Shared Before Signup' } })).json();
    const bEmail = uniq();
    expect((await alice.request.post(`/api/projects/${proj.id}/share`, { data: { mode: 'private', collaborators: [bEmail] } })).ok()).toBeTruthy();

    // whoever signs up with the address first sees nothing yet
    await register(page, bEmail, 'password123', 'Bob');
    const banner = page.getByTestId('email-confirm-banner');
    await expect(banner).toContainText('Confirm your email address to see projects shared with you.');
    await expect(banner).toContainText('ask its administrator'); // the e2e server mails nothing
    await expect(page.getByTestId('projects-empty')).toBeVisible();
    expect((await page.request.get(`/api/projects/${proj.id}`)).status()).toBe(403);

    // without email, asking again keeps the link the operator may have sent
    const first = await confirmationLink(page.request, bEmail);
    await page.getByTestId('email-confirm-resend').click();
    await expect(page.locator('.toast').filter({ hasText: 'a link they already sent still works' })).toBeVisible();
    const second = await confirmationLink(page.request, bEmail);
    expect(second).not.toBe(first);
    await page.goto(first.replace(/confirm_email=[^&]+/, 'confirm_email=not-a-link'));
    await expect(page.getByTestId('email-confirm-notice')).toContainText('expired, was replaced by a newer one');
    await expect(page).not.toHaveURL(/confirm_email/);
    await page.getByTestId('email-confirm-notice-close').click();
    await expect(banner).toBeVisible();

    await page.goto(first);
    await expect(page.getByTestId('email-confirm-notice')).toContainText('Your email address is confirmed.');
    await expect(page).not.toHaveURL(/confirm_email/);
    await expect(page.getByTestId('project-grid')).toContainText('Shared Before Signup');
    await expect(banner).toHaveCount(0);
    expect((await page.request.get(`/api/projects/${proj.id}`)).ok()).toBeTruthy();
    await alice.close();
  });

  test('a link opened while signed out asks to sign in, then confirms', async ({ browser }) => {
    const email = uniq();
    const signup = await browser.newContext();
    expect((await signup.request.post('/api/auth/register', { data: { email, password: 'password123' } })).ok()).toBeTruthy();
    const link = await confirmationLink(signup.request, email);
    await signup.close();

    const other = await browser.newContext();
    const page = await other.newPage();
    await page.goto(link);
    await expect(page.getByTestId('auth-info')).toHaveText('Sign in to confirm your email address.');
    await page.getByTestId('auth-email').fill(email);
    await page.getByTestId('auth-password').fill('password123');
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('email-confirm-notice')).toContainText('Your email address is confirmed.');
    await expect(page.getByTestId('email-confirm-banner')).toHaveCount(0);
    const me = await (await page.request.get('/api/auth/me')).json();
    expect(me.user.emailPending).toBeUndefined();
    await other.close();
  });

  test('a confirmed account that opens the link for another account is told how to use it', async ({ page, browser }) => {
    const pendingEmail = uniq();
    const signup = await browser.newContext();
    expect((await signup.request.post('/api/auth/register', { data: { email: pendingEmail, password: 'password123' } })).ok()).toBeTruthy();
    const link = await confirmationLink(signup.request, pendingEmail);

    const confirmedEmail = uniq();
    await register(page, confirmedEmail, 'password123', 'Bea');
    await page.goto(await confirmationLink(page.request, confirmedEmail));
    await expect(page.getByTestId('email-confirm-notice')).toContainText('Your email address is confirmed.');

    await page.goto(link);
    const notice = page.getByTestId('email-confirm-notice');
    await expect(notice).toContainText(`(${confirmedEmail}) is already confirmed`);
    await expect(notice).toContainText('If the link is for another account, sign out, open the link again and sign in to that account.');

    // the link was not spent: the account it was for still confirms with it
    const confirm = await signup.newPage();
    await confirm.goto(link);
    await expect(confirm.getByTestId('email-confirm-notice')).toContainText('Your email address is confirmed.');
    await signup.close();
  });
});

test.describe('per-account sign-in limit', () => {
  test('after five failures from anywhere the form waits, but the owner\'s browser goes in', async ({ browser }) => {
    const email = uniq();
    const owner = await browser.newContext();
    expect((await owner.request.post('/api/auth/register', { data: { email, password: 'password123', name: 'Owner' } })).ok()).toBeTruthy();
    expect((await owner.cookies()).some((c) => c.name === 'aldine_device')).toBe(false);
    // a sign-up proves nothing about the browser; a correct sign-in does
    await owner.request.post('/api/auth/logout');
    expect((await owner.request.post('/api/auth/login', { headers: { 'x-forwarded-for': '198.51.99.1' }, data: { email, password: 'password123' } })).ok()).toBeTruthy();
    await owner.request.post('/api/auth/logout');

    // five wrong passwords, each from its own address (TRUST_PROXY=1)
    const attacker = await browser.newContext();
    for (let i = 1; i <= 5; i++) {
      const r = await attacker.request.post('/api/auth/login', { headers: { 'x-forwarded-for': `198.51.100.${i}` }, data: { email, password: 'guess' } });
      expect(r.status()).toBe(401);
    }
    // The wait runs from the start of the previous try, so on a slow machine
    // the password check alone can outlast the first (1 s) wait; the doubled
    // ones cannot.
    const throttledTry = async (prefix: string, address: string) => {
      for (let i = 6; i <= 9; i++) {
        const r = await attacker.request.post('/api/auth/login', { headers: { 'x-forwarded-for': `${prefix}.${i}` }, data: { email: address, password: 'guess' } });
        if (r.status() !== 401) return r;
      }
      throw new Error(`no try at ${address} was throttled`);
    };
    const throttled = await throttledTry('198.51.100', email);
    expect(throttled.status()).toBe(429);
    expect(Number(throttled.headers()['retry-after'])).toBeGreaterThan(0);

    // an email nobody registered answers the same way
    const ghost = uniq();
    for (let i = 1; i <= 5; i++) await attacker.request.post('/api/auth/login', { headers: { 'x-forwarded-for': `198.51.101.${i}` }, data: { email: ghost, password: 'guess' } });
    const ghostThrottled = await throttledTry('198.51.101', ghost);
    expect(ghostThrottled.status()).toBe(429);
    expect((await ghostThrottled.json()).error).toMatch(/^Too many failed sign-ins to this account\. Try again in \d+ seconds?\.$/);

    // a new browser: the form says so and waits out Retry-After
    const fresh = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.10' } });
    const freshPage = await fresh.newPage();
    await freshPage.goto('/');
    await freshPage.getByTestId('auth-email').fill(email);
    await freshPage.getByTestId('auth-password').fill('guess');
    // A try after the wait ran out goes ahead (and doubles the next wait), so
    // the form may need a second one before it is throttled.
    const error = freshPage.getByTestId('auth-error');
    for (let i = 0; i < 4; i++) {
      await freshPage.getByTestId('auth-submit').click();
      await expect(error).toBeVisible();
      if ((await error.textContent())?.startsWith('Too many failed')) break;
    }
    await expect(error).toContainText('Too many failed sign-ins to this account. Try again in');
    await expect(freshPage.getByTestId('auth-submit')).toBeDisabled();
    await expect(freshPage.getByTestId('auth-submit')).toHaveText(/Try again in \d+ s/);
    await expect(freshPage.getByTestId('auth-submit')).toBeEnabled({ timeout: 10_000 });

    // the browser that signed in before goes straight in with the right password
    const ownerPage = await owner.newPage();
    await ownerPage.goto('/');
    await ownerPage.getByTestId('auth-email').fill(email);
    await ownerPage.getByTestId('auth-password').fill('password123');
    await ownerPage.getByTestId('auth-submit').click();
    await expect(ownerPage.getByTestId('new-project')).toBeVisible();

    await owner.close();
    await attacker.close();
    await fresh.close();
  });
});

test.describe('auth depth', () => {
  test('logout revokes the session server-side (stale cookie is invalid)', async ({ browser }) => {
    const ctx = await browser.newContext();
    const email = uniq();
    await ctx.request.post('/api/auth/register', { data: { email, password: 'password123' } });
    // capture the session cookie, then log out
    const cookies = await ctx.cookies();
    const session = cookies.find((c) => c.name === 'aldine_session');
    expect(session).toBeTruthy();
    await ctx.request.post('/api/auth/logout');
    // replay the stale cookie in a fresh context → must be rejected (revoked)
    const stale = await browser.newContext();
    await stale.addCookies([{ name: 'aldine_session', value: session!.value, url: `http://localhost:${process.env.E2E_AUTH_PORT || 3200}` }]);
    const me = await (await stale.request.get('/api/auth/me')).json();
    expect(me.user).toBeNull();
    await ctx.close(); await stale.close();
  });

  test('changing password revokes other sessions', async ({ browser }) => {
    const email = uniq();
    const s1 = await browser.newContext();
    await s1.request.post('/api/auth/register', { data: { email, password: 'password123' } });
    const s2 = await browser.newContext();
    await s2.request.post('/api/auth/login', { data: { email, password: 'password123' } });
    // s2 changes the password → s1's session should be revoked
    await s2.request.post('/api/auth/password', { data: { currentPassword: 'password123', newPassword: 'newpassword456' } });
    const s1me = await (await s1.request.get('/api/auth/me')).json();
    expect(s1me.user).toBeNull();
    // and the new password works
    const relog = await s1.request.post('/api/auth/login', { data: { email, password: 'newpassword456' } });
    expect(relog.ok()).toBeTruthy();
    await s1.close(); await s2.close();
  });

  test('forgot-password → reset flow works from the login screen and revokes agent access', async ({ page, request }) => {
    const email = uniq();
    // register, mint an agent token, then sign out
    await register(page, email);
    const { token } = await (await page.request.post('/api/tokens', { data: { name: 'Script' } })).json();
    const bearer = { authorization: `Bearer ${token}` };
    expect((await request.get('/api/projects', { headers: bearer })).status()).toBe(200);
    await page.goto('/');
    await page.getByTestId('account-menu').click();
    await page.getByTestId('logout').click();
    // forgot flow (self-host echo returns the token → reset mode)
    await page.getByTestId('auth-forgot').click();
    await page.getByTestId('auth-email').fill(email);
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('auth-token')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('auth-token')).not.toHaveValue('', { timeout: 10_000 });
    await page.getByTestId('auth-password').fill('brandnewpass1');
    await page.getByTestId('auth-submit').click();
    // back to login, told the token went with the old password
    await expect(page.getByTestId('auth-info')).toContainText('Password updated, and agent access was revoked', { timeout: 10_000 });
    expect((await request.get('/api/projects', { headers: bearer })).status()).toBe(401);
    // sign in with the new password
    await page.getByTestId('auth-email').fill(email);
    await page.getByTestId('auth-password').fill('brandnewpass1');
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('account-menu')).toBeVisible({ timeout: 15_000 });
  });

  test('SSO endpoints 404 for unconfigured providers, and only configured ones show a button', async ({ page, request }) => {
    for (const p of ['github', 'google']) {
      expect((await request.get(`/api/auth/oauth/${p}`, { maxRedirects: 0 })).status()).toBe(404);
    }
    expect((await request.get('/api/auth/oauth/orcid', { maxRedirects: 0 })).status()).toBe(302);
    await page.goto('/');
    await expect(page.getByTestId('auth-email')).toBeVisible();
    await expect(page.getByTestId('oauth-github')).toHaveCount(0);
    await expect(page.getByTestId('oauth-google')).toHaveCount(0);
    await expect(page.getByTestId('oauth-orcid')).toBeVisible();
  });

  test('change password from account settings revokes other sessions and agent access', async ({ page, browser, request }) => {
    const email = uniq();
    await register(page, email);
    // a second session for the same account (should be revoked by the change);
    // its own client address keeps it off the per-address sign-in limit the
    // rest of the suite shares (TRUST_PROXY=1)
    const own = { 'x-forwarded-for': '203.0.113.21' };
    const other = await browser.newContext();
    await other.request.post('/api/auth/login', { headers: own, data: { email, password: 'password123' } });
    // and an agent token (should be revoked too)
    const { token } = await (await page.request.post('/api/tokens', { data: { name: 'Script' } })).json();
    const bearer = { authorization: `Bearer ${token}` };
    expect((await request.get('/api/projects', { headers: bearer })).status()).toBe(200);

    // open account settings and change the password
    await page.getByTestId('account-menu').click();
    await page.getByTestId('user-name').click();
    await expect(page.getByTestId('account-settings')).toBeVisible();
    await page.getByTestId('current-password').fill('password123');
    await page.getByTestId('new-password').fill('changed-pw-99');
    await page.getByTestId('save-password').click();
    await expect(page.locator('.toast', { hasText: 'Password updated' })).toContainText('Agent access was revoked');

    // the other session and the token are now revoked
    await expect.poll(async () => (await (await other.request.get('/api/auth/me')).json()).user).toBeNull();
    expect((await request.get('/api/projects', { headers: bearer })).status()).toBe(401);
    // and the new password works
    expect((await request.post('/api/auth/login', { headers: own, data: { email, password: 'changed-pw-99' } })).ok()).toBeTruthy();
    await other.close();
  });
});

test.describe('plan metering', () => {
  test('/api/usage requires sign-in and reports compile usage', async ({ browser }) => {
    const anon = await browser.newContext();
    expect((await anon.request.get('/api/usage')).status()).toBe(401);
    const ctx = await browser.newContext();
    await ctx.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    const u = await (await ctx.request.get('/api/usage')).json();
    expect(typeof u.seconds).toBe('number');
    expect(typeof u.quotaSeconds).toBe('number');
    expect(typeof u.metering).toBe('boolean');
    expect(u.month).toMatch(/^\d{4}-\d{2}$/);
    await anon.close(); await ctx.close();
  });
});

test.describe('collab under auth', () => {
  test('opening a file loads its content (collab socket authenticates)', async ({ page, request }) => {
    const email = uniq();
    await register(page, email);
    const proj = await (await page.request.post('/api/projects', { data: { name: 'Collab Auth' } })).json();
    await page.request.put(`/api/projects/${proj.id}/file`, { data: { branch: 'main', path: 'paper/chapters/five.tex', content: 'LOADED-UNDER-AUTH-42\n' } });
    await page.goto(`/p/${proj.id}`);
    await expect(page.locator('.cm-content')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('file-paper/chapters/five.tex').click();
    // before the token fix this stayed blank (collab never authenticated)
    await expect(page.locator('.cm-content')).toContainText('LOADED-UNDER-AUTH-42', { timeout: 15_000 });
  });

});

test.describe('cookies', () => {
  // #26: the browser sends every cookie on the host, so a neighbouring app's
  // `x=100%` used to throw URIError in the onRequest hook and 500 every request.
  test('a malformed cookie on the host does not break the session', async ({ page, context, baseURL }) => {
    const email = uniq();
    await register(page, email);
    const url = new URL(baseURL!);
    await context.addCookies([
      { name: 'foreign', value: '100%', domain: url.hostname, path: '/' },
      { name: 'truncated', value: '%E0%A4%A', domain: url.hostname, path: '/' },
    ]);
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
    // still signed in: the session cookie next to the malformed ones resolves
    await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('body')).not.toContainText('Internal server error');

    // signed out with only the malformed cookies left: the login screen, not a 500
    await page.getByTestId('account-menu').click();
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('auth-email')).toBeVisible();
    const again = await page.goto('/');
    expect(again?.status()).toBe(200);
    await expect(page.getByTestId('auth-email')).toBeVisible();
    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    expect((await me.json()).user).toBeNull();
  });
});

test.describe('ownerless legacy projects', () => {
  // Fabricate the pre-auth state: a real project whose meta has no ownerId
  // (ALDINE_TEST_HOOKS=1 exposes the disown route on the test server only).
  const seedOwnerless = async (ctx: import('@playwright/test').APIRequestContext, name: string) => {
    const proj = await (await ctx.post('/api/projects', { data: { name } })).json();
    const r = await ctx.post(`/api/projects/${proj.id}/disown`);
    if (!r.ok()) throw new Error('disown hook failed — is ALDINE_TEST_HOOKS set?');
    return proj.id as string;
  };

  test('everyone sees it, nobody can manage it until claimed; first claim wins', async ({ browser }) => {
    const alice = await browser.newContext();
    await alice.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123', name: 'Alice' } });
    const id = await seedOwnerless(alice.request, 'Legacy Doc');

    const bob = await browser.newContext();
    await bob.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123', name: 'Bob' } });

    // listed for a stranger, readable, but not manageable
    const bobList = await (await bob.request.get('/api/projects')).json();
    const seen = bobList.find((p: { id: string }) => p.id === id);
    expect(seen).toBeTruthy();
    expect(seen.ownerId).toBeFalsy();
    expect(seen.isOwner).toBeFalsy();
    expect((await bob.request.delete(`/api/projects/${id}`)).status()).toBe(403);
    expect((await bob.request.post(`/api/projects/${id}/share`, { data: { mode: 'link' } })).status()).toBe(403);

    // simultaneous claims resolve to exactly one winner (in-process mutex)
    const [r1, r2] = await Promise.all([
      bob.request.post(`/api/projects/${id}/claim`),
      alice.request.post(`/api/projects/${id}/claim`),
    ]);
    const statuses = [r1.status(), r2.status()].sort();
    // Exactly one winner. The loser sees 409 (lost inside the claim mutex) or
    // 403 (the winner's writeMeta already landed, so the global access guard
    // rejects before the route) — both are correct denials, timing decides.
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);

    const winner = r1.status() === 200 ? bob : alice;
    const loser = r1.status() === 200 ? alice : bob;
    expect((await (await winner.request.get(`/api/projects/${id}`)).json()).isOwner).toBe(true);
    // loser lost access entirely (project is private to the winner now)
    expect((await loser.request.get(`/api/projects/${id}`)).status()).toBe(403);
    const loserList = await (await loser.request.get('/api/projects')).json();
    expect(loserList.some((p: { id: string }) => p.id === id)).toBeFalsy();

    await alice.close();
    await bob.close();
  });

  test('claim from the project menu unlocks owner controls', async ({ browser }) => {
    const seeder = await browser.newContext();
    await seeder.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    const id = await seedOwnerless(seeder.request, 'Claim Me');
    await seeder.close();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await register(page, uniq());
    const card = page.getByTestId(`project-card-${id}`);
    await expect(card).toBeVisible();
    await expect(page.getByTestId(`unclaimed-${id}`)).toHaveText('Unclaimed');
    await page.getByTestId(`project-menu-${id}`).click();
    await expect(page.getByTestId(`claim-${id}`)).toBeVisible();
    await expect(page.getByTestId(`share-${id}`)).toHaveCount(0); // no owner controls pre-claim
    await page.getByTestId(`claim-${id}`).click();
    await expect(page.getByTestId('dialog-message')).toContainText('You become its owner');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId(`unclaimed-${id}`)).toHaveCount(0);
    await page.getByTestId(`project-menu-${id}`).click();
    await expect(page.getByTestId(`share-${id}`)).toBeVisible(); // owner controls appear
    await expect(page.getByTestId(`claim-${id}`)).toHaveCount(0);
    await ctx.close();
  });

  test('a project opened through a share link is listed under Shared with me until removed', async ({ browser }) => {
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    await register(ownerPage, uniq(), 'password123', 'Grace Owner');
    const { id } = await (await ownerPage.request.post('/api/projects', { data: { name: 'Link Shared Paper' } })).json();
    expect((await ownerPage.request.post(`/api/projects/${id}/share`, { data: { mode: 'link', collaborators: ['invited-reader@example.com'] } })).ok()).toBeTruthy();
    await ownerPage.goto('/');
    await expect(ownerPage.getByTestId(`shared-link-${id}`)).toHaveText('Link');
    // the list the tab keeps holds no invite addresses, and a refused list takes it away
    const ownerCache = () => ownerPage.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('aldine.home.list:')).map((k) => sessionStorage.getItem(k)));
    await expect.poll(async () => (await ownerCache()).length).toBe(1);
    expect((await ownerCache())[0]).not.toContain('invited-reader');
    await ownerPage.route(/\/api\/projects$/, (route) => route.fulfill({ status: 401, json: { error: 'sign in' } }));
    await ownerPage.reload();
    await expect.poll(async () => (await ownerCache()).length).toBe(0);
    await ownerPage.unroute(/\/api\/projects$/);

    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    await register(page, uniq(), 'password123', 'Ada Visitor');
    await expect(page.getByTestId(`project-card-${id}`)).toHaveCount(0);
    await page.goto(`/p/${id}`);
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await page.goto('/?show=shared');
    await expect(page.getByTestId('filter-shared')).toHaveAttribute('aria-current', 'page');
    const card = page.getByTestId(`project-card-${id}`);
    await expect(card).toBeVisible();
    // a recipient's sheet names the owner on a chip, with the link it came through
    await expect(page.getByTestId(`owner-${id}`).locator('.chip__text')).toHaveText('Grace');
    await expect(page.getByTestId(`owner-${id}`)).toHaveAttribute('title', 'Opened through a link from Grace Owner');
    await expect(page.getByTestId(`owner-${id}`)).toHaveText('Grace'); // the first name alone, no initials
    await expect(page.getByTestId(`open-${id}`)).toHaveAccessibleDescription(/Opened through a link from Grace Owner/);
    // a recipient's menu: no rename, share or trash, but a way off the list
    await page.getByTestId(`project-menu-${id}`).click();
    await expect(page.getByTestId('menu-trash')).toHaveCount(0);
    await expect(page.getByTestId('menu-rename')).toHaveCount(0);
    const openedBefore = ((await (await page.request.get('/api/projects')).json()) as { id: string; opened: unknown }[]).find((p) => p.id === id)!.opened;
    await page.getByTestId('menu-remove').click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('.toast', { hasText: 'Removed Link Shared Paper from your list' })).toBeVisible();
    // Undo puts it back as it was (not as a new open) and focus on it
    await page.getByTestId('undo-remove').click();
    await expect(card).toBeVisible();
    await expect(page.getByTestId(`open-${id}`)).toBeFocused();
    const back = ((await (await page.request.get('/api/projects')).json()) as { id: string; opened: unknown }[]).find((p) => p.id === id);
    expect(back?.opened).toEqual(openedBefore);

    // axe with a shared project and the account menu open
    await page.getByTestId('account-menu').click();
    await expect(page.getByTestId('account-menu-list')).toBeVisible();
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    // An open menu is drawn over the page, outside its landmarks, as a popup belongs to its button.
    const axe = await new AxeBuilder({ page }).exclude('[data-testid="account-menu-list"]').analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByTestId(`project-menu-${id}`).click();
    await page.getByTestId('menu-remove').click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('shared-empty')).toBeVisible();
    const mine = (await (await page.request.get('/api/projects')).json()) as { id: string }[];
    expect(mine.some((p) => p.id === id)).toBe(false);

    // the list kept for the tab: no addresses, and gone with the session
    const cacheKeys = () => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('aldine.home.list:')));
    expect(await cacheKeys()).toHaveLength(1);
    expect(await page.evaluate((k) => sessionStorage.getItem(k), (await cacheKeys())[0])).not.toContain('@');
    await page.getByTestId('account-menu').click();
    await page.getByTestId('logout').click();
    await expect.poll(cacheKeys).toEqual([]);

    await owner.close();
    await visitor.close();
  });
});

/**
 * ORCID sign-in against the stub in mock-orcid.mjs. Most researchers keep
 * their ORCID email private, so the account has no email at all: it is keyed
 * by the iD, and collaborators invite it by the iD.
 */
const ORCID_PRIVATE = '0000-0002-1825-0097';

async function signInWithOrcid(page: import('@playwright/test').Page, persona: 'private' | 'public') {
  await page.goto('/');
  await page.getByTestId('oauth-orcid').click();
  await expect(page.getByTestId(`persona-${persona}`)).toBeVisible();
  await page.getByTestId(`persona-${persona}`).click();
}

test.describe('ORCID sign-in', () => {
  test('an ORCID account without a public email lands in the project list and keeps its projects', async ({ page }) => {
    await signInWithOrcid(page, 'private');
    await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('account-menu').click();
    await page.getByTestId('user-name').click();
    const settings = page.getByTestId('account-settings');
    await expect(settings.getByTestId('account-orcid')).toHaveText(ORCID_PRIVATE);
    await expect(settings.getByTestId('account-email')).toHaveText('No email address on this account');
    await expect(settings).toContainText('Single sign-on (ORCID)');
    await page.keyboard.press('Escape');

    const name = `ORCID paper ${Date.now()}`;
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill(name);
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();

    await page.goto('/');
    await page.getByTestId('account-menu').click();
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('auth-email')).toBeVisible();
    await signInWithOrcid(page, 'private');
    await expect(page.getByTestId('project-grid')).toContainText(name, { timeout: 15_000 });
  });

  test('an owner invites an ORCID iD and the email-less account gets in', async ({ browser }) => {
    const alice = await browser.newContext();
    await alice.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123', name: 'Alice' } });
    const proj = await (await alice.request.post('/api/projects', { data: { name: 'Invite by iD' } })).json();

    const orcid = await browser.newContext();
    const page = await orcid.newPage();
    await signInWithOrcid(page, 'private');
    await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
    expect((await orcid.request.get(`/api/projects/${proj.id}`)).status()).toBe(403);

    const shared = await alice.request.post(`/api/projects/${proj.id}/share`, { data: { mode: 'private', collaborators: [ORCID_PRIVATE.toLowerCase()] } });
    expect(shared.ok()).toBeTruthy();
    expect((await orcid.request.get(`/api/projects/${proj.id}`)).ok()).toBeTruthy();
    const list = await (await orcid.request.get('/api/projects')).json();
    expect(list.some((p: { id: string }) => p.id === proj.id)).toBeTruthy();

    await alice.close();
    await orcid.close();
  });

  test('a public ORCID email never signs into a password account with that address', async ({ page, request }) => {
    // The address the public persona exposes; registered as a password account
    // first (a re-run finds it already there, which is the same situation).
    await request.post('/api/auth/register', { data: { email: 'sofia.garcia@example.org', password: 'password123', name: 'Sofia' } });
    await signInWithOrcid(page, 'public');
    await expect(page.locator('body')).toContainText('sign in with your password');
    await page.goto('/');
    await expect(page.getByTestId('auth-email')).toBeVisible();
  });
});
