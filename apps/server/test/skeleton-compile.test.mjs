/**
 * The generated venue skeletons have to compile. The title block is not a
 * cosmetic choice: REVTeX's \author is undefined in the preamble and the AMS
 * classes want the abstract before \maketitle, so a wrong shape is a fatal
 * error on the first typeset of a brand new project.
 *
 * Only the classes this machine actually has are tried, through the compiler's
 * own catalog. BasicTeX carries two of them; a machine with no TeX Live at all,
 * or with none of the allowlist installed, skips.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { check } from './assert.mjs';

const run = promisify(execFile);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-skeleton-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');

const skip = (why) => { console.log(`skeleton-compile: skipped (${why})`); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); };

try { execFileSync('latexmk', ['-v'], { stdio: 'ignore' }); } catch { skip('no latexmk on this machine'); }

const require = createRequire(import.meta.url);
const compilerCatalog = require('../../compiler/catalog.js');
const local = await compilerCatalog.getCatalog();
if (!local.classes.length) skip('this TeX installation has none of the allowlisted venue classes');

const catalog = await import('../src/catalog.ts');
globalThis.fetch = async () => ({ ok: true, json: async () => local });
catalog.resetVenueCache();

for (const cls of local.classes) {
  const dir = path.join(tmp, cls.id);
  fs.mkdirSync(dir, { recursive: true });
  const files = await catalog.venueTemplateFiles(`venue:${cls.id}`);
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);

  let failure = null;
  try {
    await run('latexmk', ['-pdf', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: dir, timeout: 180_000 });
  } catch (err) {
    failure = String(err.stdout || err.message).split('\n').filter((l) => /^!|Error/.test(l)).slice(0, 4).join(' | ');
  }
  check(!failure, `the ${cls.cls} skeleton compiles (${failure})`);
  check(fs.existsSync(path.join(dir, 'main.pdf')), `the ${cls.cls} skeleton produces a PDF`);
  console.log(`  ${cls.cls}: ok`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('skeleton-compile: all checks passed');
