/**
 * The instance operator (#288): ALDINE_INSTANCE_* and ALDINE_SUPPORT are read
 * once at boot, refused values are left out with a boot warning, index.html
 * carries the operator in its title and an escaped meta tag, and the logo
 * route serves the file (the dark one when asked and set) without a sign-in.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-instance-'));
const svg = path.join(tmp, 'logo.svg');
const png = path.join(tmp, 'logo-dark.png');
fs.writeFileSync(svg, '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPQS3oJRAwQCgAmXgXlTZmj9QAAAABJRU5ErkJggg==', 'base64'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
delete process.env.ALDINE_BASE_PATH;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.SENTRY_DSN;
Object.assign(process.env, {
  ALDINE_INSTANCE_NAME: 'Uni "<Kiel>" & Co',
  ALDINE_INSTANCE_URL: 'https://example.org/',
  ALDINE_INSTANCE_LOGO: svg,
  ALDINE_INSTANCE_LOGO_DARK: png,
  ALDINE_SUPPORT: 'mailto:help@example.org',
});
fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><html><head><title>Aldine</title></head><body></body></html>\n');

const { loadInstance, logoType, stampInstance, MAX_LOGO_BYTES } = await import('../src/instance.ts');

// ---- reading the settings ----
{
  const none = loadInstance({});
  eq(none.info, { name: null, logo: null, logoDark: null, url: null, support: null }, 'nothing set, nothing shown');
  eq(none.warnings, [], 'and nothing to warn about');
  eq(stampInstance('<head><title>Aldine</title>', none.info), '<head><title>Aldine</title>', 'index.html untouched without an operator');

  eq(loadInstance({ ALDINE_SUPPORT: 'https://help.example.org/latex' }).info.support, { kind: 'url', value: 'https://help.example.org/latex' }, 'a help page');
  eq(loadInstance({ ALDINE_SUPPORT: 'it@uni.example' }).info.support, { kind: 'email', value: 'it@uni.example' }, 'an address');
  const bad = loadInstance({ ALDINE_SUPPORT: 'javascript:alert(1)', ALDINE_INSTANCE_URL: 'http://example.org', ALDINE_INSTANCE_NAME: 'X' });
  eq(bad.info.support, null, 'a javascript: support link is refused');
  eq(bad.info.url, null, 'a plain http website is refused');
  eq(bad.warnings.length, 2, `both are warned about (${bad.warnings})`);
  eq(loadInstance({ ALDINE_INSTANCE_NAME: 'x'.repeat(200) }).info.name.length, 80, 'the name is cut at 80');

  const missing = loadInstance({ ALDINE_INSTANCE_NAME: 'X', ALDINE_INSTANCE_LOGO: path.join(tmp, 'nope.png') });
  eq(missing.info.logo, null, 'a missing logo file is left out');
  check(missing.warnings.some((w) => w.includes('the file does not exist')), 'and named');
  const big = path.join(tmp, 'big.png');
  fs.writeFileSync(big, Buffer.alloc(MAX_LOGO_BYTES + 1));
  check(loadInstance({ ALDINE_INSTANCE_NAME: 'X', ALDINE_INSTANCE_LOGO: big }).warnings.some((w) => w.includes('larger than')), 'an oversized logo is refused');
  const html = path.join(tmp, 'page.html');
  fs.writeFileSync(html, '<html><script>alert(1)</script></html>');
  check(loadInstance({ ALDINE_INSTANCE_NAME: 'X', ALDINE_INSTANCE_LOGO: html }).warnings.some((w) => w.includes('not a PNG')), 'HTML is not a logo');
  const darkOnly = loadInstance({ ALDINE_INSTANCE_NAME: 'X', ALDINE_INSTANCE_LOGO_DARK: png });
  eq(darkOnly.info.logoDark, null, 'a dark logo without a light one is not used');
  check(loadInstance({ ALDINE_INSTANCE_LOGO: png }).warnings.some((w) => w.includes('without ALDINE_INSTANCE_NAME')), 'a logo without a name is warned about');

  eq(logoType(fs.readFileSync(svg)), 'image/svg+xml', 'SVG after an XML declaration and a comment');
  eq(logoType(fs.readFileSync(png)), 'image/png', 'PNG');
}

// ---- index.html and the logo route ----
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();
{
  const page = await app.inject({ method: 'GET', url: '/' });
  eq(page.statusCode, 200, 'index served');
  check(page.body.includes('<title>Aldine · Uni &quot;&lt;Kiel&gt;&quot; &amp; Co</title>'), `the operator joins Aldine in the title, escaped (${page.body})`);
  const m = /<meta name="aldine-instance" content="([^"]*)"/.exec(page.body);
  check(m, 'meta tag present');
  check(!m[1].includes('<'), 'no raw markup in the attribute');
  const info = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  eq(info.name, 'Uni "<Kiel>" & Co', 'the name round-trips');
  eq(info.support, { kind: 'email', value: 'help@example.org' }, 'mailto: is dropped from the address');
  check(/^[0-9a-f]{12}$/.test(info.logo) && /^[0-9a-f]{12}$/.test(info.logoDark) && info.logo !== info.logoDark, 'both logos versioned');

  const light = await app.inject({ method: 'GET', url: '/api/instance/logo' });
  eq(light.statusCode, 200, 'logo served without a sign-in');
  eq(light.headers['content-type'], 'image/svg+xml', 'as SVG');
  check(String(light.headers['content-security-policy']).includes('sandbox'), 'sandboxed');
  eq(light.headers['x-content-type-options'], 'nosniff', 'nosniff');
  const dark = await app.inject({ method: 'GET', url: '/api/instance/logo/dark' });
  eq(dark.headers['content-type'], 'image/png', 'the dark logo');
  eq((await app.inject({ method: 'GET', url: '/api/instance/logo/other' })).statusCode, 404, 'no other variants');
}
// ---- the support contact from /admin overrides ALDINE_SUPPORT until cleared ----
{
  const { setSupport, supportSetting } = await import('../src/instance.ts');
  const supportOf = async () => {
    const body = (await app.inject({ method: 'GET', url: '/' })).body;
    const m = /<meta name="aldine-instance" content="([^"]*)"/.exec(body);
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).support;
  };
  eq(supportSetting().source, 'env', 'ALDINE_SUPPORT to begin with');
  setSupport('https://servicedesk.example.org/latex', 'admin@example.org [a1]');
  eq(await supportOf(), { kind: 'url', value: 'https://servicedesk.example.org/latex' }, 'the next page load carries the new contact');
  const s = supportSetting();
  eq([s.source, s.env?.value, s.updatedBy], ['admin', 'help@example.org', 'admin@example.org [a1]'], 'set on /admin, env kept as the fallback');
  check(fs.existsSync(path.join(tmp, 'meta', 'meta', 'instance.json')), 'saved in META_DIR');
  let threw = false;
  try { setSupport('javascript:alert(1)', 'x'); } catch { threw = true; }
  check(threw, 'a javascript: link is refused');
  eq(supportSetting().support.value, 'https://servicedesk.example.org/latex', 'and the saved contact stays');
  setSupport('', 'x');
  eq(await supportOf(), { kind: 'email', value: 'help@example.org' }, 'cleared: ALDINE_SUPPORT again');
  check(!fs.existsSync(path.join(tmp, 'meta', 'meta', 'instance.json')), 'the file is gone');
}
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Instance operator: ALL PASSED');
