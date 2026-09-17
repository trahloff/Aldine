import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { CATALOG_WAIT_MS, VENUE_PREFIX, venueClasses, venueTemplateFiles, venueTemplates } from './catalog.js';
import { venueKit, venueKitSeed, venueKitTemplates, type VenueKitStatus } from './venuekits.js';
import { REPO_PREFIX, listRepoTemplates, repoTemplateFiles } from './templaterepos.js';
import { isTextFile } from './util.js';

export type TemplateCategory = 'Journals' | 'Conferences' | 'Theses' | 'Slides' | 'General';

/** Not a directory under templates/: a project with no files and no typeset
 *  root. Listed first so the grid leads with it and never hidden by an
 *  absent templates dir. */
export const BLANK_TEMPLATE: TemplateInfo = {
  id: 'blank', name: 'Blank', description: 'An empty project. Add the first file yourself.', icon: '▢', order: 0, category: 'General',
};

/** Where the template's files came from: upstream URL and the version they were taken at (`source` in template.json). */
export interface TemplateOrigin { url: string; version?: string }

/** Which half of the gallery lists the template; `label` names a template repository. */
export interface TemplateSource { kind: 'builtin' | 'repo' | 'venue' | 'kit'; label?: string }

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
  origin?: TemplateOrigin;
  source?: TemplateSource;
  /** Fetched-kit venues: the publisher the kit is downloaded from at create time. */
  kit?: { host: string; url: string; homepage?: string; termsUrl?: string };
}

const CATEGORIES: TemplateCategory[] = ['Journals', 'Conferences', 'Theses', 'Slides', 'General'];

/**
 * Every folder under `dir` with a template.json, as gallery entries. Shared by
 * the shipped templates/ folder and the template repositories: the manifest's
 * `source` (upstream URL + version) is exposed as `origin`, `source` says
 * which half of the gallery the entry belongs to. Hidden folders and broken
 * manifests are skipped; a missing category becomes General.
 */
export function scanTemplateDir(dir: string, opts: { idPrefix?: string; source: TemplateSource; accept?: (name: string) => boolean }): TemplateInfo[] {
  if (!fs.existsSync(dir)) return [];
  const out: TemplateInfo[] = [];
  const prefix = opts.idPrefix || '';
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    if (opts.accept && !opts.accept(name)) continue;
    const metaPath = path.join(dir, name, 'template.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object') throw new Error('not an object');
      const { source: origin, ...rest } = raw;
      const meta = rest as unknown as TemplateInfo;
      // The folder name is the id: a manifest cannot claim another folder's id
      // (or a path) and the seed always resolves to the folder that was listed.
      meta.id = prefix + name;
      meta.name = typeof meta.name === 'string' && meta.name.trim() ? meta.name : name;
      if (origin && typeof origin === 'object' && typeof (origin as TemplateOrigin).url === 'string') meta.origin = origin as TemplateOrigin;
      meta.source = opts.source;
      // The built-in id is taken: a directory claiming it would list twice and
      // could never be created (templateFiles answers {} for it).
      if (meta.id === BLANK_TEMPLATE.id) {
        console.warn(`${dir}/${name} uses the built-in template id "${BLANK_TEMPLATE.id}" and is ignored`);
        continue;
      }
      if (!meta.category || !CATEGORIES.includes(meta.category)) meta.category = 'General';
      out.push(meta);
    } catch (err: any) {
      console.warn(`[templates] ${metaPath} skipped: ${err.message}`);
    }
  }
  return out.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
}

/** Templates shipped as folders under templates/. */
export function listTemplates(): TemplateInfo[] {
  return [BLANK_TEMPLATE, ...scanTemplateDir(config.templatesDir, { source: { kind: 'builtin' } })];
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
  return [...folders, ...listRepoTemplates(), ...venues];
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
  if (id.startsWith(REPO_PREFIX)) return repoTemplateFiles(id);
  if (id.includes('..') || id.includes('/') || id.includes('\\') || id.startsWith('.')) throw new Error('bad template id');
  return templateFilesIn(path.join(config.templatesDir, id), id);
}

/** Every file under a template folder except the gallery bookkeeping; `id` only names the error. */
export function templateFilesIn(base: string, id: string): Record<string, Buffer> {
  if (!fs.existsSync(path.join(base, 'template.json'))) throw new Error(`unknown template: ${id}`);
  const files: Record<string, Buffer> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== '.git') walk(relPath); }
      else if (e.isFile() && !(rel === '' && NOT_SEEDED.has(e.name))) files[relPath] = fs.readFileSync(path.join(base, relPath));
    }
  };
  walk('');
  return files;
}

/** Values a template can ask for with `{{PROJECT_NAME}}`, `{{AUTHOR}}`, `{{DATE}}`, `{{YEAR}}`. */
export interface SeedContext { projectName?: string; author?: string; now?: Date }

const PLACEHOLDER_RE = /\{\{(PROJECT_NAME|AUTHOR|DATE|YEAR)\}\}/g;
const TEX_SPECIALS: Record<string, string> = { '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
/** A project name is prose; inside a .tex file its specials must not typeset as commands. */
export function latexEscape(s: string): string {
  return s.replace(/[\\&%$#_{}~^]/g, (c) => TEX_SPECIALS[c]);
}

/**
 * Substitute the placeholders in every text file of a seed (binaries untouched,
 * unknown `{{TOKENS}}` left as they are). Values are LaTeX-escaped in .tex,
 * .sty and .cls files and inserted verbatim elsewhere.
 */
export function applyPlaceholders(files: Record<string, Buffer>, ctx: SeedContext): Record<string, Buffer> {
  const now = ctx.now ?? new Date();
  const values: Record<string, string> = {
    PROJECT_NAME: ctx.projectName ?? '',
    AUTHOR: ctx.author ?? '',
    DATE: now.toISOString().slice(0, 10),
    YEAR: String(now.getUTCFullYear()),
  };
  const out: Record<string, Buffer> = {};
  for (const [rel, buf] of Object.entries(files)) {
    if (!isTextFile(rel)) { out[rel] = buf; continue; }
    const text = buf.toString('utf8');
    if (!PLACEHOLDER_RE.test(text)) { out[rel] = buf; continue; }
    PLACEHOLDER_RE.lastIndex = 0;
    const tex = /\.(tex|sty|cls)$/i.test(rel);
    out[rel] = Buffer.from(text.replace(PLACEHOLDER_RE, (_, key: string) => (tex ? latexEscape(values[key]) : values[key])), 'utf8');
  }
  return out;
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
export async function resolveTemplateSeed(id: string, ctx: SeedContext = {}): Promise<TemplateSeed> {
  const seed = await rawTemplateSeed(id);
  return { ...seed, files: applyPlaceholders(seed.files, ctx) };
}

async function rawTemplateSeed(id: string): Promise<TemplateSeed> {
  if (!id.startsWith(VENUE_PREFIX)) return { files: templateFiles(id) };
  const key = id.slice(VENUE_PREFIX.length);
  const installed = (await venueClasses(CATALOG_WAIT_MS)).some((c) => c.id === key);
  if (!installed) {
    const entry = venueKit(key);
    if (entry) return venueKitSeed(entry);
  }
  return { files: await venueTemplateFiles(id) };
}
