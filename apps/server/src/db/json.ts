import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECT_ID_RE } from '../util.js';
import type { DataStore, User, SessionRow, TokenRecord, ProjectMeta, Comment, OAuthClient, RefreshTokenRecord } from './types.js';

/**
 * OAuth-minted (family set) and revoked before `cutoff` (ms epoch). An
 * expired-but-unrevoked record is NOT dead: its family's refresh token may
 * still be live, and that record is the only handle Account settings offers
 * for revoking the grant.
 */
function isDeadOAuthToken(t: TokenRecord, cutoff: number): boolean {
  return !!t.family && t.revokedAt != null && Date.parse(t.revokedAt) < cutoff;
}

/**
 * Flat-JSON DataStore — the slim, zero-dependency default for single-node
 * self-hosting. Preserves the historical on-disk layout so existing
 * deployments keep working:
 *   <metaRoot>/users.json  sessions.json  resets.json  usage.json
 *   <metaRoot>/oauth_clients.json  refresh_tokens.json
 *   <metaRoot>/meta/<id>.json          (project metadata)
 *   <metaRoot>/comments/<id>.json      (review comments)
 * Writes are atomic (temp + rename). Node's synchronous fs calls don't
 * interleave, so a single process is race-free; multi-node needs Postgres.
 */
export class JsonStore implements DataStore {
  private usersPath: string;
  private sessionsPath: string;
  private resetsPath: string;
  private tokensPath: string;
  private usagePath: string;
  private connectionsPath: string;
  private oauthClientsPath: string;
  private refreshPath: string;
  private metaDir: string;
  private commentsDir: string;
  private flat: Set<string>;

  constructor(private metaRoot: string) {
    this.usersPath = path.join(metaRoot, 'users.json');
    this.sessionsPath = path.join(metaRoot, 'sessions.json');
    this.resetsPath = path.join(metaRoot, 'resets.json');
    this.tokensPath = path.join(metaRoot, 'tokens.json');
    this.usagePath = path.join(metaRoot, 'usage.json');
    this.connectionsPath = path.join(metaRoot, 'connections.json');
    this.oauthClientsPath = path.join(metaRoot, 'oauth_clients.json');
    this.refreshPath = path.join(metaRoot, 'refresh_tokens.json');
    this.metaDir = path.join(metaRoot, 'meta');
    this.commentsDir = path.join(metaRoot, 'comments');
    this.flat = new Set([this.usersPath, this.sessionsPath, this.resetsPath, this.tokensPath, this.usagePath, this.connectionsPath, this.oauthClientsPath, this.refreshPath]);
  }

  async init(): Promise<void> {
    for (const d of [this.metaRoot, this.metaDir, this.commentsDir]) fs.mkdirSync(d, { recursive: true });
  }
  async close(): Promise<void> {}

  // Write-through cache of the FLAT JSON files only (users/sessions/resets/usage/
  // connections) — per-id meta/comment files are read straight from disk, so
  // caching their writes would only leak memory. The header guarantees
  // single-process access, so the cache is authoritative for reads. This avoids
  // re-parsing users.json + sessions.json on every authenticated request.
  private cache = new Map<string, unknown>();
  private read<T>(p: string, dflt: T): T {
    if (this.cache.has(p)) return this.cache.get(p) as T;
    let v: T;
    try {
      v = JSON.parse(fs.readFileSync(p, 'utf8')) as T;
    } catch (err: unknown) {
      // Only a genuinely-absent file means "empty" (a fresh store). A transient
      // read error (EMFILE/EIO/EACCES) or a corrupt/partial file must NOT be
      // cached as the empty default — a later write would then persist that
      // default OVER real data. Fail loud so the next call retries the disk.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      v = dflt;
    }
    this.cache.set(p, v);
    return v;
  }
  private write(p: string, v: unknown): void {
    if (this.flat.has(p)) this.cache.set(p, v); // only flat files are served from cache
    try {
      const tmp = `${p}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, p);
    } catch (err) {
      // The in-memory entry now holds an unpersisted (caller-mutated) value; drop
      // it so the next read re-reads authoritative disk instead of serving it.
      this.cache.delete(p);
      throw err;
    }
  }

  // The flat-file cache holds live objects; returning (or storing) them by
  // reference lets a caller's later mutation silently change the store before
  // any write — the Postgres backend never aliases. Copy at the boundary so
  // both backends behave identically ("mutating a returned row is a no-op").
  private clone<T>(v: T): T { return v == null ? v : structuredClone(v); }

  // ---- users ----
  private users() { return this.read<Record<string, User>>(this.usersPath, {}); }
  async createUser(u: User) {
    const m = this.users();
    // Enforce email-uniqueness like Postgres' UNIQUE(email): this read-check-write
    // is synchronous (no await), so it closes the register() TOCTOU race that two
    // interleaved sign-ups would otherwise slip through on the JSON backend.
    if (Object.values(m).some((x) => x.email === u.email && x.id !== u.id)) {
      throw new Error('An account with that email already exists');
    }
    m[u.id] = this.clone(u);
    this.write(this.usersPath, m);
  }
  async updateUser(u: User) { const m = this.users(); m[u.id] = this.clone(u); this.write(this.usersPath, m); }
  async getUser(id: string) { return this.clone(this.users()[id] || null); }
  async findUserByEmail(email: string) { return this.clone(Object.values(this.users()).find((u) => u.email === email) || null); }

  // ---- sessions ----
  private sessions() { return this.read<Record<string, SessionRow>>(this.sessionsPath, {}); }
  async createSession(sid: string, userId: string, exp: number) {
    const s = this.sessions();
    const now = Date.now();
    for (const [k, v] of Object.entries(s)) if (v.exp < now) delete s[k]; // opportunistic prune
    s[sid] = { userId, exp };
    this.write(this.sessionsPath, s);
  }
  async getSession(sid: string) { return this.clone(this.sessions()[sid] || null); }
  async deleteSession(sid: string) { const s = this.sessions(); if (s[sid]) { delete s[sid]; this.write(this.sessionsPath, s); } }
  async deleteSessionsForUser(userId: string) {
    const s = this.sessions(); let changed = false;
    for (const [k, v] of Object.entries(s)) if (v.userId === userId) { delete s[k]; changed = true; }
    if (changed) this.write(this.sessionsPath, s);
  }

  // ---- resets ----
  private resets() { return this.read<Record<string, SessionRow>>(this.resetsPath, {}); }
  async createReset(token: string, userId: string, exp: number) {
    const r = this.resets();
    const now = Date.now();
    for (const [t, v] of Object.entries(r)) if (v.exp < now) delete r[t];
    r[token] = { userId, exp };
    this.write(this.resetsPath, r);
  }
  async getReset(token: string) { return this.clone(this.resets()[token] || null); }
  async deleteReset(token: string) { const r = this.resets(); if (r[token]) { delete r[token]; this.write(this.resetsPath, r); } }

  // ---- personal access tokens ----
  private tokens() { return this.read<Record<string, TokenRecord>>(this.tokensPath, {}); }
  async createToken(t: TokenRecord) {
    const m = this.tokens();
    // Every refresh rotation leaves a revoked record behind; prune the
    // OAuth-minted ones a week after they were revoked.
    const cutoff = Date.now() - 7 * 864e5;
    for (const [k, v] of Object.entries(m)) if (isDeadOAuthToken(v, cutoff)) delete m[k];
    m[t.id] = this.clone(t);
    this.write(this.tokensPath, m);
  }
  async getToken(id: string) { return this.clone(this.tokens()[id] || null); }
  async getTokenByHash(hash: string) { return this.clone(Object.values(this.tokens()).find((t) => t.hash === hash) || null); }
  async listTokensForUser(userId: string) {
    return this.clone(Object.values(this.tokens()).filter((t) => t.userId === userId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async updateToken(t: TokenRecord) { const m = this.tokens(); m[t.id] = this.clone(t); this.write(this.tokensPath, m); }
  async touchToken(id: string, lastUsedAt: string) {
    const m = this.tokens();
    if (m[id]) { m[id].lastUsedAt = lastUsedAt; this.write(this.tokensPath, m); }
  }
  async revokeTokensInFamily(family: string, revokedAt: string) {
    const m = this.tokens(); let changed = false;
    for (const t of Object.values(m)) if (t.family === family && !t.revokedAt) { t.revokedAt = revokedAt; changed = true; }
    if (changed) this.write(this.tokensPath, m);
  }

  // ---- OAuth clients ----
  private oauthClients() { return this.read<Record<string, OAuthClient>>(this.oauthClientsPath, {}); }
  async createOAuthClient(c: OAuthClient) { const m = this.oauthClients(); m[c.id] = this.clone(c); this.write(this.oauthClientsPath, m); }
  async getOAuthClient(id: string) { return this.clone(this.oauthClients()[id] || null); }
  async touchOAuthClient(id: string, lastUsedAt: string) {
    const m = this.oauthClients();
    if (m[id]) { m[id].lastUsedAt = lastUsedAt; this.write(this.oauthClientsPath, m); }
  }
  async countOAuthClients() { return Object.keys(this.oauthClients()).length; }
  async evictOldestOAuthClients(n: number) {
    if (n <= 0) return 0;
    const m = this.oauthClients();
    const victims = Object.values(m).sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt)).slice(0, n);
    for (const v of victims) delete m[v.id];
    if (victims.length) this.write(this.oauthClientsPath, m);
    return victims.length;
  }

  // ---- OAuth refresh tokens ----
  private refreshTokens() { return this.read<Record<string, RefreshTokenRecord>>(this.refreshPath, {}); }
  async createRefresh(r: RefreshTokenRecord) {
    const m = this.refreshTokens();
    // Opportunistic prune, like sessions: a rotated-every-24h connector would
    // otherwise grow this file by one dead record per day forever.
    const cutoff = Date.now() - 7 * 864e5;
    for (const [k, v] of Object.entries(m)) if (Date.parse(v.expiresAt) < cutoff) delete m[k];
    m[r.id] = this.clone(r);
    this.write(this.refreshPath, m);
  }
  async getRefreshByHash(hash: string) { return this.clone(Object.values(this.refreshTokens()).find((r) => r.hash === hash) || null); }
  async markRefreshUsed(id: string, usedAt: string) {
    const m = this.refreshTokens();
    if (!m[id] || m[id].usedAt || m[id].revokedAt) return false;
    m[id].usedAt = usedAt;
    this.write(this.refreshPath, m);
    return true;
  }
  async revokeRefreshFamily(family: string, revokedAt: string) {
    const m = this.refreshTokens(); let changed = false;
    for (const r of Object.values(m)) if (r.family === family && !r.revokedAt) { r.revokedAt = revokedAt; changed = true; }
    if (changed) this.write(this.refreshPath, m);
  }

  // ---- project meta ----
  private metaPath(id: string) { if (!PROJECT_ID_RE.test(id)) throw new Error('bad project id'); return path.join(this.metaDir, `${id}.json`); }
  async readMeta(id: string) { try { return JSON.parse(fs.readFileSync(this.metaPath(id), 'utf8')) as ProjectMeta; } catch { return null; } }
  async writeMeta(meta: ProjectMeta) { this.write(this.metaPath(meta.id), meta); }
  async deleteMeta(id: string) { fs.rmSync(this.metaPath(id), { force: true }); }
  async listMeta() {
    if (!fs.existsSync(this.metaDir)) return [];
    const out: ProjectMeta[] = [];
    for (const f of fs.readdirSync(this.metaDir)) {
      if (!f.endsWith('.json')) continue;
      // Skip an unreadable/corrupt file rather than failing the whole listing —
      // matches readMeta's null-on-error semantics (one bad project ≠ dead dashboard).
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.metaDir, f), 'utf8')) as ProjectMeta); }
      catch (err) { console.error(`[store] skipping unreadable meta ${f}:`, (err as Error).message); }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ---- comments ----
  private commentPath(id: string) { if (!PROJECT_ID_RE.test(id)) throw new Error('bad project id'); return path.join(this.commentsDir, `${id}.json`); }
  async loadComments(projectId: string) { try { return JSON.parse(fs.readFileSync(this.commentPath(projectId), 'utf8')) as Comment[]; } catch { return []; } }
  async saveComments(projectId: string, list: Comment[]) { this.write(this.commentPath(projectId), list); }

  // ---- connections ----
  private connections() { return this.read<Record<string, Record<string, Record<string, unknown>>>>(this.connectionsPath, {}); }
  async getConnection(userId: string, provider: string) { return this.clone(this.connections()[userId]?.[provider] || null); }
  async setConnection(userId: string, provider: string, data: Record<string, unknown>) {
    const c = this.connections();
    (c[userId] ||= {})[provider] = this.clone(data);
    this.write(this.connectionsPath, c);
  }
  async deleteConnection(userId: string, provider: string) {
    const c = this.connections();
    if (c[userId]?.[provider]) { delete c[userId][provider]; this.write(this.connectionsPath, c); }
  }

  // ---- usage ----
  // Keyed per (user, month) like PgStore, so a new month doesn't wipe the prior
  // month's total and past-month reads don't return 0.
  private usage() { return this.read<Record<string, Record<string, number>>>(this.usagePath, {}); }
  // Migrate the pre-2026-07 shape {userId:{month,seconds}} to {userId:{[month]:seconds}}
  // on read, so upgrading a JSON-backed self-host doesn't silently reset quotas.
  private userMonths(rec: Record<string, number> | undefined): Record<string, number> {
    if (rec && typeof (rec as any).month === 'string' && typeof (rec as any).seconds === 'number') {
      return { [(rec as any).month]: (rec as any).seconds };
    }
    return rec || {};
  }
  async getUsageSeconds(userId: string, month: string) { return this.userMonths(this.usage()[userId])[month] ?? 0; }
  async addUsageSeconds(userId: string, month: string, seconds: number) {
    const u = this.usage();
    u[userId] = this.userMonths(u[userId]);
    u[userId][month] = (u[userId][month] || 0) + seconds;
    this.write(this.usagePath, u);
  }
}
