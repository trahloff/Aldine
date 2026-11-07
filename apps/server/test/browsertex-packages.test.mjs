/**
 * TeX Live files on demand for the browser's TeX: a file is served from the
 * package the database names, fetched once and checked against the
 * database's sha512; a mirror of another release, an archive with other
 * bytes, one that names paths outside itself or carries links, and names
 * that are not file names are all refused.
 *
 * The mirror is a local server with archives made by the system's tar.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { check, eq, throws } from './assert.mjs';
import { PackageSource, parseTlpdb } from '../src/browsertex/packages.ts';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-browsertex-packages-')));

/** A .tar.xz of `files` ({path: content}), plus `links` ({path: target}). */
function archive(name, files, links = {}, extraArgs = []) {
  const dir = path.join(tmp, 'src', name);
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  for (const [p, target] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.symlinkSync(target, path.join(dir, p));
  }
  const out = path.join(tmp, `${name}.tar.xz`);
  execFileSync('tar', ['-cJf', out, '-C', dir, ...extraArgs, '.']);
  return fs.readFileSync(out);
}
const sha512 = (b) => crypto.createHash('sha512').update(b).digest('hex');

const archives = {
  pgf: archive('pgf', { 'tex/generic/pgf/frontendlayer/tikz.code.tex': '% tikz', 'tex/latex/pgf/frontendlayer/tikz.sty': '\\ProvidesPackage{tikz}' }),
  cmfonts: archive('cmfonts', { 'texmf-dist/fonts/tfm/public/cm/cmr10.tfm': 'tfm-bytes' }),
  tampered: archive('tampered', { 'tex/latex/tampered/tampered.sty': 'x' }),
  linked: archive('linked', { 'tex/latex/linked/real.sty': 'ok' }, { 'tex/latex/linked/linked.sty': '/etc/passwd' }),
};
// An archive whose member climbs out with "..": made by hand (tar refuses to).
const evilDir = path.join(tmp, 'src', 'evil');
fs.mkdirSync(path.join(evilDir, 'a'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'src', 'escaped.sty'), 'escaped');
archives.evil = (() => {
  const out = path.join(tmp, 'evil.tar.xz');
  execFileSync('tar', ['-cJf', out, '-C', evilDir, '--absolute-names', 'a/../../escaped.sty']);
  return fs.readFileSync(out);
})();

const entry = (name, files, buf, reloc = true) => [
  `name ${name}`, 'category Package', ...(reloc ? ['relocated 1'] : []), 'catalogue-license lppl1.3c', 'catalogue-version 1.0',
  `containersize ${buf.length}`, `containerchecksum ${sha512(buf)}`,
  `runfiles size=${files.length}`, ...files.map((f) => ` ${f}`), '',
].join('\n');
const tlpdb = (release) => [
  'name 00texlive.config', 'category TLCore', `depend release/${release}`, '',
  entry('pgf', ['RELOC/tex/generic/pgf/frontendlayer/tikz.code.tex', 'RELOC/tex/latex/pgf/frontendlayer/tikz.sty'], archives.pgf),
  entry('cmfonts', ['texmf-dist/fonts/tfm/public/cm/cmr10.tfm'], archives.cmfonts, false),
  // The database's checksum is of other bytes than the mirror serves.
  entry('tampered', ['RELOC/tex/latex/tampered/tampered.sty'], Buffer.from('not the archive')),
  entry('linked', ['RELOC/tex/latex/linked/real.sty', 'RELOC/tex/latex/linked/linked.sty'], archives.linked),
  entry('evil', ['RELOC/tex/latex/evil/evil.sty'], archives.evil),
  entry('huge', ['RELOC/tex/latex/huge/huge.sty'], Buffer.alloc(10)).replace('containersize 10', 'containersize 999999999'),
  entry('foo.x86_64-linux', ['bin/x86_64-linux/foo'], Buffer.alloc(1)),
].join('\n');

let release = '2026';
const requests = [];
const mirror = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/tlnet/tlpkg/texlive.tlpdb') { res.end(tlpdb(release)); return; }
  const m = /^\/tlnet\/archive\/([a-z]+)\.tar\.xz$/.exec(req.url);
  if (m && archives[m[1]]) { res.end(archives[m[1]]); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => mirror.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mirror.address().port}/tlnet`;
const source = (cacheDir, over = {}) => new PackageSource({ mirror: base, release: '2026', cacheDir, maxCacheBytes: 50 * 1024 * 1024, maxPackageBytes: 10 * 1024 * 1024, ...over });

try {
  // ---- the database ----
  const db = parseTlpdb(tlpdb('2026'));
  eq(db.release, '2026', 'the release comes from 00texlive.config');
  check(!db.packages.has('foo.x86_64-linux'), 'platform binaries are left out');
  eq(db.byFile.get('tikz.sty')?.[0]?.pkg, 'pgf', 'a runfile names its package');

  // ---- a file is fetched with its package, once ----
  const s = source(path.join(tmp, 'cache'));
  const tikz = await s.resolve(26, 'tikz.sty');
  eq(tikz && fs.readFileSync(tikz, 'utf8'), '\\ProvidesPackage{tikz}', 'tikz.sty comes from pgf');
  requests.length = 0;
  const code = await s.resolve(26, 'tikz.code.tex');
  check(code && fs.readFileSync(code, 'utf8') === '% tikz', 'a sibling file of the same package is served');
  eq(requests, [], 'from the package already fetched');
  const tfm = await s.resolve(3, 'cmr10');
  eq(tfm && fs.readFileSync(tfm, 'utf8'), 'tfm-bytes', 'a bare font name gets its format\'s suffix, in a non-relocated package');
  eq(await s.resolve(26, 'nothing-like-this.sty'), null, 'a file TeX Live lacks is a miss');
  requests.length = 0;
  eq(await s.resolve(26, 'nothing-like-this.sty'), null, 'and stays one');
  eq(requests, [], 'without asking the mirror again');

  // ---- which package carries a file, with its catalogue entry ----
  const located = await s.locateFiles(['tikz.sty', 'cmr10.tfm', 'nowhere.cls']);
  eq(located.get('tikz.sty'), { pkg: 'pgf', license: 'lppl1.3c', version: '1.0', home: null }, 'a runfile names its package and licence');
  check(!located.has('cmr10.tfm'), 'only files under a tex/ tree count as classes and packages');
  check(!located.has('nowhere.cls'), 'a file TeX Live lacks is left out');

  // ---- a new process reuses the cache ----
  requests.length = 0;
  const again = source(path.join(tmp, 'cache'));
  check(await again.resolve(26, 'tikz.sty'), 'the cache survives a restart');
  eq(requests, [], 'database and package come from disk');

  // ---- names that are no file names ----
  for (const bad of ['../etc/passwd', 'a/b.sty', '.hidden', '']) eq(await s.resolve(26, bad), null, `"${bad}" is refused`);
  eq(await s.resolve(-1, 'tikz.sty'), null, 'a format out of range is refused');

  // ---- refused archives ----
  await throws(() => s.resolve(26, 'tampered.sty'), 'checksum', 'an archive with other bytes than the database says is refused');
  check(!fs.existsSync(path.join(tmp, 'cache', '2026', 'packages', 'tampered')), 'and nothing of it is kept');
  await throws(() => s.resolve(26, 'evil.sty'), 'outside itself', 'an archive naming a path outside itself is refused');
  check(!fs.existsSync(path.join(tmp, 'cache', '2026', 'escaped.sty')) && !fs.existsSync(path.join(tmp, 'cache', 'escaped.sty')), 'and wrote nothing outside');
  eq(await s.resolve(26, 'linked.sty'), null, 'a link in an archive is never served');
  check(await s.resolve(26, 'real.sty'), 'while the package\'s real files are');
  await throws(() => s.resolve(26, 'huge.sty'), 'per-package limit', 'a package over the size limit is not fetched');

  // ---- the mirror the database came from goes away ----
  const deadDir = path.join(tmp, 'cache-dead');
  fs.mkdirSync(path.join(deadDir, '2026'), { recursive: true });
  fs.writeFileSync(path.join(deadDir, '2026', 'texlive.tlpdb'), tlpdb('2026'));
  fs.writeFileSync(path.join(deadDir, '2026', 'mirror'), 'http://127.0.0.1:9/tlnet');
  const orphaned = source(deadDir);
  check(await orphaned.resolve(26, 'tikz.sty'), 'a dead remembered mirror falls back to the configured one');

  // ---- a package changed upstream since the database was cached ----
  const staleDir = path.join(tmp, 'cache-stale');
  fs.mkdirSync(path.join(staleDir, '2026'), { recursive: true });
  // The cached database names other bytes for pgf than the mirror now serves.
  fs.writeFileSync(path.join(staleDir, '2026', 'texlive.tlpdb'), tlpdb('2026').replace(sha512(archives.pgf), sha512(Buffer.from('an older pgf'))));
  fs.writeFileSync(path.join(staleDir, '2026', 'mirror'), base);
  requests.length = 0;
  const stale = source(staleDir);
  check(await stale.resolve(26, 'tikz.sty'), 'an archive newer than the cached database is fetched after a refresh');
  check(requests.includes('/tlnet/tlpkg/texlive.tlpdb'), 'the refresh read the database again');

  // ---- the cache limit ----
  const full = source(path.join(tmp, 'cache-full'), { maxCacheBytes: 10 });
  await throws(() => full.resolve(26, 'tikz.sty'), 'cache is full', 'a full cache fetches nothing more');

  // ---- a mirror of another release ----
  release = '2027';
  await throws(() => source(path.join(tmp, 'cache-2027')).resolve(26, 'tikz.sty'), 'set ALDINE_TEXLIVE_MIRROR', 'a mirror of another TeX Live release is refused, with what to do');

  console.log('browsertex-packages: all checks passed');
} finally {
  mirror.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
