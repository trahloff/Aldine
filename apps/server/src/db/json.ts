import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ID_RE } from '../util.js';
import { LINK_UNSUPPORTED, replaceFileDurable, writeFileSynced } from '../durable.js';
import type { DataStore, User, EmailPending, SessionRow, TokenRecord, ProjectMeta, ProjectVisit, ProjectOpen, ProjectActivity, LastEdit, CompileMark, Comment, OAuthClient, RefreshTokenRecord } from './types.js';

const errCode = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? '';

/** A datastore file that exists but does not parse, with no usable last-good
 *  copy beside it. Never answered with an empty default: a later write would
 *  then replace what an admin could still restore. */
export class DamagedStoreFileError extends Error {
  constructor(readonly file: string, message: string) {
    super(message);
    this.name = 'DamagedStoreFileError';
  }
}

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
 *   <metaRoot>/oauth_clients.json  refresh_tokens.json  visits.json
 *   <metaRoot>/opens.json  activity.json
 *   <metaRoot>/meta/<id>.json          (project metadata)
 *   <metaRoot>/comments/<id>.json      (review comments)
 * Each file has a `<file>.bak` beside it: the version before the last write,
 * which a file torn by a crash is restored from on read. Writes are atomic
 * and flushed (durable.ts). Node's synchronous fs calls don't interleave, so
 * a single process is race-free; multi-node needs Postgres.
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
  private visitsPath: string;
  private opensPath: string;
  private activityPath: string;
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
    this.visitsPath = path.join(metaRoot, 'visits.json');
    this.opensPath = path.join(metaRoot, 'opens.json');
    this.activityPath = path.join(metaRoot, 'activity.json');
    this.metaDir = path.join(metaRoot, 'meta');
    this.commentsDir = path.join(metaRoot, 'comments');
    this.flat = new Set([this.usersPath, this.sessionsPath, this.resetsPath, this.tokensPath, this.usagePath, this.connectionsPath, this.oauthClientsPath, this.refreshPath, this.visitsPath, this.opensPath, this.activityPath]);
  }

  async init(): Promise<void> {
    for (const d of [this.metaRoot, this.metaDir, this.commentsDir]) fs.mkdirSync(d, { recursive: true });
    // A damaged file without a usable .bak fails startup, naming the file,
    // instead of every request that reads it.
    await this.check();
  }
  async close(): Promise<void> {}

  /** Throws when a flat file can be neither read nor restored from its .bak.
   *  Cached files cost nothing; one dropped after a failed write is re-read. */
  async check(): Promise<void> {
    for (const p of this.flat) this.read(p, {});
  }

  // Write-through cache of the FLAT JSON files only (users/sessions/resets/usage/
  // connections) — per-id meta/comment files are read straight from disk, so
  // caching their writes would only leak memory. The header guarantees
  // single-process access, so the cache is authoritative for reads. This avoids
  // re-parsing users.json + sessions.json on every authenticated request.
  private cache = new Map<string, unknown>();
  private read<T>(p: string, dflt: T): T {
    if (this.cache.has(p)) return this.cache.get(p) as T;
    // Only a genuinely-absent file means "empty" (a fresh store). A transient
    // read error (EMFILE/EIO/EACCES) or a damaged file must NOT be cached as
    // the empty default — a later write would then persist that default OVER
    // real data. load() throws for both, so the next call retries the disk.
    const v = this.load<T>(p) ?? dflt;
    this.cache.set(p, v);
    return v;
  }

  /** A JSON file's content, or null when it does not exist. A file that does
   *  not parse (a write torn by a crash: empty, cut short, zero-filled) is
   *  restored from its .bak when that parses, else DamagedStoreFileError. */
  private load<T>(p: string): T | null {
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (errCode(err) === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      return this.restore<T>(p, raw.length ? (err as Error).message : 'the file is empty');
    }
  }

  private restore<T>(p: string, why: string): T {
    const bak = `${p}.bak`;
    let v: T;
    try {
      v = JSON.parse(fs.readFileSync(bak, 'utf8')) as T;
    } catch (err) {
      const bakWhy = errCode(err) === 'ENOENT' ? 'does not exist' : `cannot be read either (${(err as Error).message})`;
      const dir = path.dirname(p);
      let tmps: string[] = [];
      try { tmps = fs.readdirSync(dir).filter((f) => f.startsWith(`${path.basename(p)}.`) && f.endsWith('.tmp')); } catch { /* the message names no candidates */ }
      throw new DamagedStoreFileError(p,
        `Datastore file ${p} cannot be read (${why}), and its last-good copy ${bak} ${bakWhy}. ` +
        'Restore it from a backup (deploy/restore.sh; deploy/README.md, "Restore"); with none, deleting it starts it over empty.' +
        (tmps.length ? ` Interrupted writes left ${tmps.map((f) => path.join(dir, f)).join(', ')}, which may hold a newer copy.` : ''));
    }
    console.error(`[store] ${p} cannot be read (${why}); restoring it from ${bak}. The last change written to it before the damage is lost.`);
    try {
      this.write(p, v, { keepPrevious: false }); // the damaged file must not become the .bak
    } catch (err) {
      throw new DamagedStoreFileError(p, `Datastore file ${p} cannot be read (${why}); ${bak} is good, but restoring ${path.basename(p)} from it failed: ${(err as Error).message}`);
    }
    return v;
  }

  private write(p: string, v: unknown, opts: { keepPrevious?: boolean } = {}): void {
    if (this.flat.has(p)) this.cache.set(p, v); // only flat files are served from cache
    try {
      if (opts.keepPrevious !== false) this.keepPrevious(p);
      replaceFileDurable(p, JSON.stringify(v, null, 2), { mode: 0o600 });
    } catch (err) {
      // The in-memory entry now holds an unpersisted (caller-mutated) value; drop
      // it so the next read re-reads authoritative disk instead of serving it.
      this.cache.delete(p);
      throw err;
    }
  }

  /** Make the current file `<file>.bak` before it is replaced: a hard link,
   *  so it costs no copy and keeps the file's 0600 mode. */
  private keepPrevious(p: string): void {
    // Flat files were parsed (or restored) by read() before any write; a
    // per-project file may be written unread, and a torn one must not
    // replace a good .bak.
    if (!this.flat.has(p)) {
      try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return; }
    }
    const bak = `${p}.bak`;
    fs.rmSync(bak, { force: true });
    try {
      fs.linkSync(p, bak);
    } catch (err) {
      if (errCode(err) === 'ENOENT') return; // nothing written yet
      if (!LINK_UNSUPPORTED.has(errCode(err))) throw err;
      writeFileSynced(bak, fs.readFileSync(p), { mode: 0o600 });
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
    if (u.email && Object.values(m).some((x) => x.email === u.email && x.id !== u.id)) {
      throw new Error('An account with that email already exists');
    }
    if (u.subject && Object.values(m).some((x) => x.subject === u.subject && x.id !== u.id)) {
      throw new Error('An account for that identity already exists');
    }
    m[u.id] = this.clone(u);
    this.write(this.usersPath, m);
  }
  async updateUser(u: User) {
    const m = this.users();
    // Like Postgres' UPDATE: a write that lands after the account was deleted
    // (a password reset waiting on scrypt) must not bring it back.
    if (!m[u.id]) return;
    const next = this.clone(u);
    const disabledAt = m[u.id].disabledAt;
    if (disabledAt) next.disabledAt = disabledAt;
    else delete next.disabledAt;
    m[u.id] = next;
    this.write(this.usersPath, m);
  }
  async setDisabled(id: string, disabledAt: string | null) {
    const m = this.users();
    if (!m[id]) return;
    if (disabledAt) m[id].disabledAt = disabledAt;
    else delete m[id].disabledAt;
    this.write(this.usersPath, m);
  }
  async deleteUser(id: string) {
    const drop = <T>(p: string, rows: Record<string, T>, mine: (k: string, v: T) => boolean) => {
      let changed = false;
      for (const [k, v] of Object.entries(rows)) if (mine(k, v)) { delete rows[k]; changed = true; }
      if (changed) this.write(p, rows);
    };
    drop(this.sessionsPath, this.sessions(), (_k, v) => v.userId === id);
    drop(this.resetsPath, this.resets(), (_k, v) => v.userId === id);
    drop(this.tokensPath, this.tokens(), (_k, v) => v.userId === id);
    drop(this.refreshPath, this.refreshTokens(), (_k, v) => v.userId === id);
    drop(this.connectionsPath, this.connections(), (k) => k === id);
    drop(this.opensPath, this.opens(), (k) => k === id);
    drop(this.visitsPath, this.visits(), (k) => k === id);
    drop(this.usersPath, this.users(), (k) => k === id);
  }
  async listUsers() { return Object.values(this.users()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((u) => this.clone(u)); }
  async touchUser(id: string, lastSeenAt: string) {
    const m = this.users();
    if (!m[id]) return;
    m[id].lastSeenAt = lastSeenAt;
    this.write(this.usersPath, m);
  }
  async setEmailPending(id: string, pending: EmailPending | null) {
    const m = this.users();
    if (!m[id]) return;
    if (pending) m[id].emailPending = this.clone(pending);
    else delete m[id].emailPending;
    this.write(this.usersPath, m);
  }
  async getUser(id: string) { return this.clone(this.users()[id] || null); }
  async findUserByEmail(email: string) { return this.clone(Object.values(this.users()).find((u) => u.email === email) || null); }
  async findUserBySubject(subject: string) { return this.clone(Object.values(this.users()).find((u) => u.subject === subject) || null); }

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
  async revokeCredentialsForUser(userId: string, revokedAt: string) {
    const tokens = this.tokens(); let changed = false;
    for (const t of Object.values(tokens)) if (t.userId === userId && !t.revokedAt) { t.revokedAt = revokedAt; changed = true; }
    if (changed) this.write(this.tokensPath, tokens);
    const refresh = this.refreshTokens(); changed = false;
    for (const r of Object.values(refresh)) if (r.userId === userId && !r.revokedAt) { r.revokedAt = revokedAt; changed = true; }
    if (changed) this.write(this.refreshPath, refresh);
  }

  // ---- project meta ----
  private metaPath(id: string) { if (!PROJECT_ID_RE.test(id)) throw new Error('bad project id'); return path.join(this.metaDir, `${id}.json`); }
  // A damaged file without a usable .bak throws (it reads as "not found" to
  // callers that catch); any other failure, a malformed id among them, reads
  // as absent.
  async readMeta(id: string) {
    try { return this.load<ProjectMeta>(this.metaPath(id)); }
    catch (err) { if (err instanceof DamagedStoreFileError) throw err; return null; }
  }
  async writeMeta(meta: ProjectMeta) { this.write(this.metaPath(meta.id), meta); }
  async deleteMeta(id: string) {
    const p = this.metaPath(id);
    fs.rmSync(p, { force: true });
    fs.rmSync(`${p}.bak`, { force: true });
  }
  async listMeta() {
    if (!fs.existsSync(this.metaDir)) return [];
    const out: ProjectMeta[] = [];
    for (const f of fs.readdirSync(this.metaDir)) {
      if (!f.endsWith('.json')) continue;
      // Skip an unreadable/damaged file rather than failing the whole listing
      // (one bad project ≠ dead dashboard).
      try {
        const m = this.load<ProjectMeta>(path.join(this.metaDir, f));
        if (m) out.push(m);
      } catch (err) { console.error(`[store] skipping unreadable meta ${f}:`, (err as Error).message); }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ---- comments ----
  private commentPath(id: string) { if (!PROJECT_ID_RE.test(id)) throw new Error('bad project id'); return path.join(this.commentsDir, `${id}.json`); }
  // A damaged file without a usable .bak throws: an empty list here would be
  // saved over it with the next comment.
  async loadComments(projectId: string) {
    try { return this.load<Comment[]>(this.commentPath(projectId)) ?? []; }
    catch (err) { if (err instanceof DamagedStoreFileError) throw err; return []; }
  }
  async saveComments(projectId: string, list: Comment[]) { this.write(this.commentPath(projectId), list); }

  // ---- agent-review marks ----
  // Keyed `{ [userId]: { "<projectId>::<branch>": row } }`. PROJECT_ID_RE is
  // [a-z0-9]{4,20}, so the `::` join can never be ambiguous.
  private visits() { return this.read<Record<string, Record<string, { head: string; at: string; promptedHead: string | null }>>>(this.visitsPath, {}); }
  private visitKey(projectId: string, branch: string) {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    return `${projectId}::${branch}`;
  }
  async getProjectVisit(userId: string, projectId: string, branch: string): Promise<ProjectVisit | null> {
    // A malformed id reads as absent, like readMeta — never a 500 on a probe.
    if (!PROJECT_ID_RE.test(projectId)) return null;
    const row = this.visits()[userId]?.[this.visitKey(projectId, branch)];
    return row ? this.clone({ userId, projectId, branch, ...row }) : null;
  }
  async setProjectVisit(v: ProjectVisit): Promise<void> {
    const m = this.visits();
    (m[v.userId] ||= {})[this.visitKey(v.projectId, v.branch)] = { head: v.head, at: v.at, promptedHead: v.promptedHead };
    this.write(this.visitsPath, m);
  }
  async deleteProjectVisits(projectId: string): Promise<void> {
    const prefix = `${this.visitKey(projectId, '')}`;
    const m = this.visits();
    let changed = false;
    for (const rows of Object.values(m)) {
      for (const k of Object.keys(rows)) if (k.startsWith(prefix)) { delete rows[k]; changed = true; }
    }
    if (changed) this.write(this.visitsPath, m);
  }

  // ---- project list: opens ----
  // Keyed `{ [userId]: { [projectId]: row } }`.
  private opens() { return this.read<Record<string, Record<string, { at: string | null; branch: string | null; hidden: boolean }>>>(this.opensPath, {}); }
  private openRow(userId: string, projectId: string, r: { at: string | null; branch: string | null; hidden: boolean }): ProjectOpen {
    return { userId, projectId, at: r.at ?? null, branch: r.branch ?? null, hidden: !!r.hidden };
  }
  async listProjectOpens(userId: string): Promise<ProjectOpen[]> {
    return Object.entries(this.opens()[userId] ?? {}).map(([projectId, r]) => this.openRow(userId, projectId, r));
  }
  async getProjectOpen(userId: string, projectId: string): Promise<ProjectOpen | null> {
    if (!PROJECT_ID_RE.test(projectId)) return null;
    const r = this.opens()[userId]?.[projectId];
    return r ? this.openRow(userId, projectId, r) : null;
  }
  async setProjectOpen(o: ProjectOpen): Promise<void> {
    if (!PROJECT_ID_RE.test(o.projectId)) throw new Error('bad project id');
    const m = this.opens();
    (m[o.userId] ||= {})[o.projectId] = { at: o.at, branch: o.branch, hidden: o.hidden };
    this.write(this.opensPath, m);
  }
  async deleteProjectOpen(userId: string, projectId: string): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    const m = this.opens();
    if (!m[userId]?.[projectId]) return;
    delete m[userId][projectId];
    this.write(this.opensPath, m);
  }
  async resetProjectOpenBranch(projectId: string, branch: string): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    const m = this.opens();
    let changed = false;
    for (const rows of Object.values(m)) {
      const r = rows[projectId];
      if (r && r.branch === branch) { r.branch = 'main'; changed = true; }
    }
    if (changed) this.write(this.opensPath, m);
  }
  async deleteProjectOpens(projectId: string): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    const m = this.opens();
    let changed = false;
    for (const rows of Object.values(m)) if (rows[projectId]) { delete rows[projectId]; changed = true; }
    if (changed) this.write(this.opensPath, m);
  }

  // ---- project list: activity ----
  // Keyed `{ [projectId]: { lastEdit, compile: { [branch]: mark } } }`.
  private activity() { return this.read<Record<string, { lastEdit: LastEdit | null; compile: Record<string, CompileMark> }>>(this.activityPath, {}); }
  async listProjectActivity(): Promise<ProjectActivity[]> {
    return Object.entries(this.activity()).map(([projectId, r]) => this.clone({ projectId, lastEdit: r.lastEdit ?? null, compile: r.compile ?? {} }));
  }
  async setLastEdit(projectId: string, lastEdit: LastEdit): Promise<void> {
    return this.setLastEdits([{ projectId, lastEdit }]);
  }
  // One rewrite of activity.json for the whole batch: the file holds every
  // project, so a write per project would be quadratic in the project count.
  async setLastEdits(entries: Array<{ projectId: string; lastEdit: LastEdit }>): Promise<void> {
    for (const { projectId } of entries) if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    const m = this.activity();
    let changed = false;
    for (const { projectId, lastEdit } of entries) {
      const row = (m[projectId] ||= { lastEdit: null, compile: {} });
      if (row.lastEdit && row.lastEdit.at >= lastEdit.at) continue;
      row.lastEdit = this.clone(lastEdit);
      changed = true;
    }
    if (changed) this.write(this.activityPath, m);
  }
  async setCompileMark(projectId: string, branch: string, mark: CompileMark | null): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    const m = this.activity();
    if (!mark) {
      if (!m[projectId]?.compile?.[branch]) return;
      delete m[projectId].compile[branch];
    } else {
      const row = (m[projectId] ||= { lastEdit: null, compile: {} });
      (row.compile ||= {})[branch] = this.clone(mark);
    }
    this.write(this.activityPath, m);
  }
  async deleteProjectActivity(projectId: string): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    const m = this.activity();
    if (!m[projectId]) return;
    delete m[projectId];
    this.write(this.activityPath, m);
  }

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
  async totalUsageSeconds(month: string) {
    let total = 0;
    for (const rec of Object.values(this.usage())) total += this.userMonths(rec)[month] ?? 0;
    return total;
  }
}
