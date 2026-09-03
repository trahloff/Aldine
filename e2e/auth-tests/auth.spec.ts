import { test, expect } from '../fixtures';

/** Unique email per run so re-runs don't collide with the persisted user store. */
const uniq = () => `u${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;

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
    await expect(page.getByTestId('user-name')).toBeVisible();
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('auth-email')).toBeVisible();

    // sign back in — project is still there
    await page.getByTestId('auth-email').fill(email);
    await page.getByTestId('auth-password').fill('password123');
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('project-grid')).toContainText('My Private Paper', { timeout: 15_000 });
  });

  test('wrong password is rejected', async ({ page }) => {
    const email = uniq();
    await register(page, email);
    await page.goto('/');
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

  test('link sharing grants access by URL but never lists the project for strangers', async ({ browser }) => {
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
    // …but the project must not surface in Carol's list
    const listRes = await carol.request.get('/api/projects');
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    expect(Array.isArray(list)).toBeTruthy();
    expect(list.some((p: { id: string }) => p.id === proj.id)).toBeFalsy();

    // Positive controls — "not listed" must not be passing because nothing is
    // listed: the owner still sees it, and so does a collaborator invited by
    // email even though the mode is 'link'.
    const aliceList = await (await alice.request.get('/api/projects')).json();
    expect(aliceList.some((p: { id: string }) => p.id === proj.id)).toBeTruthy();

    const dana = await browser.newContext();
    await dana.request.post('/api/auth/register', { data: { email: dEmail, password: 'password123' } });
    const danaList = await (await dana.request.get('/api/projects')).json();
    expect(danaList.some((p: { id: string }) => p.id === proj.id)).toBeTruthy();

    await alice.close();
    await carol.close();
    await dana.close();
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
    // the name is untouched
    expect((await (await alice.request.get(`/api/projects/${proj.id}`)).json()).name).toBe('Link Limits');

    await alice.close();
    await carol.close();
  });

  test('share from the editor toolbar: owner-only button, link mode, copyable link', async ({ page, browser }) => {
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

    await page.getByTestId('share-emails').fill(uniq());
    await page.getByTestId('share-save').click();
    await expect(page.getByTestId('share-modal')).toHaveCount(0);
    const after = await (await page.request.get(`/api/projects/${proj.id}`)).json();
    expect(after.share.mode).toBe('link');

    // a link visitor opens the same project — and gets no Share button
    const carol = await browser.newContext();
    await carol.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    const carolPage = await carol.newPage();
    await carolPage.goto(`/p/${proj.id}`);
    await expect(carolPage.getByTestId('editor-shell')).toBeVisible();
    await expect(carolPage.getByTestId('share-project')).toHaveCount(0);
    await expect(carolPage.getByTestId('github-publish-open')).toHaveCount(0);
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

  test('forgot-password → reset flow works from the login screen', async ({ page }) => {
    const email = uniq();
    // register then sign out
    await register(page, email);
    await page.goto('/');
    await page.getByTestId('logout').click();
    // forgot flow (self-host echo returns the token → reset mode)
    await page.getByTestId('auth-forgot').click();
    await page.getByTestId('auth-email').fill(email);
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('auth-token')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('auth-token')).not.toHaveValue('', { timeout: 10_000 });
    await page.getByTestId('auth-password').fill('brandnewpass1');
    await page.getByTestId('auth-submit').click();
    // back to login; sign in with the new password
    await expect(page.getByTestId('auth-info')).toContainText(/updated/i, { timeout: 10_000 });
    await page.getByTestId('auth-email').fill(email);
    await page.getByTestId('auth-password').fill('brandnewpass1');
    await page.getByTestId('auth-submit').click();
    await expect(page.locator('.home__brand')).toBeVisible({ timeout: 15_000 });
  });

  test('SSO endpoints 404 when unconfigured and no buttons show', async ({ page, request }) => {
    for (const p of ['github', 'google']) {
      expect((await request.get(`/api/auth/oauth/${p}`, { maxRedirects: 0 })).status()).toBe(404);
    }
    await page.goto('/');
    await expect(page.getByTestId('auth-email')).toBeVisible();
    await expect(page.getByTestId('oauth-github')).toHaveCount(0);
    await expect(page.getByTestId('oauth-google')).toHaveCount(0);
  });

  test('change password from account settings revokes other sessions', async ({ page, browser, request }) => {
    const email = uniq();
    await register(page, email);
    // a second session for the same account (should be revoked by the change)
    const other = await browser.newContext();
    await other.request.post('/api/auth/login', { data: { email, password: 'password123' } });

    // open account settings and change the password
    await page.getByTestId('user-name').click();
    await expect(page.getByTestId('account-settings')).toBeVisible();
    await page.getByTestId('current-password').fill('password123');
    await page.getByTestId('new-password').fill('changed-pw-99');
    await page.getByTestId('save-password').click();

    // the other session is now revoked
    await expect.poll(async () => (await (await other.request.get('/api/auth/me')).json()).user).toBeNull();
    // and the new password works
    expect((await request.post('/api/auth/login', { data: { email, password: 'changed-pw-99' } })).ok()).toBeTruthy();
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

  test('claim via the home-screen button unlocks owner controls', async ({ browser }) => {
    const seeder = await browser.newContext();
    await seeder.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123' } });
    const id = await seedOwnerless(seeder.request, 'Claim Me');
    await seeder.close();

    const ctx = await browser.newContext();
    await ctx.addInitScript(() => localStorage.setItem('aldine.onboarded', '1'));
    const page = await ctx.newPage();
    await register(page, uniq());
    const card = page.getByTestId(`project-card-${id}`);
    await expect(card).toBeVisible();
    await expect(page.getByTestId(`claim-${id}`)).toBeVisible();
    await expect(page.getByTestId(`share-${id}`)).toHaveCount(0); // no owner controls pre-claim
    page.on('dialog', (d) => d.accept());
    await page.getByTestId(`claim-${id}`).click();
    await expect(page.getByTestId(`share-${id}`)).toBeVisible(); // owner controls appear
    await expect(page.getByTestId(`claim-${id}`)).toHaveCount(0);
    await ctx.close();
  });
});
