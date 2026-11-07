import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * TeX Live files on demand, for the browser's TeX: the build ships one
 * profile, and a file it lacks is asked for here as GET <endpoint>/<kpathsea
 * format>/<name> while TeX runs. The answer comes from the TeX Live package
 * that holds the file: the package database (texlive.tlpdb) names it, its
 * archive is fetched from a mirror once, checked against the database's
 * sha512 and unpacked into the cache, and every later request is a file read.
 */

/** kpathsea's format numbers and the suffixes it tries for a bare name. */
const SUFFIXES: Record<number, string[]> = {
  0: ['.gf'], 1: ['.pk'], 3: ['.tfm'], 4: ['.afm'], 6: ['.bib'], 7: ['.bst'], 10: ['.fmt'], 11: ['.map'],
  13: ['.mf'], 16: ['.mp'], 20: ['.ofm', '.tfm'], 23: ['.ovf', '.vf'],
  26: ['.tex', '.sty', '.cls', '.fd', '.def', '.cfg', '.ltx', '.clo', '.ldf', '.bbx', '.cbx', '.lbx', '.dbx'],
  32: ['.pfb', '.pfa'], 33: ['.vf'], 35: ['.ist'], 36: ['.ttf', '.ttc'], 44: ['.enc'], 46: ['.sfd'], 47: ['.otf'],
  51: ['.lua', '.luc'], 52: ['.fea'], 53: ['.cid', '.cidmap'],
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/;

interface Pkg { name: string; size: number; sha512: string; files: string[]; license: string | null; version: string | null; home: string | null }

export interface PackageSourceOptions {
  /** A tlnet directory: <mirror>/tlpkg/texlive.tlpdb and <mirror>/archive/<pkg>.tar.xz. */
  mirror: string;
  /** TeX Live release the browser's build is; a mirror of another release is refused. */
  release: string;
  cacheDir: string;
  /** Unpacked packages beyond this are not fetched (the cache stays as it is). */
  maxCacheBytes: number;
  /** A package archive larger than this is not fetched. */
  maxPackageBytes: number;
  fetchImpl?: typeof fetch;
}

/** Parses texlive.tlpdb: runfile basename → package, and each package's archive. */
export function parseTlpdb(text: string): { release: string | null; packages: Map<string, Pkg>; byFile: Map<string, { pkg: string; file: string }[]> } {
  const packages = new Map<string, Pkg>();
  const byFile = new Map<string, { pkg: string; file: string }[]>();
  let release: string | null = null;
  let cur: Pkg | null = null;
  let inRunfiles = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('name ')) {
      cur = { name: line.slice(5).trim(), size: 0, sha512: '', files: [], license: null, version: null, home: null };
      inRunfiles = false;
      // Platform binaries (pkg.x86_64-linux) are of no use to a browser.
      if (!cur.name.includes('.')) packages.set(cur.name, cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith(' ')) {
      if (!inRunfiles) continue;
      const file = line.trim().split(' ')[0];
      cur.files.push(file);
      const base = path.posix.basename(file).toLowerCase();
      const list = byFile.get(base) ?? [];
      list.push({ pkg: cur.name, file });
      byFile.set(base, list);
      continue;
    }
    inRunfiles = line.startsWith('runfiles ');
    if (line.startsWith('containersize ')) cur.size = Number(line.slice(14));
    else if (line.startsWith('containerchecksum ')) cur.sha512 = line.slice(18).trim();
    else if (line.startsWith('catalogue-license ')) cur.license = line.slice(18).trim() || null;
    else if (line.startsWith('catalogue-version ')) cur.version = line.slice(18).trim() || null;
    else if (line.startsWith('catalogue-contact-home ')) cur.home = line.slice(23).trim() || null;
    else if (cur.name === '00texlive.config' && line.startsWith('depend release/')) release = line.slice(15).trim();
  }
  return { release, packages, byFile };
}

/** Where a tlpdb runfile lands once its archive is unpacked into <dir>. */
const unpackedAt = (dir: string, file: string) => path.join(dir, file.startsWith('RELOC/') ? file.slice(6) : file);

export class PackageSource {
  private db: ReturnType<typeof parseTlpdb> | null = null;
  private dbLoading: Promise<void> | null = null;
  private mirrorBase = '';
  private fetching = new Map<string, Promise<void>>();
  private misses = new Set<string>();
  private cacheBytes = -1;

  constructor(private opts: PackageSourceOptions) {}

  private get fetchImpl() { return this.opts.fetchImpl ?? fetch; }
  private get pkgDir() { return path.join(this.opts.cacheDir, this.opts.release, 'packages'); }

  /** The package database, fetched once; the mirror a redirect picked is kept,
   *  so archives come from the same mirror (and sync state) as the database. */
  private loadDb(): Promise<void> {
    if (this.db) return Promise.resolve();
    this.dbLoading ??= (async () => {
      const dir = path.join(this.opts.cacheDir, this.opts.release);
      fs.mkdirSync(dir, { recursive: true });
      const cached = path.join(dir, 'texlive.tlpdb');
      const mirrorFile = path.join(dir, 'mirror');
      let text: string;
      if (fs.existsSync(cached) && fs.existsSync(mirrorFile)) {
        text = fs.readFileSync(cached, 'utf8');
        this.mirrorBase = fs.readFileSync(mirrorFile, 'utf8').trim();
      } else {
        const url = `${this.opts.mirror.replace(/\/+$/, '')}/tlpkg/texlive.tlpdb`;
        const res = await this.fetchImpl(url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
        text = await res.text();
        this.mirrorBase = (res.url || url).replace(/\/tlpkg\/texlive\.tlpdb$/, '');
        const parsed = parseTlpdb(text);
        if (parsed.release !== this.opts.release) {
          throw new Error(`${this.opts.mirror} carries TeX Live ${parsed.release ?? 'of an unknown release'}, the browser's TeX is ${this.opts.release} — set ALDINE_TEXLIVE_MIRROR to a ${this.opts.release} tlnet (after its release year, a historic archive's tlnet-final)`);
        }
        fs.writeFileSync(`${cached}.tmp`, text);
        fs.renameSync(`${cached}.tmp`, cached);
        fs.writeFileSync(mirrorFile, this.mirrorBase);
      }
      this.db = parseTlpdb(text);
    })().finally(() => { this.dbLoading = null; });
    return this.dbLoading;
  }

  /** The package and runfile for a kpathsea request, or null. */
  private locate(name: string, format: number): { pkg: Pkg; file: string } | null {
    const db = this.db!;
    const candidates = [name, ...(path.extname(name) ? [] : (SUFFIXES[format] ?? []).map((s) => name + s))];
    const suffixes = SUFFIXES[format];
    for (const c of candidates) {
      const hits = db.byFile.get(c.toLowerCase());
      if (!hits) continue;
      // A name several packages carry: the one under the tree this format searches.
      const pick = hits.find((h) => format === 26 ? /\/tex\//.test(h.file) : format === 3 ? /\/tfm\//.test(h.file) : true) ?? hits[0];
      const pkg = db.packages.get(pick.pkg);
      if (pkg && (!suffixes || suffixes.includes(path.extname(c).toLowerCase()) || c === name)) return { pkg, file: pick.file };
    }
    return null;
  }

  private usedBytes(): number {
    if (this.cacheBytes >= 0) return this.cacheBytes;
    let n = 0;
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) n += fs.statSync(p).size;
      }
    };
    try { walk(this.pkgDir); } catch { /* nothing yet */ }
    this.cacheBytes = n;
    return n;
  }

  /** Downloads, checks and unpacks a package once; concurrent callers share it. */
  private ensurePackage(pkg: Pkg): Promise<void> {
    const dir = path.join(this.pkgDir, pkg.name);
    if (fs.existsSync(path.join(dir, '.complete'))) return Promise.resolve();
    let p = this.fetching.get(pkg.name);
    if (p) return p;
    p = (async () => {
      if (pkg.size > this.opts.maxPackageBytes) throw new Error(`package ${pkg.name} is ${pkg.size} bytes, over the per-package limit`);
      if (this.usedBytes() + pkg.size * 4 > this.opts.maxCacheBytes) throw new Error('the package cache is full');
      const url = `${this.mirrorBase}/archive/${pkg.name}.tar.xz`;
      const res = await this.fetchImpl(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
      const archive = Buffer.from(await res.arrayBuffer());
      const sum = crypto.createHash('sha512').update(archive).digest('hex');
      if (pkg.sha512 && sum !== pkg.sha512) throw new Error(`${url} does not match the package database's checksum`);
      const tmp = `${dir}.${process.pid}.tmp`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      await untarXz(archive, tmp);
      fs.writeFileSync(path.join(tmp, '.complete'), '');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
      this.cacheBytes = -1;
      console.log(`[aldine] TeX Live package ${pkg.name} fetched for the browser's TeX (${Math.round(pkg.size / 1024)} KB)`);
    })().finally(() => { this.fetching.delete(pkg.name); });
    return p;
  }

  /** For each file name TeX Live carries as a runfile, the package that holds
   *  it and that package's catalogue entry; names it lacks are left out. */
  async locateFiles(names: string[]): Promise<Map<string, { pkg: string; license: string | null; version: string | null; home: string | null }>> {
    await this.loadDb();
    const db = this.db!;
    const out = new Map<string, { pkg: string; license: string | null; version: string | null; home: string | null }>();
    for (const name of names) {
      const hit = db.byFile.get(name.toLowerCase())?.find((h) => /\/tex\//.test(h.file));
      const pkg = hit && db.packages.get(hit.pkg);
      if (pkg) out.set(name, { pkg: pkg.name, license: pkg.license, version: pkg.version, home: pkg.home });
    }
    return out;
  }

  /** Loads the package database ahead of the first request, which TeX makes
   *  synchronously with a 30 s timeout: a cold database alone can take that. */
  warm(): void {
    this.loadDb().catch((err) => console.warn(`[aldine] TeX Live package database not loaded (retried on first use): ${err.message}`));
  }

  /** The file kpathsea asked for, on disk, or null when TeX Live has none. */
  async resolve(format: number, name: string): Promise<string | null> {
    if (!SAFE_NAME.test(name) || !Number.isInteger(format) || format < 0 || format > 99) return null;
    const key = `${format}/${name}`;
    if (this.misses.has(key)) return null;
    await this.loadDb();
    const hit = this.locate(name, format);
    if (!hit) {
      if (this.misses.size < 100_000) this.misses.add(key);
      return null;
    }
    await this.ensurePackage(hit.pkg);
    const file = unpackedAt(path.join(this.pkgDir, hit.pkg.name), hit.file);
    const root = path.join(this.pkgDir, hit.pkg.name) + path.sep;
    try {
      const real = fs.realpathSync(file);
      return real.startsWith(fs.realpathSync(root) + path.sep) && fs.lstatSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  }
}

function tar(args: string[], input: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tar could not read the package: ${err.trim() || `exit ${code}`}`))));
    child.stdin.end(input);
  });
}

/**
 * Unpacks a .tar.xz with the system's tar (Node has no xz decoder). The
 * archive comes from a mirror, so nothing in it may land outside `into` or
 * point there: names are checked before unpacking (busybox tar, the app
 * image's, does not refuse ".." itself) and links are removed after.
 */
async function untarXz(archive: Buffer, into: string): Promise<void> {
  const names = (await tar(['-tJf', '-'], archive)).split('\n').filter(Boolean);
  const bad = names.find((n) => n.startsWith('/') || n.split('/').includes('..'));
  if (bad) throw new Error(`the package names a file outside itself (${bad})`);
  await tar(['-xJf', '-', '-C', into, '--no-same-owner', '--no-same-permissions'], archive);
  const prune = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) fs.rmSync(p, { force: true });
      else if (e.isDirectory()) prune(p);
    }
  };
  prune(into);
}
