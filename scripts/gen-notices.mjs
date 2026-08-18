#!/usr/bin/env node
/**
 * Regenerates THIRD-PARTY-NOTICES.md from the installed production dependency
 * tree.
 *
 * Minifying the web bundle discards the copyright notices of packages that
 * carry no /*! banner (KaTeX and MathLive among them), and MIT and Apache-2.0
 * both require the notice to travel with the code. Under the AGPL the lockfile
 * makes them discoverable anyway; the moment a build ships without source, this
 * file is the only thing carrying them.
 *
 * Usage: node scripts/gen-notices.mjs [--check]
 *   --check  exit 1 if the file on disk is out of date (for CI)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Licences that would foreclose ever shipping a differently licensed edition.
 * Matched against the whole SPDX expression, so a dual "MIT OR GPL-2.0" trips
 * this too and gets looked at by a human rather than silently assumed benign.
 */
const DENY = /\b(?:A?GPL-[\d.]+|LGPL-[\d.]+|SSPL-[\d.]+|BUSL-[\d.]+|Elastic-2\.0|CC-BY-SA|UNLICENSED|UNKNOWN)\b/i;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'THIRD-PARTY-NOTICES.md');
const WORKSPACES = ['apps/web', 'apps/server'];
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENSE-MIT', 'license'];

/** Production dependency names, per workspace, as npm resolves them. */
function prodDeps(ws) {
  const raw = execFileSync(
    'npm',
    ['ls', '--omit=dev', '--all', '--json', '-w', ws],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
  );
  const seen = new Set();
  const walk = (node) => {
    for (const [name, info] of Object.entries(node.dependencies ?? {})) {
      const key = `${name}@${info.version ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      walk(info);
    }
  };
  walk(JSON.parse(raw));
  return seen;
}

/**
 * Prebuilt binaries are installed only for the host platform, so walking
 * node_modules alone yields a different file on macOS than on CI. The lockfile
 * lists every variant, so these are read from there and carry no licence text
 * (the tarball for another platform is not on disk to read it from).
 */
function platformGated() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const out = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!entry.os && !entry.cpu) continue;
    if (entry.dev || entry.peer) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.push({ name, version: entry.version ?? '', license: entry.license ?? 'UNKNOWN' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function readPackage(name) {
  const dir = join(ROOT, 'node_modules', name);
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return null;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  let text = '';
  for (const f of LICENSE_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) { text = readFileSync(p, 'utf8').trim(); break; }
  }
  const license = typeof pkg.license === 'string'
    ? pkg.license
    : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : 'UNKNOWN');
  return {
    name,
    version: pkg.version,
    license,
    text,
    homepage: pkg.homepage ?? '',
    platformGated: Boolean(pkg.os || pkg.cpu),
  };
}

const packages = new Map();
for (const ws of WORKSPACES) {
  for (const key of prodDeps(ws)) {
    const name = key.slice(0, key.lastIndexOf('@'));
    if (name.startsWith('@aldine/')) continue;
    if (packages.has(name)) continue;
    const info = readPackage(name);
    // Platform binaries come from the lockfile instead, so the output does not
    // depend on which machine generated it.
    if (info && !info.platformGated) packages.set(name, info);
  }
}

const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));

// A walk that finds nothing would make every check below pass vacuously.
if (sorted.length < 50) {
  console.error(`Only ${sorted.length} production packages found — the dependency walk is broken, not the tree.`);
  process.exit(1);
}

const denied = sorted.filter((p) => DENY.test(p.license) || (process.env.NOTICES_DENY_EXTRA && new RegExp(process.env.NOTICES_DENY_EXTRA, 'i').test(p.license)));
if (denied.length) {
  console.error('Copyleft or unknown licence in the production tree:');
  for (const p of denied) console.error(`  ${p.name}@${p.version}: ${p.license}`);
  process.exit(1);
}
const byLicense = new Map();
for (const p of sorted) byLicense.set(p.license, (byLicense.get(p.license) ?? 0) + 1);

const lines = [
  '# Third-party notices',
  '',
  'Aldine itself is AGPL-3.0 (see [LICENSE](LICENSE)). It ships with the',
  'open-source packages listed here, each under its own license. Regenerate with',
  '`npm run notices`.',
  '',
  `${sorted.length} packages: ` + [...byLicense.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} (${n})`)
    .join(', ') + '.',
  '',
  'Two notes that metadata alone does not capture. The `@hocuspocus/*` packages',
  'declare MIT in package.json but ship no license file; the grant is at',
  'github.com/ueberdosis/hocuspocus/blob/main/LICENSE.md. The compiler image',
  'redistributes TeX Live, which is GPL and LPPL software invoked as an',
  'unmodified subprocess; its corresponding source is published by the TeX Live',
  'project at tug.org/texlive.',
  '',
];

const gated = platformGated();
if (gated.length) {
  lines.push(
    '## Prebuilt platform binaries',
    '',
    'Installed only for the matching platform, so their license text is not on',
    'disk to quote here. Every variant and its license:',
    '',
    ...gated.map((p) => `- ${p.name} ${p.version} — ${p.license}`),
    '',
  );
  const bad = gated.filter((p) => DENY.test(p.license));
  if (bad.length) {
    console.error('Copyleft or unknown licence among platform binaries:');
    for (const p of bad) console.error(`  ${p.name}@${p.version}: ${p.license}`);
    process.exit(1);
  }
}

for (const p of sorted) {
  lines.push(`## ${p.name} ${p.version}`, '', `License: ${p.license}`, '');
  if (p.text) lines.push('```', p.text, '```', '');
  else lines.push(`No license file in the published package.${p.homepage ? ` Homepage: ${p.homepage}` : ''}`, '');
}

const out = lines.join('\n');
if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== out) {
    console.error('THIRD-PARTY-NOTICES.md is out of date. Run: npm run notices');
    process.exit(1);
  }
  console.log(`THIRD-PARTY-NOTICES.md is current (${sorted.length} packages).`);
} else {
  writeFileSync(OUT, out);
  console.log(`Wrote THIRD-PARTY-NOTICES.md (${sorted.length} packages).`);
}
