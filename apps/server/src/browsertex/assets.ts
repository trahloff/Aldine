import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { selectedFiles, type BrowserTexManifest } from './manifest.js';

/**
 * The browser TeX build on this server's disk. Each file is looked up in the
 * baked directory (an image that ships the build, read-only), then in the
 * download cache, and fetched into the cache when neither has it. A file
 * counts only when its sha256 matches the manifest: a truncated download or a
 * baked file from another build is never served.
 */

export interface AssetSources {
  /** Read-only directory with <version>/<file>, e.g. baked into an image. */
  bakedDir?: string;
  /** Writable directory the server downloads into: <cacheDir>/<version>/<file>. */
  cacheDir: string;
}

export type AssetState =
  | { state: 'ready' }
  | { state: 'downloading'; done: number; total: number }
  | { state: 'failed'; error: string };

/** sha256 is costly over 300 MB, so a verified file leaves a stamp of its size
 *  and mtime beside it, and a later boot trusts a file that still matches. */
const stampOf = (file: string) => `${file}.verified`;

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function verified(file: string, sha256: string, size: number, stampDir: string): Promise<boolean> {
  let st: fs.Stats;
  try { st = await fs.promises.stat(file); } catch { return false; }
  if (!st.isFile() || st.size !== size) return false;
  const stamp = path.join(stampDir, path.basename(stampOf(file)));
  const expected = `${sha256} ${st.size} ${st.mtimeMs}`;
  try { if ((await fs.promises.readFile(stamp, 'utf8')) === expected) return true; } catch { /* no stamp yet */ }
  if (await sha256File(file) !== sha256) return false;
  try { await fs.promises.writeFile(stamp, expected); } catch { /* a read-only stamp dir only costs a rehash next boot */ }
  return true;
}

/** Streams url into dest, refusing bytes that do not hash to sha256. */
async function download(url: string, dest: string, sha256: string, onBytes: (n: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url} answered HTTP ${res.status}`);
  const tmp = `${dest}.${process.pid}.part`;
  const hash = crypto.createHash('sha256');
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  body.on('data', (chunk: Buffer) => { hash.update(chunk); onBytes(chunk.length); });
  try {
    await pipeline(body, fs.createWriteStream(tmp));
    const got = hash.digest('hex');
    if (got !== sha256) throw new Error(`${url} has sha256 ${got}, the manifest expects ${sha256}`);
    await fs.promises.rename(tmp, dest);
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

export class BrowserTexAssets {
  private located = new Map<string, string>();
  private status: AssetState = { state: 'downloading', done: 0, total: 0 };
  private readying: Promise<void> | null = null;
  readonly files: string[];

  constructor(readonly manifest: BrowserTexManifest, readonly profile: string, biber: boolean, private sources: AssetSources) {
    this.files = selectedFiles(manifest, profile, biber);
  }

  state(): AssetState { return this.status; }

  /** Absolute path of a served file once it is verified, else null. */
  pathOf(name: string): string | null { return this.located.get(name) ?? null; }

  /** Locates or downloads every selected file; safe to call again after a failure. */
  ready(log: (line: string) => void = () => {}): Promise<void> {
    if (this.status.state === 'ready') return Promise.resolve();
    if (this.readying) return this.readying;
    this.readying = this.locateAll(log).finally(() => { this.readying = null; });
    return this.readying;
  }

  private async locateAll(log: (line: string) => void): Promise<void> {
    const { manifest, sources } = this;
    const cacheDir = path.join(sources.cacheDir, manifest.version);
    const missing: string[] = [];
    for (const name of this.files) {
      const { sha256, size } = manifest.files[name];
      const baked = sources.bakedDir ? path.join(sources.bakedDir, manifest.version, name) : null;
      // A baked file's stamp goes to the cache: the image layer is read-only.
      if (baked && await verified(baked, sha256, size, cacheDir).catch(() => false)) { this.located.set(name, baked); continue; }
      const cached = path.join(cacheDir, name);
      if (await verified(cached, sha256, size, cacheDir).catch(() => false)) { this.located.set(name, cached); continue; }
      missing.push(name);
    }
    if (!missing.length) { this.status = { state: 'ready' }; return; }
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const total = missing.reduce((n, name) => n + manifest.files[name].size, 0);
    let done = 0;
    this.status = { state: 'downloading', done, total };
    log(`[aldine] browser TeX: downloading ${missing.length} file(s), ${(total / 1e6).toFixed(0)} MB, of ${manifest.version} into ${cacheDir}`);
    try {
      for (const name of missing) {
        const f = manifest.files[name];
        const dest = path.join(cacheDir, name);
        await download(f.url ?? new URL(name, manifest.baseUrl).toString(), dest, f.sha256, (n) => {
          done += n;
          this.status = { state: 'downloading', done, total };
        });
        await verified(dest, f.sha256, f.size, cacheDir);
        this.located.set(name, dest);
      }
      this.status = { state: 'ready' };
      log(`[aldine] browser TeX: ${manifest.version} (${this.profile}) ready`);
    } catch (err: any) {
      this.status = { state: 'failed', error: err?.message ?? String(err) };
      throw err;
    }
  }
}

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
};

/** Content-Type for a served file: WebAssembly.compileStreaming refuses any
 *  other type for the .wasm, and importScripts any non-script type for a .js. */
export function assetType(name: string): string {
  return TYPES[path.extname(name)] ?? 'text/plain; charset=utf-8';
}
