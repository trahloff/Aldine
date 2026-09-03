import { test, expect } from '../fixtures';

/**
 * Runs against tests/mock-gitlab.mjs (:4921), which backs its projects with
 * real bare repos so clone and push actually happen. GITHUB_CLIENT_ID is unset
 * in e2e, so GitHub offers PAT connect only — which is what these tests use.
 */
test.describe('remote providers', () => {
  // Connections are per-user and persist on the server, so a test that needs the
  // connect form must start from disconnected — otherwise it inherits the
  // previous test's connection and the token field never renders.
  test.beforeEach(async ({ request }) => {
    await request.post('/api/remotes/gitlab/disconnect');
  });

  async function connectGitlab(page: import('@playwright/test').Page) {
    await page.getByTestId('new-from-gitlab').click();
    await page.getByTestId('gitlab-token').fill('e2e-token');
    await page.getByTestId('gitlab-connect').click();
    await expect(page.getByTestId('gitlab-repos')).toContainText('grp/sub/paper');
  }

  test('offers every configured provider on the home screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('new-from-github')).toBeVisible();
    await expect(page.getByTestId('new-from-gitlab')).toBeVisible();
  });

  test('imports a project from GitLab', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-from-gitlab').click();
    await expect(page.getByTestId('gitlab-import')).toBeVisible();

    // Not connected yet: the token field and the self-hosted escape hatch show.
    await expect(page.getByTestId('gitlab-selfhosted')).toBeVisible();
    await page.getByTestId('gitlab-token').fill('e2e-token');
    await page.getByTestId('gitlab-connect').click();

    await expect(page.getByTestId('gitlab-repos')).toContainText('grp/sub/paper');
    await page.getByTestId('gitlab-repo-grp/sub/paper').click();

    await expect(page).toHaveURL(/\/p\//);
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
    // A linked project shows the sync control, scoped to its provider.
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
  });

  test('a GitLab-linked project proposes merge requests, not pull requests', async ({ page }) => {
    await page.goto('/');
    await connectGitlab(page);
    await page.getByTestId('gitlab-repo-grp/sub/paper').click();
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();

    // Create a branch so we're off the default and the change-request item appears.
    await page.getByTestId('gitlab-branch').click();
    await page.getByTestId('gitlab-new-branch').fill('e2e-draft');
    await page.getByTestId('gitlab-create-branch').click();

    await page.getByTestId('gitlab-branch').click();
    await expect(page.getByTestId('gitlab-open-pr')).toContainText('merge request');
  });

  test('the self-hosted field rejects a non-https instance URL', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-from-gitlab').click();
    await page.getByTestId('gitlab-token').fill('e2e-token');
    await page.getByTestId('gitlab-selfhosted').click();
    await page.getByTestId('gitlab-baseurl').fill('http://insecure.example.com');
    await page.getByTestId('gitlab-connect').click();
    // Still on the connect form, with the reason shown as a toast.
    await expect(page.getByTestId('gitlab-token')).toBeVisible();
    await expect(page.locator('.toast')).toContainText('https');
  });

  test('an unlinked project offers Publish, and the modal lets you pick a host', async ({ page, request }) => {
    const res = await request.post('/api/projects', { data: { name: 'Unlinked Paper' } });
    const { id } = await res.json();
    await page.goto(`/p/${id}`);
    await page.getByTestId('remote-publish-open').click();
    await expect(page.getByTestId('remote-publish')).toBeVisible();
    await expect(page.getByTestId('remote-publish-provider-github')).toBeVisible();
    await expect(page.getByTestId('remote-publish-provider-gitlab')).toBeVisible();
  });
});
