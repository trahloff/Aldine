/**
 * Downloads and verifies the browser TeX build ahead of time, e.g. into an
 * image layer so the server never fetches at boot:
 *
 *   node dist/browsertex/fetch.js --into /srv/browser-tex [--profile recommended] [--no-biber]
 *
 * Files land in <into>/<manifest version>/, the layout ALDINE_BROWSER_TEX_DIR
 * expects. ALDINE_BROWSER_TEX_MANIFEST selects another build, as at runtime.
 */
import { BrowserTexAssets } from './assets.js';
import { loadManifest } from './manifest.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const into = arg('into');
if (!into) {
  console.error('usage: fetch.js --into <dir> [--profile basic|recommended|extra] [--no-biber]');
  process.exit(2);
}
const profile = arg('profile') || process.env.ALDINE_BROWSER_TEX_PROFILE || 'recommended';
const biber = !process.argv.includes('--no-biber') && process.env.ALDINE_BROWSER_TEX_BIBER !== '0';
const assets = new BrowserTexAssets(loadManifest(), profile, biber, { cacheDir: into });
let lastShown = 0;
const timer = setInterval(() => {
  const s = assets.state();
  if (s.state === 'downloading' && s.total && s.done - lastShown > 25e6) {
    lastShown = s.done;
    console.log(`  ${(s.done / 1e6).toFixed(0)} / ${(s.total / 1e6).toFixed(0)} MB`);
  }
}, 1000);
assets.ready(console.log).then(() => {
  clearInterval(timer);
  console.log(`browser TeX ${assets.manifest.version} (${profile}${biber ? ', biber' : ''}) is in ${into}/${assets.manifest.version}`);
}, (err) => {
  clearInterval(timer);
  console.error(`browser TeX fetch failed: ${err.message}`);
  process.exit(1);
});
