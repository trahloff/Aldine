import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * HMAC-signed links for GET /api/projects/:id/output — and for nothing else.
 * The MCP App viewer runs in a sandboxed cross-origin iframe with no cookie,
 * so the link itself has to carry the authorization. SECURITY.md risk #5: the
 * signer never generalizes to other routes or arbitrary files; a signature
 * covers exactly one compile artifact on one branch for OUTPUT_URL_TTL_S.
 */

export const OUTPUT_URL_TTL_S = 15 * 60;

/** Compile artifacts live in a `.aldine-out` dir at the project root or beside
 *  a subdir'd root file; the route and the signer share this one rule. */
export const OUTPUT_PATH_RE = /(^|\/)\.aldine-out\/[^/]+$/;

export function isOutputPath(rel: string): boolean {
  return !!rel && !rel.includes('..') && OUTPUT_PATH_RE.test(rel);
}

const SECRET_FILE = 'output-signing-secret';
/** HMAC-SHA256 keys shorter than this are brute-forceable from one captured link. */
export const MIN_SECRET_BYTES = 32;
let secret: Buffer | null = null;

/**
 * ALDINE_SIGNING_SECRET, else a random secret generated once into META_DIR
 * (never DATA_DIR — the compiler mounts that). Nodes sharing one META_DIR
 * volume share the file: the fresh secret is written to a private temp file
 * and published with link(), which is atomic and fails with EEXIST when
 * another node won — so the loser always reads a complete file, never the
 * winner's half-written one. Volumes without hard links (SMB, some FUSE/9p
 * mounts, vfat) fall back to an O_EXCL create, which still refuses to
 * clobber a winner. Multi-node deployments without a shared META_DIR must
 * set the env var.
 */
function loadSecret(): Buffer {
  if (secret) return secret;
  const env = process.env.ALDINE_SIGNING_SECRET;
  if (env) {
    if (Buffer.byteLength(env, 'utf8') < MIN_SECRET_BYTES) {
      throw new Error(`ALDINE_SIGNING_SECRET must be at least ${MIN_SECRET_BYTES} characters (e.g. openssl rand -base64 32)`);
    }
    secret = Buffer.from(env, 'utf8');
    return secret;
  }
  const file = path.join(config.metaRoot, SECRET_FILE);
  const read = (): Buffer | null => {
    try {
      const b = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url');
      return b.length >= MIN_SECRET_BYTES ? b : null;
    } catch { return null; }
  };
  const existing = read();
  if (existing) { secret = existing; return secret; }
  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(config.metaRoot, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = fresh.toString('base64url') + '\n';
  const code = (err: unknown) => (err as NodeJS.ErrnoException).code;
  /** true when this process's secret is now the file's; false when another won. */
  const publish = (): boolean => {
    try {
      fs.linkSync(tmp, file);
      return true;
    } catch (err) {
      if (code(err) === 'EEXIST') return false;
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code(err) ?? '')) throw err;
    }
    try {
      fs.writeFileSync(file, payload, { mode: 0o600, flag: 'wx' });
      return true;
    } catch (err) {
      if (code(err) !== 'EEXIST') throw err;
      return false;
    }
  };
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600, flag: 'w' });
    if (publish()) {
      secret = fresh;
    } else {
      const raced = read();
      if (!raced) throw new Error(`unreadable ${file}`);
      secret = raced;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return secret;
}

/** Boot-time check: a short ALDINE_SIGNING_SECRET or an unwritable META_DIR
 *  fails startup instead of the first compile. */
export function ensureSigningSecret(): void {
  loadSecret();
}

/** JSON-encoded tuple, not a joined string: a `|` inside a path could
 *  otherwise make two different (project, branch, path) triples sign alike. */
function message(projectId: string, branch: string, rel: string, exp: number): string {
  return JSON.stringify([projectId, branch, rel, exp]);
}

function hmac(projectId: string, branch: string, rel: string, exp: number): Buffer {
  return crypto.createHmac('sha256', loadSecret()).update(message(projectId, branch, rel, exp)).digest();
}

export interface SignOutputOptions {
  projectId: string;
  branch: string;
  /** Artifact path relative to the branch dir, e.g. `.aldine-out/main.pdf`. */
  path: string;
  /** Absolute origin (ALDINE_PUBLIC_URL); omitted → a root-relative URL. */
  base?: string;
  /** Cache-buster carried through from the compile result, unsigned. */
  t?: number | string;
  now?: number;
}

/** A `/output` URL that authorizes itself for OUTPUT_URL_TTL_S. Refuses any
 *  path outside `.aldine-out` — there is nothing else this route serves. */
export function signOutputUrl(o: SignOutputOptions): string {
  if (!isOutputPath(o.path)) throw new Error(`refusing to sign a non-output path: ${o.path}`);
  const exp = Math.floor((o.now ?? Date.now()) / 1000) + OUTPUT_URL_TTL_S;
  const sig = hmac(o.projectId, o.branch, o.path, exp).toString('base64url');
  const q = new URLSearchParams({ branch: o.branch, path: o.path });
  if (o.t !== undefined) q.set('t', String(o.t));
  q.set('exp', String(exp));
  q.set('sig', sig);
  return `${(o.base || '').replace(/\/$/, '')}/api/projects/${o.projectId}/output?${q.toString()}`;
}

export type SignatureStatus = 'ok' | 'expired' | 'invalid';

export function verifyOutputSignature(
  projectId: string, branch: string, rel: string,
  exp: string | undefined, sig: string | undefined, now = Date.now(),
): SignatureStatus {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp) || !isOutputPath(rel)) return 'invalid';
  const expNum = Number(exp);
  let presented: Buffer;
  try { presented = Buffer.from(sig, 'base64url'); } catch { return 'invalid'; }
  const expected = hmac(projectId, branch, rel, expNum);
  // Length check first: timingSafeEqual throws on unequal lengths, and the
  // length of a base64url digest is public anyway.
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) return 'invalid';
  if (Math.floor(now / 1000) > expNum) return 'expired';
  return 'ok';
}
