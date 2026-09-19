import crypto from 'node:crypto';

/**
 * Authorization codes. In memory on purpose: a code lives 10 minutes and is
 * exchanged by the same client seconds later, so the single-node deployment
 * shape (the documented one) needs no shared store. A multi-node deployment
 * behind a load balancer would need this map in Redis/Postgres — the
 * exchange can land on a different node than the consent did.
 *
 * Codes are keyed by SHA-256 digest, never plaintext, and a consumed code
 * stays in the map (marked used) until its TTL so a second presentation can
 * be recognised as reuse and the tokens it produced revoked (RFC 6749 §4.1.2).
 */

export const CODE_TTL_MS = 10 * 60 * 1000;

export interface CodeGrant {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  /** RFC 8707 resource the client asked for, null when it sent none. */
  resource: string | null;
  scope: string;
  userId: string;
  projectIds: string[] | null;
}

interface CodeEntry extends CodeGrant {
  hash: string;
  exp: number;
  /** Set on first exchange: the token family the code produced. */
  usedFamily: string | null;
  /** A replay landed while the first exchange was still minting (family unknown then). */
  reusedWhilePending: boolean;
}

const codes = new Map<string, CodeEntry>();
let sweeper: NodeJS.Timeout | null = null;

const digest = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

function sweep(now = Date.now()): void {
  for (const [k, v] of codes) if (v.exp <= now) codes.delete(k);
}

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweep(), 60_000);
  sweeper.unref?.();
}

/** Issue a fresh code for a consented grant. Returns the plaintext code (sent once, in the redirect). */
export function issueCode(grant: CodeGrant, now = Date.now()): string {
  ensureSweeper();
  sweep(now);
  const code = crypto.randomBytes(32).toString('base64url');
  const hash = digest(code);
  codes.set(hash, { ...grant, hash, exp: now + CODE_TTL_MS, usedFamily: null, reusedWhilePending: false });
  return code;
}

export type ConsumeResult =
  | { status: 'ok'; grant: CodeGrant; markUsed: (family: string) => boolean }
  | { status: 'reused'; family: string }
  | { status: 'unknown' };

/**
 * Look a code up for exchange. `ok` hands back the grant plus a callback the
 * caller invokes once tokens are minted (recording the family for reuse
 * detection — it returns true when a replay already landed meanwhile, and the
 * caller must then revoke the family itself); an already-exchanged code
 * reports `reused` with the family to revoke; expired and unknown codes are
 * indistinguishable.
 */
export function consumeCode(code: string, now = Date.now()): ConsumeResult {
  const key = digest(code);
  const entry = codes.get(key);
  if (!entry || entry.exp <= now) { if (entry) codes.delete(key); return { status: 'unknown' }; }
  // The lookup above is a hash-map probe; re-compare the stored digest
  // constant-time so equality never rides on string comparison timing.
  const a = Buffer.from(entry.hash, 'hex'), b = Buffer.from(key, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 'unknown' };
  if (entry.usedFamily !== null) {
    if (entry.usedFamily === '') entry.reusedWhilePending = true;
    return { status: 'reused', family: entry.usedFamily };
  }
  // Burn the code before any async work so two concurrent exchanges can't both
  // succeed; '' means "exchanged, no family recorded (yet)".
  entry.usedFamily = '';
  const { hash: _h, exp: _exp, usedFamily: _u, reusedWhilePending: _r, ...grant } = entry;
  return { status: 'ok', grant, markUsed: (family) => { entry.usedFamily = family; return entry.reusedWhilePending; } };
}

/** Test hook: drop every outstanding code. */
export function resetCodesForTests(): void {
  codes.clear();
}
