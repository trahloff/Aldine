#!/usr/bin/env node
/**
 * Template licence gate: every folder under templates/ must say what its files
 * are licensed as, where they came from, and carry the licence text.
 *
 * A template without that cannot be shipped — the gallery shows a licence on
 * every tile, and a starter file whose terms nobody recorded is one nobody can
 * safely copy into a paper.
 *
 * Usage: node scripts/check-templates.mjs [templatesDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] || path.join(repoRoot, 'templates'));

const CATEGORIES = ['Journals', 'Conferences', 'Theses', 'Slides', 'General'];
const isUrl = (v) => typeof v === 'string' && /^https?:\/\/\S+$/.test(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

function checkTemplate(name) {
  const base = path.join(dir, name);
  const errors = [];
  const metaPath = path.join(base, 'template.json');
  if (!fs.existsSync(metaPath)) return [`${name}: no template.json (a folder under templates/ must be a template)`];

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (err) {
    return [`${name}: template.json is not valid JSON (${err.message})`];
  }

  if (!isText(meta.name)) errors.push(`${name}: template.json needs a "name"`);
  if (!isText(meta.license)) errors.push(`${name}: template.json needs a "license" (e.g. "MIT", "LPPL 1.3c")`);
  if (!isUrl(meta.licenseUrl)) errors.push(`${name}: template.json needs a "licenseUrl" pointing at the licence text`);
  if (!meta.source || typeof meta.source !== 'object') {
    errors.push(`${name}: template.json needs a "source" with the upstream "url" and "version"`);
  } else {
    if (!isUrl(meta.source.url)) errors.push(`${name}: source.url must be the upstream http(s) URL`);
    if (!isText(meta.source.version)) errors.push(`${name}: source.version must say which upstream version this copy is`);
  }
  if (meta.category !== undefined && !CATEGORIES.includes(meta.category)) {
    errors.push(`${name}: category "${meta.category}" is not one of ${CATEGORIES.join(', ')}`);
  }

  const licensePath = path.join(base, 'LICENSE');
  if (!fs.existsSync(licensePath)) errors.push(`${name}: no LICENSE file next to template.json`);
  else if (!isText(fs.readFileSync(licensePath, 'utf8'))) errors.push(`${name}: LICENSE file is empty`);

  const hasTex = fs.readdirSync(base).some((f) => f.endsWith('.tex'));
  if (!hasTex) errors.push(`${name}: no .tex file, so there is nothing to start from`);

  return errors;
}

if (!fs.existsSync(dir)) {
  console.error(`No templates directory at ${dir}`);
  process.exit(1);
}

const names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const errors = names.flatMap(checkTemplate);

if (!names.length) {
  console.error(`No templates found in ${dir}`);
  process.exit(1);
}
if (errors.length) {
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(`\n${errors.length} problem(s) in ${names.length} template(s). Add the missing licence metadata to template.json and a LICENSE file.`);
  process.exit(1);
}
console.log(`${names.length} template(s) checked: ${names.join(', ')}. Licence metadata and LICENSE files present.`);
