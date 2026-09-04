import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { CATALOG_WAIT_MS, VENUE_PREFIX, venueTemplateFiles, venueTemplates } from './catalog.js';

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
 * Folder templates plus every venue class the compiler image carries. The
 * folder half never waits on the network: a compiler that is reachable but
 * silent costs CATALOG_WAIT_MS and an empty venue half, not an empty gallery.
 */
export async function listAllTemplates(): Promise<TemplateInfo[]> {
  const folders = listTemplates();
  const venues = await venueTemplates(CATALOG_WAIT_MS);
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

/** Seed files for any gallery id: a folder template or a `venue:` catalog entry. */
export async function resolveTemplateFiles(id: string): Promise<Record<string, Buffer>> {
  if (id.startsWith(VENUE_PREFIX)) return venueTemplateFiles(id);
  return templateFiles(id);
}
