import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Venues whose class files TeX Live does not carry: the server downloads the
 * publisher's kit when the project is created. The registry under test points
 * at the mock publisher in tests/mock-zotero.mjs, so nothing here reaches a
 * real venue, and the archive is built in that process rather than committed.
 */
interface Template {
  id: string;
  name: string;
  kit?: { host: string; url: string };
}

/** The registry is written by the mock server, so it can land after boot. */
async function kitTemplates(request: APIRequestContext): Promise<Template[]> {
  let tiles: Template[] = [];
  for (let i = 0; i < 15 && tiles.length === 0; i++) {
    const res = await request.get('/api/templates');
    expect(res.ok()).toBeTruthy();
    tiles = ((await res.json()) as Template[]).filter((t) => !!t.kit);
    if (!tiles.length) await new Promise((r) => setTimeout(r, 1000));
  }
  expect(tiles.length, 'the fetched-venue registry is served').toBeGreaterThan(0);
  return tiles;
}

async function openGallery(page: Page) {
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('template-grid')).toBeVisible();
}

async function pick(page: Page, name: string, id: string) {
  await page.getByTestId('template-search').fill(name);
  await page.getByTestId(`template-${id}`).click();
  await expect(page.getByTestId('template-choice')).toContainText(name);
}

test.describe('venue kits fetched from the publisher', () => {
  test('a tile says it downloads the kit, and the project is the kit', async ({ page, request }) => {
    const tiles = await kitTemplates(request);
    const kit = tiles.find((t) => t.id === 'venue:e2ekit')!;
    expect(kit, 'the fixture venue is listed').toBeTruthy();

    await openGallery(page);
    await page.getByTestId('template-search').fill('E2E Venue Kit');
    // The download happens at create time, and the tile says so before the pick.
    await expect(page.getByTestId('template-kit-venue:e2ekit')).toContainText(`Downloads the official kit from ${kit.kit!.host}`);
    await expect(page.getByTestId('template-license-venue:e2ekit')).toContainText('Publisher terms');

    await page.getByTestId('new-project-name').fill('Kit Paper');
    await pick(page, 'E2E Venue Kit', 'venue:e2ekit');
    await page.getByTestId('create-project').click();

    await expect(page.getByTestId('editor-shell')).toBeVisible();
    // The kit's own document becomes main.tex; its style file comes along.
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
    await expect(page.getByTestId('file-e2evenue.sty')).toBeVisible();
    await expect(page.getByTestId('file-e2e.bib')).toBeVisible();

    const id = new URL(page.url()).pathname.split('/').pop()!;
    const main = await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`);
    expect(await main.text()).toContain('From the venue kit.');
    const sty = await request.get(`/api/projects/${id}/file?branch=main&path=e2evenue.sty`);
    expect(await sty.text()).toContain('ProvidesPackage{e2evenue}');
    // Only what the registry names: the archive's manual and its junk stay out.
    const { files } = (await (await request.get(`/api/projects/${id}/files?branch=main`)).json()) as { files: { path: string }[] };
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['e2e.bib', 'e2evenue.sty', 'main.tex']));
    expect(paths).not.toContain('kit-manual.pdf');
    expect(paths.some((p) => p.includes('__MACOSX'))).toBeFalsy();
  });

  test('a kit that cannot be downloaded still creates the project, and says so', async ({ page, request }) => {
    await kitTemplates(request);
    await openGallery(page);
    await page.getByTestId('new-project-name').fill('Skeleton Paper');
    await pick(page, 'E2E Missing Kit', 'venue:e2egone');

    const toast = page.locator('.toast', { hasText: 'Could not download the E2E Missing Kit kit' });
    await page.getByTestId('create-project').click();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('created from a skeleton');

    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('file-main.tex')).toBeVisible();

    const id = new URL(page.url()).pathname.split('/').pop()!;
    // README-venue.md is not a source file, so it is in the project without
    // being in the default file tree.
    const readme = await request.get(`/api/projects/${id}/file?branch=main&path=README-venue.md`);
    expect(readme.ok()).toBeTruthy();
    const text = await readme.text();
    expect(text).toContain('no-such-kit.zip');
    expect(text).toContain('https://example.org/authors');
  });
});
