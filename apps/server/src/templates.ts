import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { CATALOG_WAIT_MS, VENUE_PREFIX, venueClasses, venueTemplateFiles, venueTemplates } from './catalog.js';
import { venueKit, venueKitSeed, venueKitTemplates, type VenueKitStatus } from './venuekits.js';

export type TemplateCategory = 'Journals' | 'Conferences' | 'Theses' | 'Slides' | 'General';

/** Not a directory under templates/: a project with no files and no typeset
 *  root. Listed first so the grid leads with it and never hidden by an
 *  absent templates dir. */
export const BLANK_TEMPLATE: TemplateInfo = {
  id: 'blank', name: 'Blank', description: 'An empty project. Add the first file yourself.', icon: '▢', order: 0, category: 'General',
};

/** Where the template came from: upstream URL and the version it was taken at. */
export interface TemplateSource { url: string; version?: string }

export interface TemplateInfo {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  order?: number;
  category?: TemplateCategory;
  /** \documentclass (or style) the template starts from; venue entries only. */
  documentClass?: string;
  /** Human-readable license of the template files, shown on the tile. */
  license?: string;
  licenseUrl?: string;
  source?: TemplateSource;
  /** Fetched-kit venues: the publisher the kit is downloaded from at create time. */
  kit?: { host: string; url: string; homepage?: string; termsUrl?: string };
}

const CATEGORIES: TemplateCategory[] = ['Journals', 'Conferences', 'Theses', 'Slides', 'General'];

/** Templates shipped as folders under templates/. */
export function listTemplates(): TemplateInfo[] {
  const dir = config.templatesDir;
  if (!fs.existsSync(dir)) return [BLANK_TEMPLATE];
  const out: TemplateInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    const metaPath = path.join(dir, name, 'template.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TemplateInfo;
      meta.id = meta.id || name;
      // The built-in id is taken: a directory claiming it would list twice and
      // could never be created (templateFiles answers {} for it).
      if (meta.id === BLANK_TEMPLATE.id) {
        console.warn(`templates/${name} uses the built-in template id "${BLANK_TEMPLATE.id}" and is ignored`);
        continue;
      }
      if (!meta.category || !CATEGORIES.includes(meta.category)) meta.category = 'General';
      out.push(meta);
    } catch { /* skip broken template */ }
  }
  return [BLANK_TEMPLATE, ...out.sort((a, b) => (a.order ?? 99) - (b.order ?? 99))];
}

/** All files of a template (except template.json), as relative-path → content. */
/**
 * Folder templates, every venue class the compiler image carries, and every
 * venue whose kit Aldine fetches from the publisher. The folder half never
 * waits on the network: a compiler that is reachable but silent costs
 * CATALOG_WAIT_MS and an empty venue half, not an empty gallery.
 *
 * A venue in both halves is listed once, as the installed class: that seeds a
 * project with no download at all, so it is the better of the two.
 */
export async function listAllTemplates(): Promise<TemplateInfo[]> {
  const folders = listTemplates();
  const installed = await venueTemplates(CATALOG_WAIT_MS);
  const seen = new Set(installed.map((t) => t.id));
  const fetched = venueKitTemplates().filter((t) => !seen.has(t.id));
  // One alphabet across both halves: a category that lists the installed venues
  // A-Z and then starts over with the fetched ones reads as if the second half
  // is not there. Folder templates keep their curated order, blank first.
  const venues = [...installed, ...fetched].sort((a, b) => a.name.localeCompare(b.name));
  return [...folders, ...venues];
}

/** Gallery bookkeeping, not part of the document the user starts from. */
const NOT_SEEDED = new Set(['template.json', 'LICENSE']);

/**
 * All files of a template, as relative-path → bytes. Buffers, not strings: a
 * template may carry a logo or a figure, and decoding those as UTF-8 corrupts
 * them.
 */
export function templateFiles(id: string): Record<string, Buffer> {
  if (id === BLANK_TEMPLATE.id) return {};
  if (id.includes('..') || id.includes('/')) throw new Error('bad template id');
  const base = path.join(config.templatesDir, id);
  if (!fs.existsSync(path.join(base, 'template.json'))) throw new Error(`unknown template: ${id}`);
  const files: Record<string, Buffer> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(relPath);
      else if (!(rel === '' && NOT_SEEDED.has(e.name))) files[relPath] = fs.readFileSync(path.join(base, relPath));
    }
  };
  walk('');
  return files;
}

/** What a template id seeds a project with, and how the venue kit went. */
export interface TemplateSeed {
  files: Record<string, Buffer>;
  /** Fetched-kit venues only. `ok: false` means the project is a skeleton. */
  venueKit?: VenueKitStatus;
}

/**
 * Seed files for any gallery id: a folder template, an installed venue class,
 * or a venue whose kit is fetched from the publisher. The installed class wins
 * the same way it does in the listing, so the tile the user saw is the one
 * they get.
 */
export async function resolveTemplateSeed(id: string): Promise<TemplateSeed> {
  if (!id.startsWith(VENUE_PREFIX)) return { files: templateFiles(id) };
  const key = id.slice(VENUE_PREFIX.length);
  const installed = (await venueClasses(CATALOG_WAIT_MS)).some((c) => c.id === key);
  if (!installed) {
    const entry = venueKit(key);
    if (entry) return venueKitSeed(entry);
  }
  return { files: await venueTemplateFiles(id) };
}
