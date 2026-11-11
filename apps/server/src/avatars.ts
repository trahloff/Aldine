import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { metaDir } from './config.js';

/**
 * Profile pictures from a sign-in provider (the OIDC `picture` claim,
 * Google's `picture`, GitHub's `avatar_url`). The server fetches the image
 * once per sign-in and serves its own copy, so co-authors' browsers never
 * contact the provider and a picture behind the provider's login still shows.
 * ALDINE_AVATARS=0 turns the fetch off; avatars then stay initials.
 *
 * Stored beside the other server-only state in META_DIR: `<id>.img` holds the
 * bytes, `<id>.json` where they came from.
 */

export const AVATARS_ENABLED = !/^(0|false|off)$/i.test((process.env.ALDINE_AVATARS || '').trim());

const dir = path.join(metaDir, 'avatars');
/** Far above any profile picture; a larger answer is refused unread. */
export const MAX_AVATAR_BYTES = 1024 * 1024;
/** A picture URL the provider still reports is fetched again after this long. */
const REFRESH_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const ID_RE = /^[\w-]{1,64}$/;

export type AvatarType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
interface Sidecar { provider: string; src: string; type: AvatarType; fetchedAt: string }

const files = (userId: string) => ({ img: path.join(dir, `${userId}.img`), json: path.join(dir, `${userId}.json`) });

/** The image type from its first bytes. SVG is never accepted: it can carry script. */
export function sniffImage(b: Buffer): AvatarType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Version of the stored picture for cache-busting URLs, or undefined when there is none. */
export function avatarVersion(userId: string): string | undefined {
  if (!AVATARS_ENABLED || !ID_RE.test(userId)) return undefined;
  try {
    const st = fs.statSync(files(userId).img);
    return Math.floor(st.mtimeMs).toString(16);
  } catch { return undefined; }
}

export function readAvatar(userId: string): { bytes: Buffer; type: AvatarType; v: string } | null {
  if (!AVATARS_ENABLED || !ID_RE.test(userId)) return null;
  try {
    const bytes = fs.readFileSync(files(userId).img);
    const type = sniffImage(bytes);
    const v = avatarVersion(userId);
    return type && v ? { bytes, type, v } : null;
  } catch { return null; }
}

function readSidecar(userId: string): Sidecar | null {
  try { return JSON.parse(fs.readFileSync(files(userId).json, 'utf8')) as Sidecar; } catch { return null; }
}

export function removeAvatar(userId: string): void {
  if (!ID_RE.test(userId)) return;
  const f = files(userId);
  for (const p of [f.img, f.json]) fs.rmSync(p, { force: true });
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const srcKey = (src: string) => crypto.createHash('sha256').update(src).digest('base64url');

/** The picture's bytes: a base64 data: URI, or an https URL (plain http only to this machine when allowed). */
async function load(src: string, allowLoopbackHttp: boolean): Promise<Buffer> {
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
  if (data) {
    if (data[2].length > (MAX_AVATAR_BYTES * 4) / 3 + 4) throw new Error('the picture is larger than 1 MB');
    return Buffer.from(data[2], 'base64');
  }
  let u: URL;
  try { u = new URL(src); } catch { throw new Error('the picture is not a URL'); }
  if (u.protocol !== 'https:' && !(allowLoopbackHttp && u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new Error('the picture URL must use https');
  }
  if (u.username || u.password) throw new Error('the picture URL carries credentials');
  const res = await fetch(u, { headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
  if (!res.ok) throw new Error(`the picture URL answered ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_AVATAR_BYTES) throw new Error('the picture is larger than 1 MB');
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AVATAR_BYTES) { await reader.cancel().catch(() => {}); throw new Error('the picture is larger than 1 MB'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * After a sign-in with `provider`: store the picture it reported, or drop the
 * one it reported earlier when it reports none now. A picture another
 * provider supplied is left alone in that case. Failures are logged and keep
 * whatever is stored; sign-in never waits on or fails for a picture.
 */
export async function syncAvatar(userId: string, provider: string, picture: string | undefined, opts: { allowLoopbackHttp?: boolean; now?: number } = {}): Promise<void> {
  if (!AVATARS_ENABLED || !ID_RE.test(userId)) return;
  const prev = readSidecar(userId);
  if (!picture) {
    if (prev?.provider === provider) removeAvatar(userId);
    return;
  }
  const key = srcKey(picture);
  const now = opts.now ?? Date.now();
  if (prev && prev.provider === provider && prev.src === key && now - Date.parse(prev.fetchedAt) < REFRESH_MS && avatarVersion(userId)) return;
  try {
    const bytes = await load(picture, !!opts.allowLoopbackHttp);
    if (bytes.length > MAX_AVATAR_BYTES) throw new Error('the picture is larger than 1 MB');
    const type = sniffImage(bytes);
    if (!type) throw new Error('the picture is not a PNG, JPEG, GIF or WebP image');
    fs.mkdirSync(dir, { recursive: true });
    const f = files(userId);
    const tmp = `${f.img}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, f.img);
    const side: Sidecar = { provider, src: key, type, fetchedAt: new Date(now).toISOString() };
    fs.writeFileSync(f.json, JSON.stringify(side));
  } catch (err: any) {
    console.warn(`[aldine] profile picture from ${provider} for account ${userId} not stored: ${err?.message ?? err}`);
  }
}
