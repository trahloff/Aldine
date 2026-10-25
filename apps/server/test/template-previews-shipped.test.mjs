/**
 * Every template under templates/ ships with page 1 rendered for the New
 * project chooser (apps/server/assets/template-previews), of its current
 * version. Editing a template without rendering it again fails here; the
 * running server would show a title-page placeholder instead.
 *
 * Fix: start a compiler and run `npm run templates:previews` (header of
 * apps/server/scripts/render-template-previews.ts), then commit the images.
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

const { config } = await import('../src/config.ts');
const { listTemplates } = await import('../src/templates.ts');
const { thumbVersion } = await import('../src/thumbnail.ts');
const previews = await import('../src/templatepreviews.ts');

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
  for (const f of fs.readdirSync(config.templatePreviewsDir)) {
    check(ids.has(f.replace(/\.(jpg|json)$/, '')), `${f}: belongs to a shipped template`);
  }
  console.log(`template-previews-shipped: ok (${shipped.map((t) => t.id).join(', ')})`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
