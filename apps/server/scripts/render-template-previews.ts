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
 * Venue tiles are rendered by .github/workflows/template-previews.yml with
 * the full TeX Live compiler image: a local TeX Live has another catalog, so
 * its venue images would be keyed to seeds no deployment creates.
 *
 *   --venues      also render the installed venue classes the compiler lists
 *   --kits        also render the fetched venue kits; this downloads every kit
 *                 from its publisher, as creating a project from it does
 *   --force       render every template, not only the missing or outdated ones
 *   --check       render nothing; exit 1 when any folder template's preview is
 *                 missing or outdated
 *   --summary F   append a Markdown report to F ($GITHUB_STEP_SUMMARY)
 *
 * A venue that does not typeset keeps the title-page placeholder and is
 * recorded in known-failures.json with the reason; only a folder template
 * that does not typeset fails the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { INSTALLED_VENUES, venueClasses } from '../src/catalog.js';
import { listTemplates } from '../src/templates.js';
import { venueKits, venueKitSeed } from '../src/venuekits.js';
import {
  KNOWN_FAILURES_FILE, VENUE_PREVIEW_DIRS, installedVersion, kitVersionKey, previewSeed, storePreview, typesetPage1, versionOf,
  type VenueKind,
} from '../src/templatepreviews.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const checkOnly = args.includes('--check');
const withVenues = args.includes('--venues');
const withKits = args.includes('--kits');
const summaryAt = args.indexOf('--summary');
const summaryFile = summaryAt >= 0 ? args[summaryAt + 1] : undefined;
const dir = config.templatePreviewsDir;

const current = (d: string, id: string, key: string) => {
  try {
    const side = JSON.parse(fs.readFileSync(path.join(d, `${id}.json`), 'utf8'));
    return side.key === key && fs.existsSync(path.join(d, `${id}.jpg`));
  } catch {
    return false;
  }
};

type Kind = 'template' | VenueKind;
type Outcome = { kind: Kind; id: string; name: string; result: 'current' | 'rendered' | 'failed'; reason?: string };
const outcomes: Outcome[] = [];
const note = (o: Outcome) => {
  outcomes.push(o);
  const line = `  ${o.kind === 'template' ? '' : `${o.kind}:`}${o.id}: ${o.reason ?? o.result}`;
  if (o.result === 'failed') console.error(line); else console.log(line);
};

// ---- folder templates ----

const templates = listTemplates().flatMap((t) => {
  const ver = versionOf(t);
  return ver ? [{ t, ...ver }] : [];
});
const shippedIds = new Set(templates.map(({ t }) => t.id));
let failed = 0;

for (const { t, raw, key } of templates) {
  if (!force && current(dir, t.id, key)) { note({ kind: 'template', id: t.id, name: t.name, result: 'current' }); continue; }
  if (checkOnly) { console.error(`  ${t.id}: missing or outdated`); failed++; continue; }
  const out = await typesetPage1(previewSeed(t, raw), `"${t.id}"`);
  if ('error' in out) {
    note({ kind: 'template', id: t.id, name: t.name, result: 'failed', reason: out.error });
    failed++;
    continue;
  }
  storePreview(dir, t.id, out.bytes, { key, w: out.w, h: out.h, v: out.v });
  note({ kind: 'template', id: t.id, name: t.name, result: 'rendered' });
}

// ---- venues ----

type Failures = Record<VenueKind, Record<string, { key?: string; reason: string }>>;
const failuresPath = path.join(dir, KNOWN_FAILURES_FILE);
const failures: Failures = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(failuresPath, 'utf8'));
    return { venue: raw.venue ?? {}, kit: raw.kit ?? {} };
  } catch {
    return { venue: {}, kit: {} };
  }
})();

/** Render one venue tile into its subdirectory and keep known-failures.json in step. */
async function renderVenue(kind: VenueKind, id: string, name: string, key: string, files: () => Promise<Record<string, Buffer> | { error: string }>) {
  const d = path.join(dir, VENUE_PREVIEW_DIRS[kind]);
  if (!force && current(d, id, key)) {
    delete failures[kind][id];
    note({ kind, id, name, result: 'current' });
    return;
  }
  const seed = await files();
  const out = 'error' in seed ? seed : await typesetPage1(previewSeed({ name }, seed), `${kind} "${id}"`);
  if ('error' in out) {
    failures[kind][id] = { key, reason: out.error };
    note({ kind, id, name, result: 'failed', reason: out.error });
    return;
  }
  storePreview(d, id, out.bytes, { key, w: out.w, h: out.h, v: out.v });
  delete failures[kind][id];
  note({ kind, id, name, result: 'rendered' });
}

if (!checkOnly && withVenues) {
  const classes = await venueClasses();
  if (!classes.length) {
    console.error(`  the compiler at ${config.compilerUrl} lists no venue classes; venue previews are left as they are`);
  } else {
    for (const id of Object.keys(INSTALLED_VENUES)) {
      const cls = classes.find((c) => c.id === id);
      const ver = cls ? installedVersion(cls) : null;
      if (!ver) {
        const reason = 'the class is not installed in the compiler image';
        failures.venue[id] = { reason };
        note({ kind: 'venue', id, name: INSTALLED_VENUES[id].name, result: 'failed', reason });
        continue;
      }
      await renderVenue('venue', id, ver.name, ver.key, async () => ver.raw);
    }
  }
}

if (!checkOnly && withKits) {
  for (const entry of venueKits()) {
    await renderVenue('kit', entry.id, entry.name, kitVersionKey(entry), async () => {
      if (entry.kit.manual) return { error: `the user downloads the kit by hand (${entry.kit.host} does not allow automated downloads)` };
      const seed = await venueKitSeed(entry);
      return seed.venueKit.ok ? seed.files : { error: `the kit could not be downloaded (${seed.venueKit.reason})` };
    });
  }
}

// ---- stale files ----

if (!checkOnly && fs.existsSync(dir)) {
  for (const name of fs.readdirSync(dir)) {
    if (name === KNOWN_FAILURES_FILE) continue;
    const id = name.replace(/\.(jpg|json)$/, '');
    if (id !== name && !shippedIds.has(id)) {
      fs.rmSync(path.join(dir, name));
      console.log(`  ${name}: removed, no such template`);
    }
  }
  const defined: Record<VenueKind, Set<string>> = {
    venue: new Set(Object.keys(INSTALLED_VENUES)),
    kit: new Set(venueKits().map((e) => e.id)),
  };
  for (const kind of Object.keys(VENUE_PREVIEW_DIRS) as VenueKind[]) {
    for (const id of Object.keys(failures[kind])) if (!defined[kind].has(id)) delete failures[kind][id];
    const d = path.join(dir, VENUE_PREVIEW_DIRS[kind]);
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      const id = name.replace(/\.(jpg|json)$/, '');
      if (id === name || !defined[kind].has(id)) {
        fs.rmSync(path.join(d, name), { recursive: true });
        console.log(`  ${VENUE_PREVIEW_DIRS[kind]}/${name}: removed, no such venue`);
      }
    }
  }
  if (withVenues || withKits || fs.existsSync(failuresPath)) {
    const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    fs.writeFileSync(failuresPath, `${JSON.stringify({ venue: sorted(failures.venue), kit: sorted(failures.kit) }, null, 2)}\n`);
  }
}

// ---- report ----

if (summaryFile) {
  const label: Record<Kind, string> = { template: 'Template', venue: 'Installed class', kit: 'Fetched kit' };
  const count = (r: Outcome['result']) => outcomes.filter((o) => o.result === r).length;
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  let md = `## Template previews\n\n${count('rendered')} rendered, ${count('current')} already current, ${count('failed')} without a preview.\n\n`;
  const bad = outcomes.filter((o) => o.result === 'failed');
  if (bad.length) {
    md += '### Kept the placeholder\n\n| Kind | Template | Why |\n| --- | --- | --- |\n';
    for (const o of bad) md += `| ${label[o.kind]} | ${cell(o.name)} (\`${o.id}\`) | ${cell(o.reason || '')} |\n`;
    md += '\n';
  }
  const done = outcomes.filter((o) => o.result === 'rendered');
  if (done.length) md += `### Rendered\n\n${done.map((o) => `- ${label[o.kind]}: ${o.name} (\`${o.id}\`)`).join('\n')}\n`;
  fs.appendFileSync(summaryFile, `${md}\n`);
}

if (failed) {
  console.error(checkOnly
    ? `\n${failed} preview(s) missing or outdated. Run npm run templates:previews with a compiler running.`
    : `\n${failed} template(s) could not be rendered.`);
}
process.exit(failed ? 1 : 0);
