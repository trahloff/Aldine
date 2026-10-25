/**
 * Renders page 1 of every shipped template into TEMPLATE_PREVIEWS_DIR
 * (apps/server/assets/template-previews), through a running compiler, for the
 * New project chooser. Run it after editing anything under templates/ and
 * commit the result; test/template-previews-shipped.test.mjs fails until then.
 *
 *   DATA_DIR=$(pwd)/.data-previews PORT=4020 node apps/compiler/server.js
 *   DATA_DIR=$(pwd)/.data-previews COMPILER_URL=http://localhost:4020 npm run templates:previews
 *
 * DATA_DIR must be the directory the compiler reads. Use the compiler image
 * (docker compose) for images that match production exactly: it renders with
 * Ghostscript and carries every package the templates need.
 *
 *   --force   render every template, not only the missing or outdated ones
 *   --check   render nothing; exit 1 when any preview is missing or outdated
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { listTemplates } from '../src/templates.js';
import { previewSeed, storePreview, typesetPage1, versionOf } from '../src/templatepreviews.js';

const force = process.argv.includes('--force');
const checkOnly = process.argv.includes('--check');
const dir = config.templatePreviewsDir;

const current = (id: string, key: string) => {
  try {
    const side = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    return side.key === key && fs.existsSync(path.join(dir, `${id}.jpg`));
  } catch {
    return false;
  }
};

const templates = listTemplates().flatMap((t) => {
  const ver = versionOf(t);
  return ver ? [{ t, ...ver }] : [];
});
const shippedIds = new Set(templates.map(({ t }) => t.id));
let failed = 0;

for (const { t, raw, key } of templates) {
  if (!force && current(t.id, key)) { console.log(`  ${t.id}: current`); continue; }
  if (checkOnly) { console.error(`  ${t.id}: missing or outdated`); failed++; continue; }
  const out = await typesetPage1(previewSeed(t, raw), `"${t.id}"`);
  if ('error' in out) { console.error(`  ${t.id}: ${out.error}`); failed++; continue; }
  storePreview(dir, t.id, out.bytes, { key, w: out.w, h: out.h, v: out.v });
  console.log(`  ${t.id}: rendered ${out.w}x${out.h}, ${out.bytes.length} bytes`);
}

if (!checkOnly && fs.existsSync(dir)) {
  for (const name of fs.readdirSync(dir)) {
    const id = name.replace(/\.(jpg|json)$/, '');
    if (id !== name && !shippedIds.has(id)) {
      fs.rmSync(path.join(dir, name));
      console.log(`  ${name}: removed, no such template`);
    }
  }
}

if (failed) {
  console.error(checkOnly
    ? `\n${failed} preview(s) missing or outdated. Run npm run templates:previews with a compiler running.`
    : `\n${failed} template(s) could not be rendered.`);
  process.exit(1);
}
