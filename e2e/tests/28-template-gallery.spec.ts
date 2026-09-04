import { test, expect } from '../fixtures';
import type { APIRequestContext } from '@playwright/test';

/**
 * The venue half of the gallery is whatever the compiler image has installed:
 * on full TeX Live that is every publisher class, on the BasicTeX a laptop
 * carries it can be nothing at all. An empty catalog is a supported state, so
 * the venue tests skip there with a message; the folder templates and the
 * search box are asserted in a test that never skips.
 */
interface Template {
  id: string;
  name: string;
  category?: string;
  documentClass?: string;
  license?: string;
}

async function templates(request: APIRequestContext): Promise<Template[]> {
  const res = await request.get('/api/templates');
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/**
 * The venue half fills in behind the folder templates, so an empty answer right
 * after boot may only mean the compiler has not finished its sweep. Poll before
 * concluding the image has none of the classes.
 */
async function venuesOrSkip(request: APIRequestContext): Promise<Template[]> {
  let venues: Template[] = [];
  for (let i = 0; i < 15 && venues.length === 0; i++) {
    venues = (await templates(request)).filter((t) => t.id.startsWith('venue:'));
    if (!venues.length) await new Promise((r) => setTimeout(r, 1000));
  }
  test.skip(venues.length === 0, 'the compiler image ships none of the venue classes (BasicTeX): the catalog is empty');
  return venues;
}

async function openGallery(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('template-grid')).toBeVisible();
}

test.describe('template gallery', () => {
  test('the folder templates and the search box are always there', async ({ page }) => {
    await openGallery(page);

    await expect(page.getByTestId('template-category-General')).toBeVisible();
    for (const id of ['article', 'beamer', 'iac-paper', 'report']) {
      await expect(page.getByTestId(`template-${id}`)).toBeVisible();
      await expect(page.getByTestId(`template-license-${id}`)).not.toBeEmpty();
    }

    const search = page.getByTestId('template-search');
    await expect(search).toBeVisible();
    await search.fill('presentation');
    await expect(page.getByTestId('template-beamer')).toBeVisible();
    await expect(page.getByTestId('template-article')).toHaveCount(0);
    await search.fill('zzzz no such venue');
    await expect(page.getByTestId('template-empty')).toBeVisible();
    // The choice survives a filter that hides its tile, and both the empty
    // state and the footer say what Create will actually make.
    await expect(page.getByTestId('template-empty')).toContainText('Article');
    await expect(page.getByTestId('template-choice')).toContainText('Article');
    await page.getByTestId('template-search-clear').click();
    await expect(search).toHaveValue('');
    await expect(page.getByTestId('template-article')).toBeVisible();

    // The four folder templates still create a project the old way.
    await page.getByTestId('new-project-name').fill('Folder Template Paper');
    await page.getByTestId('template-report').click();
    await expect(page.getByTestId('template-choice')).toContainText('Report');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
  });

  test('searching finds a venue tile with its licence', async ({ page, request }) => {
    const venue = (await venuesOrSkip(request))[0];
    await openGallery(page);

    await page.getByTestId('template-search').fill(venue.name);
    const tile = page.getByTestId(`template-${venue.id}`);
    await expect(tile).toBeVisible();
    await expect(tile).toContainText(venue.name);
    if (venue.license) await expect(page.getByTestId(`template-license-${venue.id}`)).toContainText(venue.license);
    // Venues live in their own category, never in the folder-template bucket.
    expect(venue.category).not.toBe('General');
    await expect(page.getByTestId(`template-category-${venue.category}`)).toBeVisible();
  });

  test('a project created from a venue tile starts from that class', async ({ page, request }) => {
    const venue = (await venuesOrSkip(request))[0];
    await openGallery(page);

    await page.getByTestId('new-project-name').fill('Venue Paper');
    await page.getByTestId('template-search').fill(venue.name);
    await page.getByTestId(`template-${venue.id}`).click();
    await expect(page.getByTestId('template-choice')).toContainText(venue.name);
    await page.getByTestId('create-project').click();

    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
    await expect(page.getByTestId('file-references.bib')).toBeVisible();

    const id = new URL(page.url()).pathname.split('/').pop()!;
    const file = await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`);
    expect(file.ok()).toBeTruthy();
    const source = await file.text();
    expect(source).toContain(venue.documentClass!);
    expect(source).toMatch(/\\(documentclass|usepackage)/);
  });
});
