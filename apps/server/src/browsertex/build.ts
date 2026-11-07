import path from 'node:path';
import { config } from '../config.js';
import { BrowserTexAssets } from './assets.js';
import { loadManifest } from './manifest.js';
import { PackageSource } from './packages.js';

let assets: BrowserTexAssets | null = null;

/** The build this server hands out; created on first use in browser mode. */
export function browserTexAssets(): BrowserTexAssets {
  if (!assets) {
    assets = new BrowserTexAssets(
      loadManifest(),
      process.env.ALDINE_BROWSER_TEX_PROFILE || 'recommended',
      process.env.ALDINE_BROWSER_TEX_BIBER !== '0',
      { bakedDir: process.env.ALDINE_BROWSER_TEX_DIR || undefined, cacheDir: path.join(config.cacheDir, 'browser-tex') },
    );
  }
  return assets;
}

const RETRY_MS = 60_000;

/** Locates or downloads the build in the background, retrying a failed
 *  download; typesetting reports "being prepared" until it is ready. */
export function prepareBrowserTex(): void {
  const a = browserTexAssets();
  const attempt = () => a.ready(console.log).then(() => packageSource()?.warm(), (err) => {
    console.error(`[aldine] browser TeX download failed (retrying in ${RETRY_MS / 1000}s): ${err.message}`);
    setTimeout(attempt, RETRY_MS).unref();
  });
  void attempt();
}

let packages: PackageSource | null | undefined;

/** TeX Live files beyond the served profile, fetched on demand; null when
 *  ALDINE_TEXLIVE_ONDEMAND=0 (the profile is then all the browser has). */
export function packageSource(): PackageSource | null {
  if (packages !== undefined) return packages;
  packages = process.env.ALDINE_TEXLIVE_ONDEMAND === '0' ? null : new PackageSource({
    mirror: process.env.ALDINE_TEXLIVE_MIRROR || 'https://mirror.ctan.org/systems/texlive/tlnet',
    release: browserTexAssets().manifest.texlive,
    cacheDir: path.join(config.cacheDir, 'texlive-packages'),
    maxCacheBytes: Number(process.env.ALDINE_TEXLIVE_CACHE_MAX_MB || 4096) * 1024 * 1024,
    maxPackageBytes: 200 * 1024 * 1024,
  });
  return packages;
}
