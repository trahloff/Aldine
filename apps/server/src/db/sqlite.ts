import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { PROJECT_ID_RE } from '../util.js';
import { LINK_UNSUPPORTED, fsyncDir } from '../durable.js';
import { DamagedStoreFileError, JsonStore, type StoreDump } from './json.js';
import type { DataStore, User, EmailPending, TokenRecord, ProjectMeta, ProjectVisit, ProjectOpen, ProjectActivity, LastEdit, CompileMark, Comment, OAuthClient, RefreshTokenRecord, Invitation } from './types.js';

const INVITATION_ID_RE = /^[0-9a-f]{32}$/;

/** What `PRAGMA user_version` holds once the tables below exist. A file with
 *  a higher number was written by a newer Aldine. */
const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE users (
    id text PRIMARY KEY, email text UNIQUE, name text NOT NULL, salt text NOT NULL, hash text NOT NULL,
    created_at text NOT NULL, provider text, subject text UNIQUE, last_seen_at text,
    email_pending text, disabled_at text
  );
  CREATE TABLE sessions (sid text PRIMARY KEY, user_id text NOT NULL, exp integer NOT NULL);
  CREATE INDEX sessions_user_idx ON sessions(user_id);
  CREATE TABLE resets (token text PRIMARY KEY, user_id text NOT NULL, exp integer NOT NULL);
  CREATE TABLE tokens (
    id text PRIMARY KEY, user_id text NOT NULL, name text NOT NULL, hash text UNIQUE NOT NULL,
    project_ids text, created_at text NOT NULL, last_used_at text, expires_at text, revoked_at text,
    client_name text, family text
  );
  CREATE INDEX tokens_user_idx ON tokens(user_id);
  CREATE INDEX tokens_family_idx ON tokens(family);
  CREATE TABLE oauth_clients (
    id text PRIMARY KEY, name text NOT NULL, redirect_uris text NOT NULL,
    created_at text NOT NULL, last_used_at text NOT NULL
  );
  CREATE TABLE refresh_tokens (
    id text PRIMARY KEY, hash text UNIQUE NOT NULL, token_id text NOT NULL, user_id text NOT NULL,
    client_id text NOT NULL, family text NOT NULL, project_ids text, client_name text NOT NULL,
    expires_at text NOT NULL, used_at text, revoked_at text
  );
  CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family);
  CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);
  CREATE TABLE project_meta (id text PRIMARY KEY, created_at text NOT NULL, data text NOT NULL);
  CREATE TABLE comments (project_id text PRIMARY KEY, data text NOT NULL);
  CREATE TABLE usage (
    user_id text NOT NULL, month text NOT NULL, seconds real NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month)
  );
  CREATE TABLE connections (
    user_id text NOT NULL, provider text NOT NULL, data text NOT NULL,
    PRIMARY KEY (user_id, provider)
  );
  CREATE TABLE project_visits (
    user_id text NOT NULL, project_id text NOT NULL, branch text NOT NULL,
    head text NOT NULL, seen_at text NOT NULL, prompted_head text,
    PRIMARY KEY (user_id, project_id, branch)
  );
  CREATE INDEX project_visits_project_idx ON project_visits(project_id);
  CREATE TABLE project_opens (
    user_id text NOT NULL, project_id text NOT NULL, opened_at text, branch text,
    hidden integer NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, project_id)
  );
  CREATE INDEX project_opens_project_idx ON project_opens(project_id);
  CREATE TABLE project_activity (project_id text PRIMARY KEY, last_edit text, compile text NOT NULL DEFAULT '{}');
  CREATE TABLE invitations (
    id text PRIMARY KEY, project_id text NOT NULL, recipient text NOT NULL,
    invited_by text NOT NULL, created_at text NOT NULL, expires_at text NOT NULL,
    status text NOT NULL, responded_at text, emailed_at text
  );
  CREATE INDEX invitations_project_idx ON invitations(project_id);
  CREATE INDEX invitations_recipient_idx ON invitations(recipient);
  -- json_copied_at: when the JSON datastore beside the file was copied in.
  CREATE TABLE aldine_meta (key text PRIMARY KEY, value text NOT NULL);
`;

type Row = Record<string, any>;
type Sqlite = typeof import('node:sqlite');

/** node:sqlite, without the ExperimentalWarning Node 22 prints for it at
 *  every start: the module is pinned with the image's Node, and the
 *  conformance suite runs against it. Other warnings pass. */
export async function loadSqlite(): Promise<Sqlite> {
  const emit = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (String(text).startsWith('SQLite is an experimental feature')) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return await import('node:sqlite');
  } catch (err) {
    throw new Error(`The SQLite datastore needs Node 22.13 or newer, this is ${process.version} (${(err as Error).message}). Upgrade Node, or set ALDINE_DATASTORE=json.`, { cause: err });
  } finally {
    process.emitWarning = emit;
  }
}

/** An empty file only the server can read. SQLite gives aldine.db-wal and
 *  aldine.db-shm the mode of the database file, so they stay private too. */
function createPrivate(file: string): void {
  try {
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown): T => JSON.parse(String(v)) as T;

/**
 * SQLite DataStore: the default for a single node. One file in META_DIR,
 * `aldine.db`, written in transactions that SQLite makes durable, so a crash
 * or a volume going read-only keeps every write that returned. Typed columns
 * mirror PgStore's tables; project metadata, comments and other nested
 * values are JSON text.
 *
 * When the file does not exist yet and a JSON datastore sits beside it, its
 * records are copied in first, in one transaction, and the JSON files are
 * left as they were.
 *
 * Statements run synchronously, so a read-modify-write within one method
 * cannot interleave with another call in this process; one that spans
 * statements runs in BEGIN IMMEDIATE, which another process sharing the
 * file (the MCP stdio server) waits for.
 */
export class SqliteStore implements DataStore {
  private db!: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private depth = 0;

  /** `jsonRoot`: the META_DIR whose JSON datastore is copied in when `file` does not exist yet. */
  constructor(readonly file: string, private jsonRoot?: string) {}

  async init(): Promise<void> {
    const sqlite = await loadSqlite();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const size = fs.statSync(this.file, { throwIfNoEntry: false })?.size;
    if (!size && this.jsonRoot && JsonStore.lastWrite(this.jsonRoot) !== null) {
      // An empty file is a new database to SQLite: copying must not be skipped for one.
      if (size === 0) fs.rmSync(this.file);
      await this.copyJson(sqlite, this.jsonRoot);
    } else if (size === undefined) {
      createPrivate(this.file);
    }
    this.db = open(sqlite, this.file);
    if (this.jsonRoot) this.warnIfJsonChanged(this.jsonRoot);
  }

  async close(): Promise<void> {
    this.statements.clear();
    try { this.db?.close(); } catch { /* closed already */ }
  }

  async check(): Promise<void> {
    this.get(`SELECT 1 FROM users LIMIT 1`);
  }

  /** Fill a new file from the JSON datastore in `root` and put it in place.
   *  A damaged JSON file without a usable .bak stops it before anything is
   *  written, naming the file. */
  private async copyJson(sqlite: Sqlite, root: string): Promise<void> {
    const failed = (err: unknown) => new Error(`Copying the JSON datastore in ${root} into ${this.file} failed: ${String((err as Error).message).replace(/\.?$/, '.')} Nothing was changed, the JSON files are as they were. To keep running on them meanwhile, set ALDINE_DATASTORE=json.`, { cause: err });
    let dump: StoreDump;
    try {
      const from = new JsonStore(root);
      await from.init();
      dump = from.dump();
    } catch (err) {
      throw failed(err);
    }
    const tmp = `${this.file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    createPrivate(tmp);
    try {
      const into = new SqliteStore(tmp);
      into.db = open(sqlite, tmp);
      try {
        await into.load(dump);
      } finally {
        await into.close();
      }
      const fd = fs.openSync(tmp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // link() refuses an existing name: a second process that copied at the
      // same time keeps the first one's file.
      try {
        fs.linkSync(tmp, this.file);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (code === 'EEXIST') return;
        if (!LINK_UNSUPPORTED.has(code)) throw err;
        if (!fs.existsSync(this.file)) fs.renameSync(tmp, this.file);
      }
      fsyncDir(path.dirname(this.file));
    } catch (err) {
      throw failed(err);
    } finally {
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) fs.rmSync(f, { force: true });
    }
    console.log(`[aldine] datastore: copied ${dump.users.length} account(s) and ${dump.meta.length} project(s) from the JSON files in ${root} into ${this.file}. The JSON files are left as they were and are no longer written.`);
  }

  /** Every record of `d`, through the same methods as live writes, in one transaction. */
  private async load(d: StoreDump): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    // The file a record came from, for an error a hand-edited one can cause (a duplicate address, a bad id).
    const copy = async <T>(from: (item: T) => string, items: T[], write: (item: T) => Promise<unknown>) => {
      for (const item of items) {
        try { await write(item); } catch (err) { throw new Error(`${from(item)}: ${(err as Error).message}`, { cause: err }); }
      }
    };
    try {
      await copy(() => 'users.json', d.users, (u) => this.createUser(u));
      await copy(() => 'sessions.json', d.sessions, (s) => this.createSession(s.sid, s.userId, s.exp));
      await copy(() => 'resets.json', d.resets, (r) => this.createReset(r.token, r.userId, r.exp));
      await copy(() => 'tokens.json', d.tokens, (t) => this.createToken(t));
      await copy(() => 'oauth_clients.json', d.oauthClients, (c) => this.createOAuthClient(c));
      await copy(() => 'refresh_tokens.json', d.refreshTokens, (r) => this.createRefresh(r));
      await copy((m) => `meta/${m.id}.json`, d.meta, (m) => this.writeMeta(m));
      await copy((c) => `comments/${c.projectId}.json`, d.comments, (c) => this.saveComments(c.projectId, c.list));
      await copy(() => 'usage.json', d.usage, (u) => this.addUsageSeconds(u.userId, u.month, u.seconds));
      await copy(() => 'connections.json', d.connections, (c) => this.setConnection(c.userId, c.provider, c.data));
      await copy(() => 'visits.json', d.visits, (v) => this.setProjectVisit(v));
      await copy(() => 'opens.json', d.opens, (o) => this.setProjectOpen(o));
      await copy(() => 'activity.json', d.activity, async (a) => {
        if (a.lastEdit) await this.setLastEdit(a.projectId, a.lastEdit);
        for (const [branch, mark] of Object.entries(a.compile)) await this.setCompileMark(a.projectId, branch, mark);
      });
      await copy(() => 'invitations.json', d.invitations, (i) => this.setInvitation(i));
      const count = (table: string) => Number(this.get(`SELECT count(*) AS n FROM ${table}`)!.n);
      if (count('users') !== d.users.length) throw new Error(`${d.users.length} accounts read, ${count('users')} written`);
      if (count('project_meta') !== d.meta.length) throw new Error(`${d.meta.length} projects read, ${count('project_meta')} written`);
      this.run(`INSERT INTO aldine_meta(key,value) VALUES('json_copied_at',?1)`, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* SQLite rolled back already */ }
      throw err;
    } finally {
      this.depth--;
    }
  }

  /** Switching to ALDINE_DATASTORE=json and back again leaves this file without the JSON-side changes. */
  private warnIfJsonChanged(root: string): void {
    const copied = this.get(`SELECT value FROM aldine_meta WHERE key='json_copied_at'`)?.value;
    const last = JsonStore.lastWrite(root);
    if (!copied || last === null || last <= Date.parse(copied) + 1000) return;
    console.warn(`[aldine] datastore: the JSON files in ${root} changed after they were copied into ${this.file} on ${copied}, so those changes are not here. To copy them over instead, stop Aldine, move ${path.basename(this.file)} aside and start it again.`);
  }

  // ---- statements ----
  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) { s = this.db.prepare(sql); this.statements.set(sql, s); }
    return s;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] { return this.stmt(sql).all(...params) as Row[]; }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.stmt(sql).get(...params) as Row | undefined; }
  private run(sql: string, ...params: SQLInputValue[]): number { return Number(this.stmt(sql).run(...params).changes); }
  /** One write transaction; a call inside another joins it. */
  private tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const v = fn();
      this.db.exec('COMMIT');
      return v;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* SQLite rolled back already */ }
      throw err;
    } finally {
      this.depth--;
    }
  }

  // ---- users ----
  private rowToUser(r: Row): User {
    return { id: r.id, email: r.email, name: r.name, salt: r.salt, hash: r.hash, createdAt: r.created_at, provider: r.provider ?? undefined, subject: r.subject ?? undefined, lastSeenAt: r.last_seen_at ?? undefined, ...(r.email_pending ? { emailPending: parse<EmailPending>(r.email_pending) } : {}), ...(r.disabled_at ? { disabledAt: r.disabled_at } : {}) };
  }
  async createUser(u: User) {
    try {
      this.run(
        `INSERT INTO users(id,email,name,salt,hash,created_at,provider,subject,last_seen_at,email_pending,disabled_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
        u.id, u.email ?? null, u.name, u.salt, u.hash, u.createdAt, u.provider ?? null, u.subject ?? null, u.lastSeenAt ?? null, u.emailPending ? json(u.emailPending) : null, u.disabledAt ?? null,
      );
    } catch (err) {
      // The other backends' messages, so register() shows one error whatever the datastore.
      const msg = String((err as Error)?.message);
      if (msg.includes('UNIQUE constraint failed: users.subject')) throw new Error('An account for that identity already exists');
      if (msg.includes('UNIQUE constraint failed: users.email')) throw new Error('An account with that email already exists');
      throw err;
    }
  }
  async updateUser(u: User) {
    this.run(
      `UPDATE users SET email=?2,name=?3,salt=?4,hash=?5,created_at=?6,provider=?7,subject=?8,last_seen_at=?9,email_pending=?10 WHERE id=?1`,
      u.id, u.email ?? null, u.name, u.salt, u.hash, u.createdAt, u.provider ?? null, u.subject ?? null, u.lastSeenAt ?? null, u.emailPending ? json(u.emailPending) : null,
    );
  }
  async listUsers() { return this.all(`SELECT * FROM users ORDER BY created_at, id`).map((r) => this.rowToUser(r)); }
  async touchUser(id: string, lastSeenAt: string) { this.run(`UPDATE users SET last_seen_at=?2 WHERE id=?1`, id, lastSeenAt); }
  async setDisabled(id: string, disabledAt: string | null) { this.run(`UPDATE users SET disabled_at=?2 WHERE id=?1`, id, disabledAt); }
  async deleteUser(id: string) {
    this.tx(() => {
      for (const table of ['sessions', 'resets', 'tokens', 'refresh_tokens', 'connections', 'project_opens', 'project_visits']) {
        this.run(`DELETE FROM ${table} WHERE user_id=?1`, id);
      }
      this.run(`DELETE FROM users WHERE id=?1`, id);
    });
  }
  async setEmailPending(id: string, pending: EmailPending | null) {
    this.run(`UPDATE users SET email_pending=?2 WHERE id=?1`, id, pending ? json(pending) : null);
  }
  async getUser(id: string) { const r = this.get(`SELECT * FROM users WHERE id=?1`, id); return r ? this.rowToUser(r) : null; }
  async findUserByEmail(email: string) { const r = this.get(`SELECT * FROM users WHERE email=?1`, email); return r ? this.rowToUser(r) : null; }
  async findUserBySubject(subject: string) { const r = this.get(`SELECT * FROM users WHERE subject=?1`, subject); return r ? this.rowToUser(r) : null; }

  // ---- sessions ----
  async createSession(sid: string, userId: string, exp: number) {
    this.tx(() => {
      this.run(`DELETE FROM sessions WHERE exp < ?1`, Date.now());
      this.run(`INSERT INTO sessions(sid,user_id,exp) VALUES(?1,?2,?3)`, sid, userId, exp);
    });
  }
  async getSession(sid: string) {
    const r = this.get(`SELECT user_id, exp FROM sessions WHERE sid=?1`, sid);
    return r ? { userId: r.user_id as string, exp: Number(r.exp) } : null;
  }
  async deleteSession(sid: string) { this.run(`DELETE FROM sessions WHERE sid=?1`, sid); }
  async deleteSessionsForUser(userId: string) { this.run(`DELETE FROM sessions WHERE user_id=?1`, userId); }

  // ---- resets ----
  async createReset(token: string, userId: string, exp: number) {
    this.tx(() => {
      this.run(`DELETE FROM resets WHERE exp < ?1`, Date.now());
      this.run(`INSERT INTO resets(token,user_id,exp) VALUES(?1,?2,?3)`, token, userId, exp);
    });
  }
  async getReset(token: string) {
    const r = this.get(`SELECT user_id, exp FROM resets WHERE token=?1`, token);
    return r ? { userId: r.user_id as string, exp: Number(r.exp) } : null;
  }
  async deleteReset(token: string) { this.run(`DELETE FROM resets WHERE token=?1`, token); }

  // ---- personal access tokens ----
  private rowToToken(r: Row): TokenRecord {
    return {
      id: r.id, userId: r.user_id, name: r.name, hash: r.hash,
      projectIds: r.project_ids == null ? null : parse<string[]>(r.project_ids), createdAt: r.created_at,
      lastUsedAt: r.last_used_at ?? null, expiresAt: r.expires_at ?? null, revokedAt: r.revoked_at ?? null,
      clientName: r.client_name ?? null, family: r.family ?? null,
    };
  }
  async createToken(t: TokenRecord) {
    this.tx(() => {
      // Every refresh rotation leaves a revoked record behind; prune the
      // OAuth-minted ones a week after they were revoked. Expired-but-unrevoked
      // ones stay: their refresh token may be live and the record is the
      // user's only revoke handle in Account settings.
      this.run(`DELETE FROM tokens WHERE family IS NOT NULL AND revoked_at IS NOT NULL AND revoked_at < ?1`, new Date(Date.now() - 7 * 864e5).toISOString());
      this.run(
        `INSERT INTO tokens(id,user_id,name,hash,project_ids,created_at,last_used_at,expires_at,revoked_at,client_name,family) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
        t.id, t.userId, t.name, t.hash, t.projectIds ? json(t.projectIds) : null, t.createdAt, t.lastUsedAt ?? null, t.expiresAt ?? null, t.revokedAt ?? null, t.clientName ?? null, t.family ?? null,
      );
    });
  }
  async getToken(id: string) { const r = this.get(`SELECT * FROM tokens WHERE id=?1`, id); return r ? this.rowToToken(r) : null; }
  async getTokenByHash(hash: string) { const r = this.get(`SELECT * FROM tokens WHERE hash=?1`, hash); return r ? this.rowToToken(r) : null; }
  async listTokensForUser(userId: string) {
    return this.all(`SELECT * FROM tokens WHERE user_id=?1 ORDER BY created_at DESC`, userId).map((r) => this.rowToToken(r));
  }
  async updateToken(t: TokenRecord) {
    this.run(
      `UPDATE tokens SET user_id=?2,name=?3,hash=?4,project_ids=?5,created_at=?6,last_used_at=?7,expires_at=?8,revoked_at=?9,client_name=?10,family=?11 WHERE id=?1`,
      t.id, t.userId, t.name, t.hash, t.projectIds ? json(t.projectIds) : null, t.createdAt, t.lastUsedAt ?? null, t.expiresAt ?? null, t.revokedAt ?? null, t.clientName ?? null, t.family ?? null,
    );
  }
  async touchToken(id: string, lastUsedAt: string) { this.run(`UPDATE tokens SET last_used_at=?2 WHERE id=?1`, id, lastUsedAt); }
  async revokeTokensInFamily(family: string, revokedAt: string) {
    this.run(`UPDATE tokens SET revoked_at=?2 WHERE family=?1 AND revoked_at IS NULL`, family, revokedAt);
  }

  // ---- OAuth clients ----
  private rowToClient(r: Row): OAuthClient {
    return { id: r.id, name: r.name, redirectUris: parse<string[]>(r.redirect_uris), createdAt: r.created_at, lastUsedAt: r.last_used_at };
  }
  async createOAuthClient(c: OAuthClient) {
    this.run(`INSERT INTO oauth_clients(id,name,redirect_uris,created_at,last_used_at) VALUES(?1,?2,?3,?4,?5)`, c.id, c.name, json(c.redirectUris), c.createdAt, c.lastUsedAt);
  }
  async getOAuthClient(id: string) { const r = this.get(`SELECT * FROM oauth_clients WHERE id=?1`, id); return r ? this.rowToClient(r) : null; }
  async touchOAuthClient(id: string, lastUsedAt: string) { this.run(`UPDATE oauth_clients SET last_used_at=?2 WHERE id=?1`, id, lastUsedAt); }
  async countOAuthClients() { return Number(this.get(`SELECT count(*) AS n FROM oauth_clients`)?.n ?? 0); }
  async evictOldestOAuthClients(n: number) {
    if (n <= 0) return 0;
    return this.run(`DELETE FROM oauth_clients WHERE id IN (SELECT id FROM oauth_clients ORDER BY last_used_at ASC, id ASC LIMIT ?1)`, n);
  }

  // ---- OAuth refresh tokens ----
  private rowToRefresh(r: Row): RefreshTokenRecord {
    return {
      id: r.id, hash: r.hash, tokenId: r.token_id, userId: r.user_id, clientId: r.client_id, family: r.family,
      projectIds: r.project_ids == null ? null : parse<string[]>(r.project_ids), clientName: r.client_name, expiresAt: r.expires_at,
      usedAt: r.used_at ?? null, revokedAt: r.revoked_at ?? null,
    };
  }
  async createRefresh(r: RefreshTokenRecord) {
    this.tx(() => {
      this.run(`DELETE FROM refresh_tokens WHERE expires_at < ?1`, new Date(Date.now() - 7 * 864e5).toISOString());
      this.run(
        `INSERT INTO refresh_tokens(id,hash,token_id,user_id,client_id,family,project_ids,client_name,expires_at,used_at,revoked_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
        r.id, r.hash, r.tokenId, r.userId, r.clientId, r.family, r.projectIds ? json(r.projectIds) : null, r.clientName, r.expiresAt, r.usedAt ?? null, r.revokedAt ?? null,
      );
    });
  }
  async getRefreshByHash(hash: string) { const r = this.get(`SELECT * FROM refresh_tokens WHERE hash=?1`, hash); return r ? this.rowToRefresh(r) : null; }
  async markRefreshUsed(id: string, usedAt: string) {
    return this.run(`UPDATE refresh_tokens SET used_at=?2 WHERE id=?1 AND used_at IS NULL AND revoked_at IS NULL`, id, usedAt) === 1;
  }
  async revokeRefreshFamily(family: string, revokedAt: string) {
    this.run(`UPDATE refresh_tokens SET revoked_at=?2 WHERE family=?1 AND revoked_at IS NULL`, family, revokedAt);
  }
  async revokeCredentialsForUser(userId: string, revokedAt: string) {
    this.tx(() => {
      this.run(`UPDATE tokens SET revoked_at=?2 WHERE user_id=?1 AND revoked_at IS NULL`, userId, revokedAt);
      this.run(`UPDATE refresh_tokens SET revoked_at=?2 WHERE user_id=?1 AND revoked_at IS NULL`, userId, revokedAt);
    });
  }

  // ---- project meta ----
  // Same id discipline as the other backends: reads treat a malformed id as
  // absent, writes and deletes refuse it.
  async readMeta(id: string) {
    if (!PROJECT_ID_RE.test(id)) return null;
    const r = this.get(`SELECT data FROM project_meta WHERE id=?1`, id);
    return r ? parse<ProjectMeta>(r.data) : null;
  }
  async writeMeta(meta: ProjectMeta) {
    if (!PROJECT_ID_RE.test(meta.id)) throw new Error('bad project id');
    this.run(
      `INSERT INTO project_meta(id,created_at,data) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data, created_at=excluded.created_at`,
      meta.id, meta.createdAt, json(meta),
    );
  }
  async deleteMeta(id: string) {
    if (!PROJECT_ID_RE.test(id)) throw new Error('bad project id');
    this.run(`DELETE FROM project_meta WHERE id=?1`, id);
  }
  async addShareEntry(projectId: string, entry: string) {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    return this.tx(() => {
      const r = this.get(`SELECT data FROM project_meta WHERE id=?1`, projectId);
      if (!r) return false;
      const meta = parse<ProjectMeta>(r.data);
      const collaborators = meta.share?.collaborators ?? [];
      meta.share = { mode: meta.share?.mode ?? 'private', collaborators: collaborators.includes(entry) ? collaborators : [...collaborators, entry] };
      this.run(`UPDATE project_meta SET data=?2 WHERE id=?1`, projectId, json(meta));
      return true;
    });
  }
  async listMeta() {
    return this.all(`SELECT data FROM project_meta ORDER BY created_at DESC, id`).map((r) => parse<ProjectMeta>(r.data));
  }

  // ---- comments ----
  async loadComments(projectId: string) {
    if (!PROJECT_ID_RE.test(projectId)) return [];
    const r = this.get(`SELECT data FROM comments WHERE project_id=?1`, projectId);
    return r ? parse<Comment[]>(r.data) : [];
  }
  async saveComments(projectId: string, list: Comment[]) {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    this.run(`INSERT INTO comments(project_id,data) VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data`, projectId, json(list));
  }

  // ---- usage ----
  async getUsageSeconds(userId: string, month: string) {
    return Number(this.get(`SELECT seconds FROM usage WHERE user_id=?1 AND month=?2`, userId, month)?.seconds ?? 0);
  }
  async addUsageSeconds(userId: string, month: string, seconds: number) {
    this.run(
      `INSERT INTO usage(user_id,month,seconds) VALUES(?1,?2,?3) ON CONFLICT(user_id,month) DO UPDATE SET seconds = usage.seconds + excluded.seconds`,
      userId, month, seconds,
    );
  }
  async totalUsageSeconds(month: string) {
    return Number(this.get(`SELECT COALESCE(SUM(seconds),0) AS total FROM usage WHERE month=?1`, month)?.total ?? 0);
  }

  // ---- agent-review marks ----
  async getProjectVisit(userId: string, projectId: string, branch: string): Promise<ProjectVisit | null> {
    if (!PROJECT_ID_RE.test(projectId)) return null;
    const r = this.get(`SELECT head, seen_at, prompted_head FROM project_visits WHERE user_id=?1 AND project_id=?2 AND branch=?3`, userId, projectId, branch);
    return r ? { userId, projectId, branch, head: r.head, at: r.seen_at, promptedHead: r.prompted_head ?? null } : null;
  }
  async setProjectVisit(v: ProjectVisit): Promise<void> {
    if (!PROJECT_ID_RE.test(v.projectId)) throw new Error('bad project id');
    this.run(
      `INSERT INTO project_visits(user_id,project_id,branch,head,seen_at,prompted_head) VALUES(?1,?2,?3,?4,?5,?6)
       ON CONFLICT(user_id,project_id,branch) DO UPDATE SET head=excluded.head, seen_at=excluded.seen_at, prompted_head=excluded.prompted_head`,
      v.userId, v.projectId, v.branch, v.head, v.at, v.promptedHead ?? null,
    );
  }
  async deleteProjectVisits(projectId: string): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    this.run(`DELETE FROM project_visits WHERE project_id=?1`, projectId);
  }

  // ---- project list: opens ----
  private rowToOpen(r: Row): ProjectOpen {
    return { userId: r.user_id, projectId: r.project_id, at: r.opened_at ?? null, branch: r.branch ?? null, hidden: !!r.hidden };
  }
  async listProjectOpens(userId: string): Promise<ProjectOpen[]> {
    return this.all(`SELECT * FROM project_opens WHERE user_id=?1`, userId).map((r) => this.rowToOpen(r));
  }
  async getProjectOpen(userId: string, projectId: string): Promise<ProjectOpen | null> {
    if (!PROJECT_ID_RE.test(projectId)) return null;
    const r = this.get(`SELECT * FROM project_opens WHERE user_id=?1 AND project_id=?2`, userId, projectId);
    return r ? this.rowToOpen(r) : null;
  }
  async setProjectOpen(o: ProjectOpen): Promise<void> {
    if (!PROJECT_ID_RE.test(o.projectId)) throw new Error('bad project id');
    this.run(
      `INSERT INTO project_opens(user_id,project_id,opened_at,branch,hidden) VALUES(?1,?2,?3,?4,?5)
       ON CONFLICT(user_id,project_id) DO UPDATE SET opened_at=excluded.opened_at, branch=excluded.branch, hidden=excluded.hidden`,
      o.userId, o.projectId, o.at ?? null, o.branch ?? null, o.hidden ? 1 : 0,
    );
  }
  async deleteProjectOpen(userId: string, projectId: string): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    this.run(`DELETE FROM project_opens WHERE user_id=?1 AND project_id=?2`, userId, projectId);
  }
  async resetProjectOpenBranch(projectId: string, branch: string): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    this.run(`UPDATE project_opens SET branch='main' WHERE project_id=?1 AND branch=?2`, projectId, branch);
  }
  async deleteProjectOpens(projectId: string): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    this.run(`DELETE FROM project_opens WHERE project_id=?1`, projectId);
  }

  // ---- project list: activity ----
  async listProjectActivity(): Promise<ProjectActivity[]> {
    return this.all(`SELECT project_id, last_edit, compile FROM project_activity`).map((r) => ({
      projectId: r.project_id,
      lastEdit: r.last_edit == null ? null : parse<LastEdit>(r.last_edit),
      compile: parse<Record<string, CompileMark>>(r.compile ?? '{}'),
    }));
  }
  async setLastEdit(projectId: string, lastEdit: LastEdit): Promise<void> {
    return this.setLastEdits([{ projectId, lastEdit }]);
  }
  async setLastEdits(entries: Array<{ projectId: string; lastEdit: LastEdit }>): Promise<void> {
    for (const { projectId } of entries) if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    this.tx(() => { for (const { projectId, lastEdit } of entries) this.keepNewerEdit(projectId, lastEdit); });
  }
  private keepNewerEdit(projectId: string, lastEdit: LastEdit): void {
    this.run(
      `INSERT INTO project_activity(project_id,last_edit) VALUES(?1,?2)
       ON CONFLICT(project_id) DO UPDATE SET last_edit=excluded.last_edit
       WHERE project_activity.last_edit IS NULL OR json_extract(project_activity.last_edit,'$.at') < json_extract(excluded.last_edit,'$.at')`,
      projectId, json(lastEdit),
    );
  }
  async setCompileMark(projectId: string, branch: string, mark: CompileMark | null): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    // One key changed in place: two branches typesetting at once must not
    // overwrite each other's mark.
    this.tx(() => {
      const r = this.get(`SELECT compile FROM project_activity WHERE project_id=?1`, projectId);
      if (!r) {
        if (mark) this.run(`INSERT INTO project_activity(project_id,compile) VALUES(?1,?2)`, projectId, json({ [branch]: mark }));
        return;
      }
      const compile = parse<Record<string, CompileMark>>(r.compile ?? '{}');
      if (mark) compile[branch] = mark;
      else if (branch in compile) delete compile[branch];
      else return;
      this.run(`UPDATE project_activity SET compile=?2 WHERE project_id=?1`, projectId, json(compile));
    });
  }
  async deleteProjectActivity(projectId: string): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    this.run(`DELETE FROM project_activity WHERE project_id=?1`, projectId);
  }

  // ---- invitations ----
  private rowToInvitation(r: Row): Invitation {
    return {
      id: r.id, projectId: r.project_id, to: r.recipient, invitedBy: r.invited_by, createdAt: r.created_at,
      expiresAt: r.expires_at, status: r.status, respondedAt: r.responded_at ?? null, emailedAt: r.emailed_at ?? null,
    };
  }
  async setInvitation(inv: Invitation): Promise<void> {
    if (!INVITATION_ID_RE.test(inv.id)) throw new Error('bad invitation id');
    if (!PROJECT_ID_RE.test(inv.projectId)) throw new Error('bad project id');
    this.run(
      `INSERT INTO invitations(id,project_id,recipient,invited_by,created_at,expires_at,status,responded_at,emailed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
       ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, recipient=excluded.recipient, invited_by=excluded.invited_by,
         created_at=excluded.created_at, expires_at=excluded.expires_at, status=excluded.status, responded_at=excluded.responded_at, emailed_at=excluded.emailed_at`,
      inv.id, inv.projectId, inv.to, inv.invitedBy, inv.createdAt, inv.expiresAt, inv.status, inv.respondedAt ?? null, inv.emailedAt ?? null,
    );
  }
  async getInvitation(id: string): Promise<Invitation | null> {
    if (!INVITATION_ID_RE.test(id)) return null;
    const r = this.get(`SELECT * FROM invitations WHERE id=?1`, id);
    return r ? this.rowToInvitation(r) : null;
  }
  async listProjectInvitations(projectId: string): Promise<Invitation[]> {
    return this.all(`SELECT * FROM invitations WHERE project_id=?1 ORDER BY created_at, id`, projectId).map((r) => this.rowToInvitation(r));
  }
  async listInvitationsTo(to: string[]): Promise<Invitation[]> {
    if (!to.length) return [];
    return this.all(`SELECT * FROM invitations WHERE recipient IN (SELECT value FROM json_each(?1)) ORDER BY created_at, id`, json(to)).map((r) => this.rowToInvitation(r));
  }
  async settleInvitation(id: string, status: 'accepted' | 'declined' | 'withdrawn', at: string): Promise<boolean> {
    if (!INVITATION_ID_RE.test(id)) return false;
    return this.run(`UPDATE invitations SET status=?2, responded_at=?3 WHERE id=?1 AND status='pending'`, id, status, at) === 1;
  }
  async updatePendingInvitation(id: string, fields: { expiresAt?: string; emailedAt?: string }): Promise<boolean> {
    if (!INVITATION_ID_RE.test(id)) return false;
    return this.run(
      `UPDATE invitations SET expires_at=COALESCE(?2, expires_at), emailed_at=COALESCE(?3, emailed_at) WHERE id=?1 AND status='pending'`,
      id, fields.expiresAt ?? null, fields.emailedAt ?? null,
    ) === 1;
  }
  async deleteInvitation(id: string): Promise<void> {
    if (!INVITATION_ID_RE.test(id)) return;
    this.run(`DELETE FROM invitations WHERE id=?1`, id);
  }
  async deleteProjectInvitations(projectId: string): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    this.run(`DELETE FROM invitations WHERE project_id=?1`, projectId);
  }

  // ---- connections ----
  async getConnection(userId: string, provider: string) {
    const r = this.get(`SELECT data FROM connections WHERE user_id=?1 AND provider=?2`, userId, provider);
    return r ? parse<Record<string, unknown>>(r.data) : null;
  }
  async setConnection(userId: string, provider: string, data: Record<string, unknown>) {
    this.run(`INSERT INTO connections(user_id,provider,data) VALUES(?1,?2,?3) ON CONFLICT(user_id,provider) DO UPDATE SET data=excluded.data`, userId, provider, json(data));
  }
  async deleteConnection(userId: string, provider: string) {
    this.run(`DELETE FROM connections WHERE user_id=?1 AND provider=?2`, userId, provider);
  }
}

/** Open `file` for the store: WAL, a sync at every commit, the tables created
 *  on a new file. A file that is not a readable database fails here, naming
 *  it, rather than at the first request. */
function open(sqlite: Sqlite, file: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(file, { timeout: 5000 });
    // WAL lets a reader (a backup, the MCP stdio server) run beside a write;
    // FULL syncs the log at every commit, not only at checkpoints.
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=FULL');
    const problems = (db.prepare('PRAGMA quick_check').all() as Row[]).map((r) => String(r.quick_check));
    if (problems.join() !== 'ok') throw new Error(`quick_check: ${problems.slice(0, 3).join('; ')}`);
  } catch (err) {
    try { db?.close(); } catch { /* never opened */ }
    // SQLITE_CORRUPT, SQLITE_NOTADB, or a failed check: the file itself is
    // damaged. Anything else (no permission, locked) is not, and says so.
    const msg = (err as Error).message;
    const code = Number((err as { errcode?: number }).errcode) & 0xff;
    if (code === 11 || code === 26 || msg.startsWith('quick_check:')) {
      throw new DamagedStoreFileError(file, `Datastore file ${file} cannot be read (${msg}). Restore it from a backup (deploy/restore.sh; deploy/README.md, "Restore").`);
    }
    throw new Error(`Datastore file ${file} cannot be opened: ${msg}`, { cause: err });
  }
  try {
    migrate(db, file);
  } catch (err) {
    db.close();
    throw err;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* a volume without modes */ }
  return db;
}

function migrate(db: DatabaseSync, file: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version > SCHEMA_VERSION) {
      throw new Error(`Datastore file ${file} was written by a newer Aldine (schema ${version}; this one knows ${SCHEMA_VERSION}). Run that release again, or restore the backup taken before the upgrade.`);
    }
    if (version === 0) {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
