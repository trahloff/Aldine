/**
 * The shipped registry, templates/venues.json. Nothing here fetches anything:
 * this is the load-time gate the server applies at boot, run against the real
 * file so a bad entry fails CI rather than disappearing from the gallery with
 * a warning nobody reads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-venue-registry-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
// No test hooks: the shipped registry must pass the production rules, where
// only https is fetchable.
delete process.env.ALDINE_TEST_HOOKS;
delete process.env.VENUES_FILE;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const file = path.join(repoRoot, 'templates', 'venues.json');
check(fs.existsSync(file), 'templates/venues.json is the registry the server loads');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
check(Array.isArray(raw.venues) && raw.venues.length > 0, 'the registry carries a non-empty venues array');

const kits = await import('../src/venuekits.ts');
const loaded = kits.venueKits();
eq(loaded.length, raw.venues.length, 'every entry in the file passes validation (none is dropped at load)');

const ids = loaded.map((e) => e.id);
eq(ids.length, new Set(ids).size, 'venue ids are unique');

for (const e of loaded) {
  const where = `venue "${e.id}"`;
  check(kits.entryProblem(e) === null, `${where} passes the load-time gate`);
  check(['Journals', 'Conferences', 'Theses', 'Slides', 'General'].includes(e.category), `${where} has a gallery category`);
  check(new URL(e.homepage).protocol === 'https:', `${where} has an https homepage`);
  check(!!e.main || (e.preamble || []).length > 0, `${where} has either a main file or a preamble`);
  check(!!e.documentClass, `${where} names a document class`);
  const urls = e.kit.url ? [e.kit.url] : e.kit.urls;
  for (const u of urls) {
    check(new URL(u).protocol === 'https:', `${where}: ${u} is https`);
    eq(new URL(u).host, e.kit.host, `${where}: the kit URL is on the host the entry allows`);
  }
  if (e.kit.url) {
    check((e.kit.take || []).some((g) => !/[*?]/.test(g)), `${where} names at least one exact file to take`);
  }
  // The tile links the venue's own terms; that is all Aldine can say about a
  // publisher kit it never redistributes.
  if (e.termsUrl) check(new URL(e.termsUrl).protocol === 'https:', `${where} has an https termsUrl`);
}

// An installed class that still claims a venue the registry now ships on its
// own tile puts two tiles for the same submission in the gallery, with nothing
// on either to choose between them. Dedup is by id, so only the descriptions
// can say this wrong.
const { INSTALLED_VENUES } = await import('../src/catalog.ts');
for (const e of loaded) {
  for (const [id, meta] of Object.entries(INSTALLED_VENUES)) {
    if (id === e.id) continue;
    check(!meta.description.includes(e.name),
      `the installed "${id}" description claims ${e.name}, which has its own fetched tile: "${meta.description}"`);
  }
}

const tiles = kits.venueKitTemplates();
eq(tiles.length, loaded.length, 'every registry entry becomes a gallery tile');
check(tiles.every((t) => t.kit && t.kit.host && t.kit.url), 'every fetched tile says where its kit comes from');
check(tiles.every((t) => t.id.startsWith('venue:')), 'fetched tiles live in the venue id space');

// A kit unpacked into the repo would ship a publisher file with Aldine. Every
// path under templates/ is either the registry or part of a folder template.
const stray = [];
for (const name of fs.readdirSync(path.join(repoRoot, 'templates'), { withFileTypes: true })) {
  if (name.isFile()) { if (name.name !== 'venues.json') stray.push(name.name); continue; }
  if (!fs.existsSync(path.join(repoRoot, 'templates', name.name, 'template.json'))) stray.push(`${name.name}/`);
}
eq(stray, [], 'nothing but folder templates and the registry lives under templates/');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`venue registry: ${loaded.length} venues checked, all valid`);
