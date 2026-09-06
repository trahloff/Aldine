import { PROJECT_ID_RE } from '../util.js';
import type { DataStore, User, SessionRow, TokenRecord, ProjectMeta, Comment, OAuthClient, RefreshTokenRecord } from './types.js';

/**
 * Postgres DataStore — the horizontally-scalable backend. Multiple app nodes
 * share one database, so this (unlike the JSON backend) is safe across
 * processes and machines. Enabled by setting DATABASE_URL.
 *
 * `pg` is an optionalDependency loaded dynamically: the slim JSON default never
 * needs it installed. Users/sessions/resets are typed columns (indexed,
 * unique-constrained); project metadata and comments are JSONB (read/written
 * wholesale); usage is an upsert with an atomic increment.
 */
interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  end(): Promise<void>;
}

// Postgres rejects the U+0000 (NUL) character in both jsonb and text. Strip it
// from string VALUES during serialization (a replacer, not a regex over the
// escaped output — the latter corrupts values containing the literal text
// "\u0000"). Text columns are handled by stripNul at the query boundary below.
function jsonb(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'string' ? val.replace(/\u0000/g, '') : val));
}

/** Strip raw NUL from string query params so text columns (name/email/…) can't 500. */
function stripNulParams(params?: unknown[]): unknown[] | undefined {
  return params?.map((p) => (typeof p === 'string' ? p.replace(/\u0000/g, '') : p));
}

export class PgStore implements DataStore {
  private pool!: PgPool;

  constructor(private connectionString: string) {}

  async init(): Promise<void> {
    let Pg: any;
    try { Pg = await import('pg'); }
    catch { throw new Error('DATABASE_URL is set but the "pg" package is not installed. Run: npm i pg'); }
    const Pool = Pg.default?.Pool || Pg.Pool;
    const pool = new Pool({ connectionString: this.connectionString, max: Number(process.env.PG_POOL_MAX || 10) });
    // Route every query through a NUL-stripping wrapper so text columns (name,
    // email, …) can't 500 on a pasted U+0000 — jsonb() already guards jsonb columns.
    this.pool = { query: (text, params) => pool.query(text, stripNulParams(params)), end: () => pool.end() };
    // Postgres may still be starting when we come up (compose starts both at once).
    // Retry the first connection with backoff instead of crash-looping.
    for (let attempt = 1; ; attempt++) {
      try { await this.pool.query('SELECT 1'); break; }
      catch (err) {
        if (attempt >= 30) throw err;
        console.log(`[aldine] waiting for postgres (attempt ${attempt})…`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
        salt text NOT NULL, hash text NOT NULL, created_at text NOT NULL, provider text
      );
      CREATE TABLE IF NOT EXISTS sessions (
        sid text PRIMARY KEY, user_id text NOT NULL, exp bigint NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS resets (
        token text PRIMARY KEY, user_id text NOT NULL, exp bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        id text PRIMARY KEY, user_id text NOT NULL, name text NOT NULL,
        hash text UNIQUE NOT NULL, project_ids jsonb, created_at text NOT NULL,
        last_used_at text, expires_at text, revoked_at text
      );
      CREATE INDEX IF NOT EXISTS tokens_user_idx ON tokens(user_id);
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS client_name text;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS family text;
      CREATE INDEX IF NOT EXISTS tokens_family_idx ON tokens(family);
      CREATE TABLE IF NOT EXISTS oauth_clients (
        id text PRIMARY KEY, name text NOT NULL, redirect_uris jsonb NOT NULL,
        created_at text NOT NULL, last_used_at text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id text PRIMARY KEY, hash text UNIQUE NOT NULL, token_id text NOT NULL,
        user_id text NOT NULL, client_id text NOT NULL, family text NOT NULL,
        project_ids jsonb, client_name text NOT NULL, expires_at text NOT NULL,
        used_at text, revoked_at text
      );
      CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family);
      CREATE TABLE IF NOT EXISTS project_meta (
        id text PRIMARY KEY, created_at text NOT NULL, data jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        project_id text PRIMARY KEY, data jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        user_id text NOT NULL, month text NOT NULL, seconds double precision NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, month)
      );
      CREATE TABLE IF NOT EXISTS connections (
        user_id text NOT NULL, provider text NOT NULL, data jsonb NOT NULL,
        PRIMARY KEY (user_id, provider)
      );
      -- 0.6: accounts keyed by provider subject may have no email (ORCID).
      -- UNIQUE(email) still holds for non-null values; NULLs never collide.
      ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subject text;
      CREATE UNIQUE INDEX IF NOT EXISTS users_subject_idx ON users(subject);
    `);
  }
  async close(): Promise<void> { await this.pool?.end(); }

  // ---- users ----
  private rowToUser(r: any): User {
    return { id: r.id, email: r.email, name: r.name, salt: r.salt, hash: r.hash, createdAt: r.created_at, provider: r.provider ?? undefined, subject: r.subject ?? undefined };
  }
  async createUser(u: User) {
    try {
      await this.pool.query(
        `INSERT INTO users(id,email,name,salt,hash,created_at,provider,subject) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [u.id, u.email, u.name, u.salt, u.hash, u.createdAt, u.provider ?? null, u.subject ?? null],
      );
    } catch (err: any) {
      // Same messages as the JSON backend, so register() surfaces one
      // user-facing error regardless of datastore (unique_violation on
      // users.email or users_subject_idx).
      if (err?.code === '23505') {
        throw new Error(String(err.constraint).includes('subject') ? 'An account for that identity already exists' : 'An account with that email already exists');
      }
      throw err;
    }
  }
  async updateUser(u: User) {
    await this.pool.query(
      `UPDATE users SET email=$2,name=$3,salt=$4,hash=$5,created_at=$6,provider=$7,subject=$8 WHERE id=$1`,
      [u.id, u.email, u.name, u.salt, u.hash, u.createdAt, u.provider ?? null, u.subject ?? null],
    );
  }
  async getUser(id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
    return rows[0] ? this.rowToUser(rows[0]) : null;
  }
  async findUserByEmail(email: string) {
    const { rows } = await this.pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
    return rows[0] ? this.rowToUser(rows[0]) : null;
  }
  async findUserBySubject(subject: string) {
    const { rows } = await this.pool.query(`SELECT * FROM users WHERE subject=$1`, [subject]);
    return rows[0] ? this.rowToUser(rows[0]) : null;
  }

  // ---- sessions ----
  async createSession(sid: string, userId: string, exp: number) {
    await this.pool.query(`DELETE FROM sessions WHERE exp < $1`, [Date.now()]);
    await this.pool.query(`INSERT INTO sessions(sid,user_id,exp) VALUES($1,$2,$3)`, [sid, userId, exp]);
  }
  async getSession(sid: string) {
    const { rows } = await this.pool.query(`SELECT user_id, exp FROM sessions WHERE sid=$1`, [sid]);
    return rows[0] ? { userId: rows[0].user_id, exp: Number(rows[0].exp) } : null;
  }
  async deleteSession(sid: string) { await this.pool.query(`DELETE FROM sessions WHERE sid=$1`, [sid]); }
  async deleteSessionsForUser(userId: string) { await this.pool.query(`DELETE FROM sessions WHERE user_id=$1`, [userId]); }

  // ---- resets ----
  async createReset(token: string, userId: string, exp: number) {
    await this.pool.query(`DELETE FROM resets WHERE exp < $1`, [Date.now()]);
    await this.pool.query(`INSERT INTO resets(token,user_id,exp) VALUES($1,$2,$3)`, [token, userId, exp]);
  }
  async getReset(token: string) {
    const { rows } = await this.pool.query(`SELECT user_id, exp FROM resets WHERE token=$1`, [token]);
    return rows[0] ? { userId: rows[0].user_id, exp: Number(rows[0].exp) } : null;
  }
  async deleteReset(token: string) { await this.pool.query(`DELETE FROM resets WHERE token=$1`, [token]); }

  // ---- personal access tokens ----
  private rowToToken(r: any): TokenRecord {
    return {
      id: r.id, userId: r.user_id, name: r.name, hash: r.hash,
      projectIds: r.project_ids ?? null, createdAt: r.created_at,
      lastUsedAt: r.last_used_at ?? null, expiresAt: r.expires_at ?? null, revokedAt: r.revoked_at ?? null,
      clientName: r.client_name ?? null, family: r.family ?? null,
    };
  }
  async createToken(t: TokenRecord) {
    // Every refresh rotation leaves a revoked record behind; prune the
    // OAuth-minted ones a week after they were revoked. Expired-but-unrevoked
    // ones stay: their refresh token may be live and the record is the
    // user's only revoke handle in Account settings.
    await this.pool.query(
      `DELETE FROM tokens WHERE family IS NOT NULL AND revoked_at IS NOT NULL AND revoked_at < $1`,
      [new Date(Date.now() - 7 * 864e5).toISOString()],
    );
    await this.pool.query(
      `INSERT INTO tokens(id,user_id,name,hash,project_ids,created_at,last_used_at,expires_at,revoked_at,client_name,family)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [t.id, t.userId, t.name, t.hash, t.projectIds ? jsonb(t.projectIds) : null, t.createdAt, t.lastUsedAt, t.expiresAt, t.revokedAt, t.clientName ?? null, t.family ?? null],
    );
  }
  async getToken(id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM tokens WHERE id=$1`, [id]);
    return rows[0] ? this.rowToToken(rows[0]) : null;
  }
  async getTokenByHash(hash: string) {
    const { rows } = await this.pool.query(`SELECT * FROM tokens WHERE hash=$1`, [hash]);
    return rows[0] ? this.rowToToken(rows[0]) : null;
  }
  async listTokensForUser(userId: string) {
    const { rows } = await this.pool.query(`SELECT * FROM tokens WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
    return rows.map((r) => this.rowToToken(r));
  }
  async updateToken(t: TokenRecord) {
    await this.pool.query(
      `UPDATE tokens SET user_id=$2,name=$3,hash=$4,project_ids=$5,created_at=$6,last_used_at=$7,expires_at=$8,revoked_at=$9,client_name=$10,family=$11 WHERE id=$1`,
      [t.id, t.userId, t.name, t.hash, t.projectIds ? jsonb(t.projectIds) : null, t.createdAt, t.lastUsedAt, t.expiresAt, t.revokedAt, t.clientName ?? null, t.family ?? null],
    );
  }
  async touchToken(id: string, lastUsedAt: string) {
    await this.pool.query(`UPDATE tokens SET last_used_at=$2 WHERE id=$1`, [id, lastUsedAt]);
  }
  async revokeTokensInFamily(family: string, revokedAt: string) {
    await this.pool.query(`UPDATE tokens SET revoked_at=$2 WHERE family=$1 AND revoked_at IS NULL`, [family, revokedAt]);
  }

  // ---- OAuth clients ----
  private rowToClient(r: any): OAuthClient {
    return { id: r.id, name: r.name, redirectUris: r.redirect_uris, createdAt: r.created_at, lastUsedAt: r.last_used_at };
  }
  async createOAuthClient(c: OAuthClient) {
    await this.pool.query(
      `INSERT INTO oauth_clients(id,name,redirect_uris,created_at,last_used_at) VALUES($1,$2,$3,$4,$5)`,
      [c.id, c.name, jsonb(c.redirectUris), c.createdAt, c.lastUsedAt],
    );
  }
  async getOAuthClient(id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM oauth_clients WHERE id=$1`, [id]);
    return rows[0] ? this.rowToClient(rows[0]) : null;
  }
  async touchOAuthClient(id: string, lastUsedAt: string) {
    await this.pool.query(`UPDATE oauth_clients SET last_used_at=$2 WHERE id=$1`, [id, lastUsedAt]);
  }
  async countOAuthClients() {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM oauth_clients`);
    return Number(rows[0]?.n ?? 0);
  }
  async evictOldestOAuthClients(n: number) {
    if (n <= 0) return 0;
    const { rows } = await this.pool.query(
      `DELETE FROM oauth_clients WHERE id IN (SELECT id FROM oauth_clients ORDER BY last_used_at ASC, id ASC LIMIT $1) RETURNING id`,
      [n],
    );
    return rows.length;
  }

  // ---- OAuth refresh tokens ----
  private rowToRefresh(r: any): RefreshTokenRecord {
    return {
      id: r.id, hash: r.hash, tokenId: r.token_id, userId: r.user_id, clientId: r.client_id, family: r.family,
      projectIds: r.project_ids ?? null, clientName: r.client_name, expiresAt: r.expires_at,
      usedAt: r.used_at ?? null, revokedAt: r.revoked_at ?? null,
    };
  }
  async createRefresh(r: RefreshTokenRecord) {
    await this.pool.query(`DELETE FROM refresh_tokens WHERE expires_at < $1`, [new Date(Date.now() - 7 * 864e5).toISOString()]);
    await this.pool.query(
      `INSERT INTO refresh_tokens(id,hash,token_id,user_id,client_id,family,project_ids,client_name,expires_at,used_at,revoked_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.id, r.hash, r.tokenId, r.userId, r.clientId, r.family, r.projectIds ? jsonb(r.projectIds) : null, r.clientName, r.expiresAt, r.usedAt, r.revokedAt],
    );
  }
  async getRefreshByHash(hash: string) {
    const { rows } = await this.pool.query(`SELECT * FROM refresh_tokens WHERE hash=$1`, [hash]);
    return rows[0] ? this.rowToRefresh(rows[0]) : null;
  }
  async markRefreshUsed(id: string, usedAt: string) {
    const { rows } = await this.pool.query(
      `UPDATE refresh_tokens SET used_at=$2 WHERE id=$1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [id, usedAt],
    );
    return rows.length === 1;
  }
  async revokeRefreshFamily(family: string, revokedAt: string) {
    await this.pool.query(`UPDATE refresh_tokens SET revoked_at=$2 WHERE family=$1 AND revoked_at IS NULL`, [family, revokedAt]);
  }

  // ---- project meta ----
  // Same id discipline as the JSON backend: reads treat a malformed id as
  // absent, writes/deletes refuse it (matches JsonStore.metaPath semantics).
  async readMeta(id: string) {
    if (!PROJECT_ID_RE.test(id)) return null;
    const { rows } = await this.pool.query(`SELECT data FROM project_meta WHERE id=$1`, [id]);
    return rows[0] ? (rows[0].data as ProjectMeta) : null;
  }
  async writeMeta(meta: ProjectMeta) {
    if (!PROJECT_ID_RE.test(meta.id)) throw new Error('bad project id');
    await this.pool.query(
      `INSERT INTO project_meta(id,created_at,data) VALUES($1,$2,$3)
       ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, created_at=EXCLUDED.created_at`,
      [meta.id, meta.createdAt, jsonb(meta)],
    );
  }
  async deleteMeta(id: string) {
    if (!PROJECT_ID_RE.test(id)) throw new Error('bad project id');
    await this.pool.query(`DELETE FROM project_meta WHERE id=$1`, [id]);
  }
  async listMeta() {
    const { rows } = await this.pool.query(`SELECT data FROM project_meta ORDER BY created_at DESC`);
    return rows.map((r) => r.data as ProjectMeta);
  }

  // ---- comments ----
  async loadComments(projectId: string) {
    if (!PROJECT_ID_RE.test(projectId)) return [];
    const { rows } = await this.pool.query(`SELECT data FROM comments WHERE project_id=$1`, [projectId]);
    return rows[0] ? (rows[0].data as Comment[]) : [];
  }
  async saveComments(projectId: string, list: Comment[]) {
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('bad project id');
    await this.pool.query(
      `INSERT INTO comments(project_id,data) VALUES($1,$2)
       ON CONFLICT(project_id) DO UPDATE SET data=EXCLUDED.data`,
      [projectId, jsonb(list)],
    );
  }

  // ---- usage ----
  async getUsageSeconds(userId: string, month: string) {
    const { rows } = await this.pool.query(`SELECT seconds FROM usage WHERE user_id=$1 AND month=$2`, [userId, month]);
    return rows[0] ? Number(rows[0].seconds) : 0;
  }
  async addUsageSeconds(userId: string, month: string, seconds: number) {
    await this.pool.query(
      `INSERT INTO usage(user_id,month,seconds) VALUES($1,$2,$3)
       ON CONFLICT(user_id,month) DO UPDATE SET seconds = usage.seconds + EXCLUDED.seconds`,
      [userId, month, seconds],
    );
  }

  // ---- connections ----
  async getConnection(userId: string, provider: string) {
    const { rows } = await this.pool.query(`SELECT data FROM connections WHERE user_id=$1 AND provider=$2`, [userId, provider]);
    return rows[0] ? (rows[0].data as Record<string, unknown>) : null;
  }
  async setConnection(userId: string, provider: string, data: Record<string, unknown>) {
    await this.pool.query(
      `INSERT INTO connections(user_id,provider,data) VALUES($1,$2,$3)
       ON CONFLICT(user_id,provider) DO UPDATE SET data=EXCLUDED.data`,
      [userId, provider, jsonb(data)],
    );
  }
  async deleteConnection(userId: string, provider: string) {
    await this.pool.query(`DELETE FROM connections WHERE user_id=$1 AND provider=$2`, [userId, provider]);
  }
}
