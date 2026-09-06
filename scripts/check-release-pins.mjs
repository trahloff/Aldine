#!/usr/bin/env node
// Every place that names the release version must agree, because none of them
// is generated from another:
//   - package.json "version" at the root and in both workspaces
//   - the ${ALDINE_VERSION:-x.y.z} default in docker-compose.yml, which is what
//     a fresh `docker compose up` pulls
//   - the same default in the README's copy-paste block (documented as the
//     compose file "verbatim")
// With --tag vX.Y.Z (the release preflight) the tag must match too, and the
// CHANGELOG must already carry a "## [X.Y.Z]" heading.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const version = (p) => JSON.parse(read(p)).version;

const tagArg = process.argv.indexOf('--tag');
const tag = tagArg >= 0 ? process.argv[tagArg + 1] : process.env.RELEASE_TAG;

const found = [];
found.push(['package.json', version('package.json')]);
found.push(['apps/server/package.json', version('apps/server/package.json')]);
found.push(['apps/web/package.json', version('apps/web/package.json')]);

const pin = /aldine-(app|compiler):\$\{ALDINE_VERSION:-([^}]+)\}/g;
for (const file of ['docker-compose.yml', 'README.md']) {
  const text = read(file);
  const seen = new Set();
  for (const m of text.matchAll(pin)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    found.push([`${file} (${m[1]})`, m[2]]);
  }
  for (const image of ['app', 'compiler']) {
    if (!seen.has(image)) found.push([`${file} (${image})`, `<no ${'${ALDINE_VERSION:-…}'} default>`]);
  }
}

const expected = found[0][1];
const problems = found.filter(([, v]) => v !== expected).map(([where, v]) => `${where}: ${v}`);

if (tag) {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!m) problems.push(`tag ${tag}: not of the form vX.Y.Z`);
  else if (m[1] !== expected) problems.push(`tag ${tag}: version differs`);
  if (m && !read('CHANGELOG.md').includes(`## [${m[1]}]`)) problems.push(`CHANGELOG.md: no "## [${m[1]}]" heading`);
}

if (problems.length) {
  console.error(`check-release-pins: expected every pin to be ${expected} (from package.json), but:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Fix: npm pkg set version=X.Y.Z --workspaces --include-workspace-root, then update the compose default and the README block.');
  process.exit(1);
}
console.log(`check-release-pins: all ${found.length} pins say ${expected}${tag ? `, tag ${tag} matches` : ''}`);
