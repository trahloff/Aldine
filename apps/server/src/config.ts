import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

export const config = {
  port: Number(process.env.PORT || 3000),
  /** Root for project git repos: <dataDir>/projects/<id>. Shared with the compiler. */
  dataDir: process.env.DATA_DIR || path.join(repoRoot, '.data'),
  /**
   * Secrets & project metadata. MUST live outside dataDir so the compiler
   * container (which mounts dataDir) can never read Zotero API keys via \openin.
   */
  metaRoot: process.env.META_DIR || path.join(repoRoot, '.secrets'),
  /** Shared with compiler service; PDFs land here */
  cacheDir: process.env.CACHE_DIR || path.join(repoRoot, '.cache/latex'),
  compilerUrl: process.env.COMPILER_URL || 'http://localhost:4020',
  /** Built-in + user plugins */
  pluginsDir: process.env.PLUGINS_DIR || path.join(repoRoot, 'plugins'),
  templatesDir: process.env.TEMPLATES_DIR || path.join(repoRoot, 'templates'),
  /**
   * Registry of venue kits fetched from publishers. Deliberately not derived
   * from templatesDir: the e2e suite and the unit tests point it at a fixture
   * registry while still serving the repo's real folder templates.
   */
  venuesFile: process.env.VENUES_FILE || path.join(repoRoot, 'templates', 'venues.json'),
  webDist: process.env.WEB_DIST || path.join(repoRoot, 'apps/web/dist'),
};

export const projectsDir = path.join(config.dataDir, 'projects');
export const worktreesDir = path.join(config.dataDir, 'worktrees');
export const metaDir = path.join(config.metaRoot, 'meta');

for (const d of [projectsDir, worktreesDir, metaDir, config.cacheDir]) {
  fs.mkdirSync(d, { recursive: true });
}

// Migrate meta from the old in-dataDir location (pre-security-fix) if present.
// Copy+unlink (not rename) since the new location may be a different volume.
const legacyMeta = path.join(config.dataDir, 'meta');
if (fs.existsSync(legacyMeta) && path.resolve(legacyMeta) !== path.resolve(metaDir)) {
  for (const f of fs.readdirSync(legacyMeta)) {
    const src = path.join(legacyMeta, f);
    const dest = path.join(metaDir, f);
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
  try { fs.rmdirSync(legacyMeta); } catch { /* not empty; leave it */ }
}
