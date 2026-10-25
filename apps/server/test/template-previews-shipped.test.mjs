/**
 * Every template under templates/ ships with page 1 rendered for the New
 * project chooser (apps/server/assets/template-previews), of its current
 * version. Editing a template without rendering it again fails here; the
 * running server would show a title-page placeholder instead.
 *
 * Fix: start a compiler and run `npm run templates:previews` (header of
 * apps/server/scripts/render-template-previews.ts), then commit the images.
 *
 * Venue tiles (an installed class under venues/, a fetched kit under kits/)
 * are rendered by the Template previews workflow with the compiler image.
 * Each one has an image or an entry in known-failures.json saying why not;
 * a kit's image is of its current registry entry or the kit is listed there.
 * An installed class's version depends on the image's catalog, which this
 * test cannot see, so only its image and sidecar are held to each other.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-template-previews-shipped-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.TEMPLATES_DIR;
delete process.env.TEMPLATE_PREVIEWS_DIR;
delete process.env.VENUES_FILE;

const { config } = await import('../src/config.ts');
const { listTemplates } = await import('../src/templates.ts');
const { thumbVersion } = await import('../src/thumbnail.ts');
const previews = await import('../src/templatepreviews.ts');
const { INSTALLED_VENUES } = await import('../src/catalog.ts');
const { venueKits } = await import('../src/venuekits.ts');

try {
  const shipped = listTemplates().filter((t) => previews.versionOf(t));
  check(shipped.length >= 4, 'the shipped templates are found');
  const loaded = previews.loadShippedPreviews();
  for (const t of shipped) {
    const { key } = previews.versionOf(t);
    const sidecar = path.join(config.templatePreviewsDir, `${t.id}.json`);
    check(fs.existsSync(sidecar), `${t.id}: a rendered preview exists (npm run templates:previews)`);
    const side = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    eq(side.key, key, `${t.id}: the preview is of the current files (npm run templates:previews)`);
    eq(thumbVersion(fs.readFileSync(path.join(config.templatePreviewsDir, `${t.id}.jpg`))), side.v, `${t.id}: the image is the one its sidecar names`);
    check(loaded.has(t.id), `${t.id}: the server serves it`);
  }
  const ids = new Set(shipped.map((t) => t.id));
  const subdirs = new Set(Object.values(previews.VENUE_PREVIEW_DIRS));
  for (const f of fs.readdirSync(config.templatePreviewsDir)) {
    if (f === previews.KNOWN_FAILURES_FILE || subdirs.has(f)) continue;
    check(ids.has(f.replace(/\.(jpg|json)$/, '')), `${f}: belongs to a shipped template`);
  }

  // ---- venues ----
  const failures = JSON.parse(fs.readFileSync(path.join(config.templatePreviewsDir, previews.KNOWN_FAILURES_FILE), 'utf8'));
  const kits = new Map(venueKits().map((e) => [e.id, e]));
  check(kits.size >= 20, 'the fetched venue kits are found');
  const defined = { venue: new Set(Object.keys(INSTALLED_VENUES)), kit: new Set(kits.keys()) };
  const rendered = { venue: [], kit: [] };
  const fix = 'run the Template previews workflow, or record the venue in known-failures.json';
  for (const kind of ['venue', 'kit']) {
    const dir = path.join(config.templatePreviewsDir, previews.VENUE_PREVIEW_DIRS[kind]);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const f of files) {
      const id = f.replace(/\.(jpg|json)$/, '');
      check(id !== f && defined[kind].has(id), `${previews.VENUE_PREVIEW_DIRS[kind]}/${f}: belongs to a ${kind}`);
    }
    for (const id of Object.keys(failures[kind] ?? {})) {
      check(defined[kind].has(id), `known-failures.json ${kind} "${id}": belongs to a ${kind}`);
      check(typeof failures[kind][id].reason === 'string' && failures[kind][id].reason, `known-failures.json ${kind} "${id}": says why`);
    }
    for (const id of defined[kind]) {
      const sidecar = path.join(dir, `${id}.json`);
      const listed = Object.prototype.hasOwnProperty.call(failures[kind] ?? {}, id);
      if (!fs.existsSync(sidecar)) {
        check(listed, `${kind} "${id}": a rendered preview exists or known-failures.json says why not (${fix})`);
        continue;
      }
      const side = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      eq(thumbVersion(fs.readFileSync(path.join(dir, `${id}.jpg`))), side.v, `${kind} "${id}": the image is the one its sidecar names`);
      if (kind === 'kit' && side.key !== previews.kitVersionKey(kits.get(id))) {
        check(listed, `kit "${id}": the preview is of the current registry entry (${fix})`);
        continue;
      }
      rendered[kind].push(id);
    }
  }
  console.log(`template-previews-shipped: ok (${shipped.map((t) => t.id).join(', ')}; ${rendered.venue.length} installed classes, ${rendered.kit.length} kits)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
