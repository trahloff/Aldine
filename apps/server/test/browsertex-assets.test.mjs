/**
 * The browser TeX build on disk: a file is served only once its sha256
 * matches the manifest, a baked copy wins over a download, a download with
 * the wrong bytes is refused and leaves nothing behind, and a manifest whose
 * names could escape the asset directory never loads.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq, throws } from './assert.mjs';
import { BrowserTexAssets } from '../src/browsertex/assets.ts';
import { validateManifest, selectedFiles, DEFAULT_MANIFEST } from '../src/browsertex/manifest.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-browsertex-assets-'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const bodies = { 'core.js': 'core', 'tl.js': 'bundle-js', 'tl.data': 'bundle-data', 'LICENSE': 'agpl' };
let served = {};
const hits = [];
const server = http.createServer((req, res) => {
  const name = req.url.slice(1);
  hits.push(name);
  if (!(name in served)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200);
  res.end(served[name]);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;

const manifest = (over = {}) => validateManifest({
  version: 'test-1',
  texlive: '2026',
  baseUrl,
  files: Object.fromEntries(Object.entries(bodies).map(([k, v]) => [k, { sha256: sha(v), size: v.length }])),
  core: ['core.js'],
  profiles: { small: ['tl.js', 'tl.data'] },
  biber: [],
  licenses: ['LICENSE'],
  ...over,
});

try {
  // ---- the pinned default is well-formed ----
  validateManifest(DEFAULT_MANIFEST);
  eq(selectedFiles(DEFAULT_MANIFEST, 'recommended', false).filter((f) => f.startsWith('texlive-')), ['texlive-recommended.js', 'texlive-recommended.data'], 'one profile is served');
  check(selectedFiles(DEFAULT_MANIFEST, 'basic', true).includes('biber.wasm'), 'biber files are served when on');
  await throws(() => selectedFiles(DEFAULT_MANIFEST, 'full', true), 'is not one of', 'an unknown profile is refused');

  // ---- a manifest naming paths is refused ----
  await throws(() => manifest({ files: { '../x': { sha256: sha('x'), size: 1 } }, core: [], profiles: { small: ['x.js'] }, licenses: [] }), 'not a plain name', 'a file name with a slash is refused');
  await throws(() => manifest({ version: '../v' }), 'plain name', 'a version with a slash is refused');
  await throws(() => manifest({ core: ['nope.js'] }), 'without its checksum', 'a listed file needs a checksum');

  // ---- download, verify, then reuse without a second fetch ----
  served = { ...bodies };
  const cacheDir = path.join(tmp, 'cache');
  const a = new BrowserTexAssets(manifest(), 'small', false, { cacheDir });
  await a.ready();
  eq(a.state(), { state: 'ready' }, 'ready after the download');
  eq(fs.readFileSync(a.pathOf('tl.data'), 'utf8'), 'bundle-data', 'the bundle is on disk');
  check(a.pathOf('core.js').startsWith(path.join(cacheDir, 'test-1')), 'files land under the version');
  hits.length = 0;
  const again = new BrowserTexAssets(manifest(), 'small', false, { cacheDir });
  await again.ready();
  eq(hits, [], 'a verified cache is not fetched again');

  // ---- a changed file on disk is fetched again ----
  fs.writeFileSync(again.pathOf('core.js'), 'tampered');
  const healed = new BrowserTexAssets(manifest(), 'small', false, { cacheDir });
  await healed.ready();
  eq(hits, ['core.js'], 'only the file that no longer matches is fetched');
  eq(fs.readFileSync(healed.pathOf('core.js'), 'utf8'), 'core', 'and it is replaced');

  // ---- wrong bytes are refused and leave no file ----
  served = { ...bodies, 'tl.data': 'something else' };
  const badDir = path.join(tmp, 'bad');
  const bad = new BrowserTexAssets(manifest(), 'small', false, { cacheDir: badDir });
  await throws(() => bad.ready(), 'the manifest expects', 'a mismatching download fails');
  check(bad.state().state === 'failed', 'and the state says so');
  check(bad.pathOf('tl.data') === null, 'the bad file is not served');
  eq(fs.readdirSync(path.join(badDir, 'test-1')).filter((f) => f.startsWith('tl.data')), [], 'nothing of it stays on disk');

  // ---- a baked copy is used, and a baked copy with other bytes is not ----
  const baked = path.join(tmp, 'baked', 'test-1');
  fs.mkdirSync(baked, { recursive: true });
  for (const [k, v] of Object.entries(bodies)) fs.writeFileSync(path.join(baked, k), v);
  fs.writeFileSync(path.join(baked, 'LICENSE'), 'gpl!');
  served = { ...bodies };
  hits.length = 0;
  const b = new BrowserTexAssets(manifest(), 'small', false, { bakedDir: path.join(tmp, 'baked'), cacheDir: path.join(tmp, 'cache2') });
  await b.ready();
  check(b.pathOf('tl.data').startsWith(baked), 'a matching baked file is served from the image');
  eq(hits, ['LICENSE'], 'only the baked file that does not match is downloaded');

  console.log('browsertex-assets: all checks passed');
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
