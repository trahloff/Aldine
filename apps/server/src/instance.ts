import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { metaDir } from './config.js';

/**
 * Who runs this instance, for the people using it: the operator's name, logo,
 * website and a support contact. Shown beside Aldine's own name and logo,
 * never instead of them. All optional; env only, like ALDINE_ADMIN_EMAILS:
 * whoever controls the process is the operator.
 *
 *   ALDINE_INSTANCE_NAME  "Kiel University Computing Centre" (≤ 80 characters)
 *   ALDINE_INSTANCE_LOGO  path to a PNG, JPEG, WebP or SVG file (≤ 256 KB)
 *   ALDINE_INSTANCE_LOGO_DARK  the same for the dark theme (optional; the
 *                         light one is used there too when unset)
 *   ALDINE_INSTANCE_URL   https link for the name and logo
 *   ALDINE_SUPPORT        an email address or an https URL; an administrator
 *                         can set another on /admin, which wins until cleared
 */

export interface InstanceInfo {
  name: string | null;
  /** Version of the logo for cache-busting; served at /api/instance/logo. */
  logo: string | null;
  /** The dark theme's logo, at /api/instance/logo/dark; null: `logo` serves both. */
  logoDark: string | null;
  url: string | null;
  support: { kind: 'email' | 'url'; value: string } | null;
}

export const MAX_LOGO_BYTES = 256 * 1024;
type LogoType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

const clean = (s: string | undefined, max: number) => (s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

function httpsUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) ? u.href : null;
  } catch { return null; }
}

/** The type from the file's first bytes; SVG by its root element. */
export function logoType(b: Buffer): LogoType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = b.subarray(0, 2048).toString('utf8').replace(/^﻿/, '');
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

type Logo = { bytes: Buffer; type: LogoType };
/** A support contact as typed: an address (`mailto:` optional) or an https link. Empty is no contact. */
export function parseSupport(raw: unknown): { support: InstanceInfo['support']; error: boolean } {
  const v = clean(typeof raw === 'string' ? raw : '', 2000).replace(/^mailto:/i, '');
  if (!v) return { support: null, error: false };
  if (/^[^@\s/:]+@[^@\s/]+\.[^@\s/]+$/.test(v)) return { support: { kind: 'email', value: v }, error: false };
  const u = httpsUrl(v);
  return u ? { support: { kind: 'url', value: u }, error: false } : { support: null, error: true };
}

export interface LoadedInstance { info: InstanceInfo; logo: Logo | null; logoDark: Logo | null; warnings: string[] }

export function loadInstance(env: NodeJS.ProcessEnv = process.env): LoadedInstance {
  const warnings: string[] = [];
  const name = clean(env.ALDINE_INSTANCE_NAME, 80) || null;

  let url: string | null = null;
  const rawUrl = clean(env.ALDINE_INSTANCE_URL, 2000);
  if (rawUrl) {
    url = httpsUrl(rawUrl);
    if (!url) warnings.push(`[aldine] ALDINE_INSTANCE_URL is not an https URL; it is not shown`);
  }

  const parsed = parseSupport(env.ALDINE_SUPPORT);
  const support = parsed.support;
  if (parsed.error) warnings.push('[aldine] ALDINE_SUPPORT is neither an email address nor an https URL; it is not shown');

  const readLogo = (key: 'ALDINE_INSTANCE_LOGO' | 'ALDINE_INSTANCE_LOGO_DARK'): Logo | null => {
    const file = (env[key] || '').trim();
    if (!file) return null;
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_LOGO_BYTES) throw new Error(`it is larger than ${MAX_LOGO_BYTES / 1024} KB`);
      const bytes = fs.readFileSync(file);
      const type = logoType(bytes);
      if (!type) throw new Error('it is not a PNG, JPEG, WebP or SVG image');
      return { bytes, type };
    } catch (err: any) {
      const why = err?.code === 'ENOENT' ? 'the file does not exist' : err?.code ? `it cannot be read (${err.code})` : err.message;
      warnings.push(`[aldine] ${key}=${file} is not used: ${why}`);
      return null;
    }
  };
  const logo = readLogo('ALDINE_INSTANCE_LOGO');
  let logoDark = readLogo('ALDINE_INSTANCE_LOGO_DARK');
  if (logoDark && !logo) {
    warnings.push('[aldine] ALDINE_INSTANCE_LOGO_DARK is set without ALDINE_INSTANCE_LOGO; it is not used');
    logoDark = null;
  }
  if ((url || logo) && !name) warnings.push('[aldine] ALDINE_INSTANCE_LOGO or ALDINE_INSTANCE_URL is set without ALDINE_INSTANCE_NAME; set the name too, so people can tell whose logo it is');

  const v = (l: Logo | null) => (l ? crypto.createHash('sha256').update(l.bytes).digest('hex').slice(0, 12) : null);
  return { info: { name, logo: v(logo), logoDark: v(logoDark), url, support }, logo, logoDark, warnings };
}

export const instance = loadInstance();

// ---------- the support contact an administrator set on /admin ----------
// A file beside the other server-only state; read at boot, written on save.
const settingsFile = () => path.join(metaDir, 'instance.json');
interface Saved { support: string; updatedAt: string; updatedBy: string }
let saved: Saved | null = (() => {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Saved;
    return typeof s?.support === 'string' && parseSupport(s.support).support ? s : null;
  } catch { return null; }
})();

/** What /admin shows: the contact in use, where it comes from, and the env fallback. */
export function supportSetting(): { support: InstanceInfo['support']; source: 'admin' | 'env' | null; env: InstanceInfo['support']; updatedAt: string | null; updatedBy: string | null } {
  const mine = saved ? parseSupport(saved.support).support : null;
  return {
    support: mine ?? instance.info.support,
    source: mine ? 'admin' : instance.info.support ? 'env' : null,
    env: instance.info.support,
    updatedAt: saved?.updatedAt ?? null,
    updatedBy: saved?.updatedBy ?? null,
  };
}

/** Save the administrator's contact; empty clears it, and ALDINE_SUPPORT applies again. Throws on a bad value. */
export function setSupport(raw: unknown, by: string, now = new Date()): void {
  const { support, error } = parseSupport(raw);
  if (error) throw new Error('Enter an email address or a link that starts with https://');
  if (!support) {
    fs.rmSync(settingsFile(), { force: true });
    saved = null;
    return;
  }
  const next: Saved = { support: support.value, updatedAt: now.toISOString(), updatedBy: by };
  const tmp = `${settingsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, settingsFile());
  saved = next;
}

/** The operator as the app shows it now: the env settings plus the support contact from /admin. */
export const currentInstance = (): InstanceInfo => ({ ...instance.info, support: supportSetting().support });

/** Something to show: the web app hides every operator element otherwise. */
export const instanceConfigured = (i: InstanceInfo = currentInstance()) => !!(i.name || i.logo || i.support);

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** index.html with the operator in the tab title and a meta tag for the app. */
export function stampInstance(html: string, i: InstanceInfo = currentInstance()): string {
  if (!instanceConfigured(i)) return html;
  let out = html.replace('<head>', `<head>\n    <meta name="aldine-instance" content="${escAttr(JSON.stringify(i))}" />`);
  if (i.name) out = out.replace(/<title>Aldine<\/title>/, `<title>Aldine · ${escAttr(i.name)}</title>`);
  return out;
}
