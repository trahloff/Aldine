import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.js';
import * as gitops from './gitops.js';
import * as zotero from './zotero.js';
import { compileProject, synctexLookup } from './compile.js';
import * as usage from './usage.js';
import * as github from './github.js';
import { flushBranchDocs, refreshBranchDocsFromDisk, evictDoc, scheduleCommit, closeProjectConnections, bumpContentVersion, contentVersion } from './collab.js';
import { publishProjectEvent } from './events.js';
import { parseBib, bibKeys, BibEntry } from './bib.js';
import { listPlugins, pluginAssetPath } from './plugins.js';
import { listTemplates, templateFiles } from './templates.js';
import { fetchBibEntry, searchWorks } from './references.js';
import { unzip, guessRoot } from './unzip.js';
import { aiConfigured, aiModel, diagnose } from './ai.js';
import * as comments from './comments.js';
import * as auth from './auth.js';
import * as oauth from './oauth.js';
import * as email from './email.js';
import { canAccess, isListed, isMember, isOwner, ownerName } from './authz.js';
import { loginLimiter, registerLimiter, aiLimiter, refLimiter, compileGate, clientKey } from './ratelimit.js';
import { safeJoin, isTextFile, newId, BRANCH_RE } from './util.js';

type Q = { branch?: string; path?: string; name?: string; force?: string };

/**
 * Current user for a request. Resolved once per request by an onRequest hook
 * (which awaits the async datastore) and cached on the request, so the many
 * call sites stay synchronous.
 */
function reqUser(req: any): auth.PublicUser | null {
  return req._user ?? null;
}

/** Validate an email/password body before it reaches auth (avoids leaking
 *  internal TypeErrors on malformed requests, and caps lengths). Returns an
 *  error message, or null when the shape is acceptable. */
function badCredentials(body: { email?: unknown; password?: unknown } | undefined): string | null {
  const email = body?.email, password = body?.password;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return 'Email and password are required';
  }
  if (email.length > 254) return 'Email is too long';
  if (password.length > 1024) return 'Password is too long';
  return null;
}

function oauthProviders(): Array<{ id: string; label: string }> {
  return oauth.configuredProviders().map((p) => ({ id: p.id, label: p.label }));
}
/** Public origin for OAuth redirects — ALDINE_PUBLIC_URL, else derived from the request. */
function publicBase(req: FastifyRequest): string {
  if (process.env.ALDINE_PUBLIC_URL) return process.env.ALDINE_PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
  return `${proto}://${host}`;
}

/** Last HEAD we successfully pushed per project — lets auto-sync skip a no-op
 *  network push. In-memory (single-node); cleared on restart → push-when-unsure. */
const lastPushedHead = new Map<string, string>();

/** git internals and compile output are never user-addressable — at any depth. */
function isHiddenPath(rel: string): boolean {
  // Check every segment: 'sub/.git/config' and 'paper/.aldine-out/x' must be
  // caught too, not just a leading '.git'. Matches store.listFiles, which skips
  // these names at every level.
  return rel.split(/[\\/]/).some((seg) => seg === '.git' || seg.startsWith('.aldine'));
}

/** "<root file's dir>/<name>" — where \addbibresource{<name>} actually resolves. */
function rootSiblingPath(rootFile: string, name: string): string {
  const dir = path.dirname(rootFile || 'main.tex');
  return dir === '.' ? name : path.posix.join(dir, name);
}

async function publicMeta(meta: store.ProjectMeta, user?: auth.PublicUser | null) {
  const { zotero: z, ownerId, share, ...rest } = meta;
  // The collaborator roster is the owner's private list of invitee email
  // addresses — never hand it to the other people who can open the project
  // (link visitors most of all). Everyone else sees the mode only.
  const owner = user !== undefined && isOwner(meta, user);
  return {
    ...rest,
    share: share && (owner ? share : { mode: share.mode, collaborators: [] }),
    ownerId,
    ownerName: await ownerName(meta),
    isOwner: user !== undefined ? isOwner(meta, user) : undefined,
    isMember: user !== undefined ? isMember(meta, user) : undefined,
    zotero: z ? {
      libraryPrefix: z.libraryPrefix,
      collectionKey: z.collectionKey,
      bibFile: z.bibFile,
      lastSyncedAt: z.lastSyncedAt,
      username: z.username,
    } : null,
  };
}

/**
 * Guards for routes the global preHandler's canAccess is too weak for. Link
 * mode says "anyone signed in with the link can edit" — the document, not the
 * project. Reconfiguring it, or reaching through it into the owner's linked
 * Zotero/GitHub accounts, needs membership or ownership. Both return null
 * after replying 403, so callers do: `const meta = await requireX(...); if
 * (!meta) return;`
 */
async function requireMember(req: any, reply: any, action: string): Promise<store.ProjectMeta | null> {
  const meta = await store.readMeta(req.params.id);
  if (!isMember(meta, reqUser(req))) {
    reply.code(403).send({ error: `Only the owner and collaborators can ${action}` });
    return null;
  }
  return meta;
}

async function requireOwner(req: any, reply: any, action: string): Promise<store.ProjectMeta | null> {
  const meta = await store.readMeta(req.params.id);
  if (!isOwner(meta, reqUser(req))) {
    reply.code(403).send({ error: `Only the owner can ${action}` });
    return null;
  }
  return meta;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, name: 'aldine' }));

  // ---------- auth (env-gated) ----------
  app.get('/api/auth/me', async (req) => ({ authEnabled: auth.AUTH_ENABLED, passwordAuth: !auth.SSO_ONLY, user: reqUser(req), providers: oauthProviders() }));

  /** 403 when password sign-in is disabled (SSO-only mode). */
  const passwordDisabled = (reply: any) => reply.code(403).send({ error: 'Password sign-in is disabled — use single sign-on.' });

  app.post<{ Body: { email: string; password: string; name?: string } }>('/api/auth/register', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    if (!(await registerLimiter.take(clientKey(req)))) return reply.code(429).send({ error: 'Too many accounts created — try again later' });
    const bad = badCredentials(req.body);
    if (bad) return reply.code(400).send({ error: bad });
    try {
      const user = await auth.register(req.body.email, req.body.password, req.body.name);
      reply.header('set-cookie', auth.sessionCookie(await auth.createSession(user.id)));
      // Fire-and-forget a simple welcome email (no verification step). Never let
      // a mail failure affect the signup response.
      const base = process.env.ALDINE_PUBLIC_URL?.replace(/\/$/, '');
      if (email.emailConfigured() && base) {
        const greeting = user.name ? `Hi ${user.name},` : 'Hi there,';
        email.sendMail({
          to: user.email,
          subject: 'Welcome to Aldine',
          text: `${greeting}\n\nWelcome to Aldine — write LaTeX together, fast, versioned, and yours.\n\nOpen your workspace: ${base}\n\nStart a blank paper or a template, import a project from GitHub or an Overleaf ZIP, then hit ⌘S to typeset. Invite others and you'll see their cursors live.\n\nHappy writing.`,
          html: `<p>${greeting}</p><p>Welcome to <strong>Aldine</strong> — write LaTeX together, fast, versioned, and yours.</p><p><a href="${base}">Open your workspace</a></p><p>Start a blank paper or a template, import a project from GitHub or an Overleaf ZIP, then hit ⌘S to typeset. Invite others and you'll see their cursors live.</p><p>Happy writing.</p>`,
        }).catch((err) => console.error('[aldine] welcome email failed:', err?.message || err));
      }
      return { user };
    } catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  app.post<{ Body: { email: string; password: string } }>('/api/auth/login', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    if (!(await loginLimiter.take(clientKey(req)))) return reply.code(429).send({ error: 'Too many attempts — wait a moment and try again' });
    if (badCredentials(req.body)) return reply.code(400).send({ error: 'Email and password are required' });
    try {
      const user = await auth.login(req.body.email, req.body.password);
      reply.header('set-cookie', auth.sessionCookie(await auth.createSession(user.id)));
      return { user };
    } catch (err: any) { return reply.code(401).send({ error: err.message }); }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await auth.destroySession(auth.sidFromRequest(req.headers.cookie)); // revoke this session server-side
    reply.header('set-cookie', auth.clearCookie());
    return { ok: true };
  });

  // change password (logged in): revokes all sessions, then re-issues the current one
  app.post<{ Body: { currentPassword: string; newPassword: string } }>('/api/auth/password', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    const user = reqUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    try {
      await auth.changePassword(user.id, req.body?.currentPassword || '', req.body?.newPassword || '');
      reply.header('set-cookie', auth.sessionCookie(await auth.createSession(user.id)));
      return { ok: true };
    } catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  // forgot-password: issue a reset token. Emailed if SMTP is configured; otherwise
  // logged server-side and (when ALDINE_RESET_ECHO=1) returned for self-host relay.
  app.post<{ Body: { email: string } }>('/api/auth/reset-request', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    if (!(await loginLimiter.take(clientKey(req)))) return reply.code(429).send({ error: 'Too many attempts — wait a moment' });
    const r = await auth.requestReset(req.body?.email || '');
    if (r) {
      // Build the reset link from the CONFIGURED public URL only — never the
      // request Host/X-Forwarded-Host, which an attacker controls and could use
      // to redirect the victim's valid token to their own domain (takeover).
      const base = process.env.ALDINE_PUBLIC_URL?.replace(/\/$/, '');
      const link = `${base}/?reset_token=${encodeURIComponent(r.token)}`;
      if (email.emailConfigured() && base) {
        // send in the background so the response time doesn't leak whether the
        // address exists, and a slow SMTP/SES call can't hang the request
        email.sendMail({
          to: r.user.email,
          subject: 'Reset your Aldine password',
          text: `Someone requested a password reset for your Aldine account.\n\nOpen this link to set a new password (expires in 1 hour):\n${link}\n\nOr enter this token manually: ${r.token}\n\nIf you didn't request this, you can ignore this email.`,
          html: `<p>Someone requested a password reset for your Aldine account.</p><p><a href="${link}">Set a new password</a> (expires in 1 hour).</p><p>Or enter this token manually: <code>${r.token}</code></p><p>If you didn't request this, you can ignore this email.</p>`,
        }).catch((err) => console.error('[aldine] reset email failed:', err?.message || err));
      } else {
        // no transport, or no ALDINE_PUBLIC_URL to build a trusted link → don't
        // email a host-derived (poisonable) link; log the token for manual relay
        console.log(`[aldine] password reset for ${r.user.email}: token=${r.token} (set ALDINE_PUBLIC_URL + an email transport to send links; relay manually, expires in 1h)`);
      }
    }
    // never reveal whether the email exists
    return process.env.ALDINE_RESET_ECHO === '1' && r ? { ok: true, token: r.token } : { ok: true };
  });

  app.post<{ Body: { token: string; newPassword: string } }>('/api/auth/reset', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    try {
      await auth.resetPassword(req.body?.token || '', req.body?.newPassword || '');
      return { ok: true };
    } catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  // ---------- SSO / OAuth (each provider gated on its client id/secret) ----------
  app.get<{ Params: { provider: string } }>('/api/auth/oauth/:provider', async (req, reply) => {
    const provider = auth.AUTH_ENABLED ? oauth.getProvider(req.params.provider) : undefined;
    if (!provider) return reply.code(404).send({ error: 'This sign-in provider is not configured' });
    const state = crypto.randomBytes(12).toString('hex');
    reply.header('set-cookie', `aldine_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${auth.SECURE_COOKIES ? '; Secure' : ''}`);
    const redirect = `${publicBase(req)}/api/auth/oauth/${provider.id}/callback`;
    return reply.redirect(provider.authorizeUrl(state, redirect));
  });

  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string } }>(
    '/api/auth/oauth/:provider/callback', async (req, reply) => {
      const provider = auth.AUTH_ENABLED ? oauth.getProvider(req.params.provider) : undefined;
      if (!provider) return reply.code(404).send({ error: 'This sign-in provider is not configured' });
      const cookies = auth.parseCookies(req.headers.cookie);
      if (!req.query.code || !req.query.state || req.query.state !== cookies.aldine_oauth_state) {
        return reply.code(400).send({ error: 'OAuth state mismatch — please try again' });
      }
      try {
        const profile = await provider.exchange(req.query.code, `${publicBase(req)}/api/auth/oauth/${provider.id}/callback`);
        const user = await auth.findOrCreateOAuth(profile.email, profile.name, provider.id);
        reply.header('set-cookie', [auth.sessionCookie(await auth.createSession(user.id)), 'aldine_oauth_state=; Path=/; Max-Age=0']);
        return reply.redirect('/');
      } catch (err: any) {
        return reply.code(400).send({ error: `${provider.label} sign-in failed: ${err.message}` });
      }
    });

  // Resolve the request's user once (awaiting the async datastore) and cache it,
  // so reqUser() is a synchronous read everywhere downstream.
  app.addHook('onRequest', async (req) => {
    (req as any)._user = auth.AUTH_ENABLED ? await auth.userFromRequest(req.headers.cookie) : null;
  });

  // Global guard: enforce project access when auth is on. Runs after routing,
  // so it uses the DECODED :id param — never a regex over the raw (still
  // percent-encoded) URL, which a `%61bc…` id would slip past.
  app.addHook('preHandler', async (req, reply) => {
    const reqId = (req.params as { id?: string } | undefined)?.id;
    // Trashed projects behave as gone for every route except restore and
    // delete (purge) — works with or without auth.
    if (reqId !== undefined) {
      let m: store.ProjectMeta | null = null;
      try { m = await store.readMeta(reqId); } catch { /* handled below / by the route */ }
      const p = req.url.split('?')[0];
      if (m?.deletedAt && !(p.endsWith('/restore') || (req.method === 'DELETE' && p === `/api/projects/${reqId}`))) {
        return reply.code(404).send({ error: 'project not found' });
      }
    }
    if (!auth.AUTH_ENABLED) return;
    const id = reqId;
    if (id !== undefined) {
      let meta: store.ProjectMeta;
      try { meta = await store.readMeta(id); } catch { return reply.code(404).send({ error: 'project not found' }); }
      const user = reqUser(req);
      if (!user) return reply.code(401).send({ error: 'Sign in required' });
      if (!canAccess(meta, user)) return reply.code(403).send({ error: 'You do not have access to this project' });
      return;
    }
    // non-id routes: require sign-in for the project list / create / import
    const path = req.url.split('?')[0];
    if (/^\/api\/projects(\/import|\/trash)?$/.test(path) && !reqUser(req)) {
      return reply.code(401).send({ error: 'Sign in required' });
    }
  });

  // ---------- projects ----------
  app.get('/api/projects', async (req) => {
    const user = reqUser(req);
    return Promise.all((await store.listProjects()).filter((m) => !m.deletedAt && isListed(m, user)).map((m) => publicMeta(m, user)));
  });

  // Trash: soft-deleted projects the user owns, newest first. Restorable until purge (~30 days).
  app.get('/api/projects/trash', async (req) => {
    const user = reqUser(req);
    const mine = (await store.listProjects()).filter((m) => !!m.deletedAt && (auth.AUTH_ENABLED ? isOwner(m, user) : true));
    mine.sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
    return mine.map((m) => ({ id: m.id, name: m.name, deletedAt: m.deletedAt }));
  });

  app.post<{ Body: { name?: string; files?: Record<string, string>; template?: string } }>('/api/projects', async (req, reply) => {
    const { name = 'Untitled Project', files, template } = req.body || {};
    let seed = files;
    if (template) {
      try {
        seed = templateFiles(template);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    }
    const meta = await store.createProject(name, seed, reqUser(req)?.id);
    return publicMeta(meta, reqUser(req));  // Promise; Fastify awaits
  });

  // ---------- sharing (owner only) ----------
  app.post<{ Params: { id: string }; Body: { mode?: 'private' | 'link'; collaborators?: string[] } }>(
    '/api/projects/:id/share', async (req, reply) => {
      const meta = await store.readMeta(req.params.id);
      if (!isOwner(meta, reqUser(req))) return reply.code(403).send({ error: 'Only the owner can change sharing' });
      const mode = req.body?.mode === 'link' ? 'link' : 'private';
      const collaborators = Array.isArray(req.body?.collaborators)
        ? req.body!.collaborators.map((c) => c.trim().toLowerCase()).filter((c) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c)).slice(0, 50)
        : (meta.share?.collaborators || []);
      meta.share = { mode, collaborators };
      await store.writeMeta(meta);
      // Access is checked when a collab socket connects, so a session already
      // in the document would survive being revoked. Drop this project's
      // sockets: clients reconnect and re-authenticate, which re-runs the
      // check — the still-allowed resume, the revoked are refused. The event
      // reaches peer nodes (multi-node deploys) with the same effect.
      closeProjectConnections(meta.id);
      publishProjectEvent({ type: 'access-changed', projectId: meta.id });
      return publicMeta(meta, reqUser(req));
    });

  // Claim an ownerless legacy project (created before auth was enabled).
  // First successful claim wins: the claimer becomes owner, sharing resets to
  // private (any pre-existing share config was authorless), and everyone
  // else's access ends — live sessions included, on every node.
  const claiming = new Set<string>(); // in-process mutex: one node resolves races deterministically
  app.post<{ Params: { id: string } }>('/api/projects/:id/claim', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Claiming applies only when accounts are enabled' });
    const user = reqUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    if (claiming.has(req.params.id)) return reply.code(409).send({ error: 'Someone else is claiming this project' });
    claiming.add(req.params.id);
    try {
      const meta = await store.readMeta(req.params.id); // re-read inside the mutex
      if (meta.ownerId) return reply.code(409).send({ error: 'This project already has an owner' });
      meta.ownerId = user.id;
      meta.share = { mode: 'private', collaborators: [] };
      await store.writeMeta(meta);
      closeProjectConnections(meta.id);
      publishProjectEvent({ type: 'access-changed', projectId: meta.id });
      return publicMeta(meta, user);
    } finally {
      claiming.delete(req.params.id);
    }
  });

  // Test hook (never in production): strip ownership so the e2e suite can
  // fabricate the pre-auth legacy state against a fully materialized project.
  // Same env-gating idiom as ALDINE_RESET_ECHO.
  if (process.env.ALDINE_TEST_HOOKS === '1') {
    app.post<{ Params: { id: string } }>('/api/projects/:id/disown', async (req) => {
      const meta = await store.readMeta(req.params.id);
      delete meta.ownerId;
      delete meta.share;
      await store.writeMeta(meta);
      return { ok: true };
    });
  }

  app.get('/api/templates', async () => listTemplates());

  // Import an Overleaf/project ZIP (base64) as a new project.
  app.post<{ Body: { name?: string; zipBase64: string } }>('/api/projects/import', async (req, reply) => {
    const { name, zipBase64 } = req.body || {};
    if (!zipBase64) return reply.code(400).send({ error: 'zipBase64 required' });
    try {
      const buf = Buffer.from(zipBase64, 'base64');
      if (buf.length > 60 * 1024 * 1024) return reply.code(413).send({ error: 'ZIP too large (max 60 MB)' });
      const entries = unzip(buf);
      const paths = Object.keys(entries).filter((p) => !p.includes('..') && !p.startsWith('/') && !p.startsWith('__MACOSX/') && !isHiddenPath(p));
      if (!paths.length) return reply.code(400).send({ error: 'ZIP had no usable files' });
      // create with text files seeded; write binaries as buffers afterward
      const textFiles: Record<string, string> = {};
      const binFiles: string[] = [];
      for (const p of paths) {
        const data = entries[p];
        // treat as text only if the extension says so AND there's no NUL byte in the head
        const looksBinary = data.subarray(0, 8000).includes(0);
        if (isTextFile(p) && !looksBinary) textFiles[p] = data.toString('utf8');
        else binFiles.push(p);
      }
      const meta = await store.createProject(name || 'Imported project', textFiles, reqUser(req)?.id);
      for (const p of binFiles) store.writeFile(meta.id, 'main', p, entries[p]);
      if (binFiles.length) await gitops.commitAll(meta.id, 'main', 'aldine: import assets').catch(() => {});
      const root = guessRoot(entries);
      if (root) { meta.rootFile = root; await store.writeMeta(meta); }
      return publicMeta(meta, reqUser(req));
    } catch (err: any) {
      return reply.code(400).send({ error: `Could not import ZIP: ${err.message}` });
    }
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    try {
      const meta = await store.readMeta(req.params.id);
      const branches = await gitops.listBranches(meta.id);
      return { ...(await publicMeta(meta, reqUser(req))), branches };
    } catch {
      return reply.code(404).send({ error: 'project not found' });
    }
  });

  app.patch<{ Params: { id: string }; Body: Partial<Pick<store.ProjectMeta, 'name' | 'rootFile' | 'engine'>> }>(
    '/api/projects/:id', async (req, reply) => {
      const meta = await requireMember(req, reply, 'rename or reconfigure this project');
      if (!meta) return;
      const { name, rootFile, engine } = req.body || {};
      if (name !== undefined) {
        const trimmed = String(name).trim();
        if (!trimmed) return reply.code(400).send({ error: 'Project name cannot be empty' });
        if (trimmed.length > 200) return reply.code(400).send({ error: 'Project name is too long (max 200 characters)' });
        meta.name = trimmed;
      }
      if (rootFile) meta.rootFile = rootFile;
      if (engine) meta.engine = engine;
      await store.writeMeta(meta);
      return publicMeta(meta, reqUser(req));
    });

  // Delete = move to trash (restorable ~30 days). ?permanent=1 skips the trash
  // — used by "Delete forever" in the trash UI and by tests that must clean up.
  app.delete<{ Params: { id: string }; Querystring: { permanent?: string } }>('/api/projects/:id', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    if (!isOwner(meta, reqUser(req))) return reply.code(403).send({ error: 'Only the owner can delete this project' });
    if (req.query.permanent === '1') await store.deleteProject(req.params.id);
    else await store.softDeleteProject(req.params.id);
    lastPushedHead.delete(req.params.id); // don't leak the push-dedup entry (or reuse a stale hash)
    // Deleting revokes access just like un-sharing: drop live collab sessions
    // (here and on peer nodes) so nobody keeps editing a trashed project.
    closeProjectConnections(req.params.id);
    publishProjectEvent({ type: 'access-changed', projectId: req.params.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/restore', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    if (!isOwner(meta, reqUser(req))) return reply.code(403).send({ error: 'Only the owner can restore this project' });
    if (!meta.deletedAt) return reply.code(400).send({ error: 'Project is not in the trash' });
    await store.restoreProject(req.params.id);
    return { ok: true };
  });

  // ---------- files ----------
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/files', async (req, reply) => {
    const branch = req.query.branch || 'main';
    try {
      await gitops.ensureWorktree(req.params.id, branch);
      return store.listFiles(req.params.id, branch);
    } catch {
      return reply.code(404).send({ error: 'Project or branch not found' });
    }
  });

  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/file', async (req, reply) => {
    const { branch = 'main', path: rel } = req.query;
    if (!rel) return reply.code(400).send({ error: 'path required' });
    if (isHiddenPath(rel)) return reply.code(403).send({ error: 'forbidden path' });
    try {
      const buf = store.readFile(req.params.id, branch, rel);
      const ext = path.extname(rel).toLowerCase();
      const mime = ext === '.pdf' ? 'application/pdf'
        : ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)
          ? `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`
          : 'text/plain; charset=utf-8';
      // A committed .svg (or sniffed .html) served on our own origin would run its
      // scripts on top-level navigation, acting as the viewer. nosniff pins the
      // type and the sandbox CSP neutralizes any script while <img> embeds still render.
      return reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
        .type(mime).send(buf);
    } catch {
      return reply.code(404).send({ error: 'file not found' });
    }
  });

  app.put<{ Params: { id: string }; Body: { branch?: string; path: string; content?: string; encoding?: 'utf8' | 'base64'; createOnly?: boolean } }>(
    '/api/projects/:id/file', async (req, reply) => {
      const { branch = 'main', path: rel, content = '', encoding = 'utf8', createOnly = false } = req.body || {};
      if (!rel) return reply.code(400).send({ error: 'path required' });
      if (isHiddenPath(rel) || rel.includes('..')) return reply.code(403).send({ error: 'Invalid file path' });
      await gitops.ensureWorktree(req.params.id, branch);
      // createOnly (new-file flow): never clobber an existing file with empty content
      if (createOnly && store.fileExists(req.params.id, branch, rel)) {
        return reply.code(409).send({ error: 'A file with that name already exists' });
      }
      try {
        store.writeFile(req.params.id, branch, rel, encoding === 'base64' ? Buffer.from(content, 'base64') : content);
      } catch {
        return reply.code(400).send({ error: 'Could not write that file path' });
      }
      refreshBranchDocsFromDisk(req.params.id, branch);
      scheduleCommit(req.params.id, branch); // non-collab write → still reach git history
      return { ok: true };
    });

  app.post<{ Params: { id: string }; Body: { branch?: string; from: string; to: string } }>(
    '/api/projects/:id/file/rename', async (req, reply) => {
      const { branch = 'main', from, to } = req.body || {};
      if (!from || !to) return reply.code(400).send({ error: 'from/to required' });
      if (isHiddenPath(from) || isHiddenPath(to)) return reply.code(403).send({ error: 'forbidden path' });
      if (from === to) return { ok: true };
      // never overwrite an existing file — that would destroy both it and the source
      if (store.fileExists(req.params.id, branch, to)) {
        return reply.code(409).send({ error: `A file named "${to}" already exists` });
      }
      // evict the source doc first so its final store can't recreate the old file
      evictDoc(req.params.id, branch, from);
      store.renameFile(req.params.id, branch, from, to);
      bumpContentVersion(req.params.id, branch); // bib/label indexes carry file paths
      scheduleCommit(req.params.id, branch);
      return { ok: true };
    });

  app.delete<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/file', async (req, reply) => {
    const { branch = 'main', path: rel } = req.query;
    if (!rel) return reply.code(400).send({ error: 'path required' });
    if (isHiddenPath(rel)) return reply.code(403).send({ error: 'forbidden path' });
    evictDoc(req.params.id, branch, rel); // prevent resurrection via pending store
    store.deleteFile(req.params.id, branch, rel);
    bumpContentVersion(req.params.id, branch);
    scheduleCommit(req.params.id, branch);
    // If the typeset root was deleted, re-point it at another .tex so the next
    // compile doesn't fail with "root file not found".
    let newRoot: string | undefined;
    try {
      const meta = await store.readMeta(req.params.id);
      if (meta.rootFile === rel) {
        const tex = store.listFiles(req.params.id, branch).find((f) => f.type === 'file' && f.path.endsWith('.tex'));
        if (tex) { meta.rootFile = tex.path; await store.writeMeta(meta); newRoot = tex.path; }
      }
    } catch { /* meta unreadable — leave as-is */ }
    return { ok: true, ...(newRoot ? { newRoot } : {}) };
  });

  /** Serve compile artifacts (PDF, synctex) from the branch's .aldine-out. */
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/output', async (req, reply) => {
    const { branch = 'main', path: rel } = req.query;
    // artifacts live in a .aldine-out dir (at the project root or beside a subdir'd root file)
    if (!rel || rel.includes('..') || !/(^|\/)\.aldine-out\/[^/]+$/.test(rel)) return reply.code(400).send({ error: 'bad output path' });
    try {
      const abs = safeJoin(store.branchDir(req.params.id, branch), rel);
      fs.accessSync(abs); // throws → 404 below if the artifact is missing
      const type = rel.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
      // Stream from disk (constant memory) instead of buffering the whole PDF per
      // fetch. No Content-Length: a concurrent recompile can change the file size
      // between stat and read, and a fixed length would then hang/truncate the
      // client — chunked transfer sends exactly what's read and ends cleanly.
      return reply.type(type).header('cache-control', 'no-store').send(fs.createReadStream(abs));
    } catch {
      return reply.code(404).send({ error: 'artifact not found' });
    }
  });

  // ---------- compile ----------
  app.post<{ Params: { id: string }; Body: { branch?: string } }>('/api/projects/:id/compile', async (req, reply) => {
    const branch = req.body?.branch || 'main';
    const user = reqUser(req);
    const key = clientKey(req, user?.id);
    // plan metering: block once a signed-in user is over their monthly compile budget
    if (user && await usage.overQuota(user.id)) {
      return reply.code(402).send({ ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0, error: 'Monthly typeset limit reached — upgrade your plan for more compile time.', quotaExceeded: true });
    }
    if (!compileGate.tryAcquire(key)) {
      return reply.code(429).send({ ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0, error: 'Too many typesets in flight — let the current ones finish' });
    }
    try {
      const result = await compileProject(req.params.id, branch);
      if (user) await usage.recordCompile(user.id, result.durationMs || 0);
      return result;
    } catch (err: any) {
      return reply.code(400).send({ ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0, error: err.message });
    } finally {
      compileGate.release(key);
    }
  });

  // per-user plan usage (compile-minutes this month) — for a billing/plan UI
  app.get('/api/usage', async (req, reply) => {
    const user = reqUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    return { metering: usage.meteringEnabled(), ...(await usage.usageFor(user.id)) };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> & { branch?: string } }>(
    '/api/projects/:id/synctex', async (req) => {
      const { branch = 'main', ...payload } = req.body || {};
      return synctexLookup(req.params.id, branch, payload);
    });

  // ---------- bib + label indexes (for \cite / \ref autocomplete) ----------
  // Both walk the whole branch (readdir + read + parse every .bib/.tex), which
  // used to run on EVERY autocomplete request. Cache per branch, keyed by the
  // content version that every write path bumps (collab.ts) — a hit costs a
  // Map lookup, a miss exactly one walk.
  const bibIndexCache = new Map<string, { v: number; entries: BibEntry[] }>();
  const labelIndexCache = new Map<string, { v: number; labels: Array<{ label: string; file: string }> }>();

  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/bib', async (req) => {
    const branch = req.query.branch || 'main';
    flushBranchDocs(req.params.id, branch); // may bump the version (pending edits reach disk)
    const key = `${req.params.id}::${branch}`;
    const v = contentVersion(req.params.id, branch);
    const hit = bibIndexCache.get(key);
    if (hit && hit.v === v) return hit.entries;
    const entries: BibEntry[] = [];
    for (const f of store.listFiles(req.params.id, branch)) {
      if (f.type === 'file' && f.path.endsWith('.bib')) {
        try {
          entries.push(...parseBib(store.readFile(req.params.id, branch, f.path).toString('utf8'), f.path));
        } catch { /* skip broken bib */ }
      }
    }
    bibIndexCache.set(key, { v, entries });
    return entries;
  });

  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/labels', async (req) => {
    const branch = req.query.branch || 'main';
    flushBranchDocs(req.params.id, branch);
    const key = `${req.params.id}::${branch}`;
    const v = contentVersion(req.params.id, branch);
    const hit = labelIndexCache.get(key);
    if (hit && hit.v === v) return hit.labels;
    const labels: Array<{ label: string; file: string }> = [];
    const re = /\\label\{([^}]+)\}/g;
    for (const f of store.listFiles(req.params.id, branch)) {
      if (f.type !== 'file' || !f.path.endsWith('.tex')) continue;
      try {
        const text = store.readFile(req.params.id, branch, f.path).toString('utf8');
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) labels.push({ label: m[1], file: f.path });
      } catch { /* skip */ }
    }
    labelIndexCache.set(key, { v, labels });
    return labels;
  });

  // ---------- git ----------
  app.get<{ Params: { id: string } }>('/api/projects/:id/branches', async (req) => gitops.listBranches(req.params.id));

  app.post<{ Params: { id: string }; Body: { name: string; from?: string } }>(
    '/api/projects/:id/branches', async (req, reply) => {
      const { name, from = 'main' } = req.body || {};
      if (!name) return reply.code(400).send({ error: 'name required' });
      if (!BRANCH_RE.test(name) || name.includes('..') || /^(refs|heads|remotes)\//.test(name) || /^-/.test(name)) {
        return reply.code(400).send({ error: 'Invalid branch name' });
      }
      // capture latest edits so the new branch starts from what the user sees
      flushBranchDocs(req.params.id, from);
      await gitops.commitAll(req.params.id, from, 'aldine: checkpoint before branching').catch(() => {});
      try {
        await gitops.createBranch(req.params.id, name, from);
      } catch (err) {
        return reply.code(409).send({ error: `Could not create branch: ${(err as Error).message}` });
      }
      return { ok: true };
    });

  app.delete<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/branches', async (req, reply) => {
    const { name } = req.query;
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (name === 'main') return reply.code(400).send({ error: 'Cannot delete the main branch' });
    try {
      await gitops.deleteBranch(req.params.id, name);
    } catch (err) {
      return reply.code(409).send({ error: `Could not delete branch: ${(err as Error).message}` });
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { branch?: string; message?: string; author?: string } }>(
    '/api/projects/:id/commit', async (req) => {
      const { branch = 'main', message = 'aldine: manual commit', author } = req.body || {};
      flushBranchDocs(req.params.id, branch);
      return gitops.commitAll(req.params.id, branch, message, author);
    });

  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/log', async (req) => {
    return gitops.log(req.params.id, req.query.branch || 'main');
  });

  app.get<{ Params: { id: string; hash: string } }>('/api/projects/:id/commit/:hash/diff', async (req, reply) => {
    try { return await gitops.commitDiff(req.params.id, req.params.hash); }
    catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  app.post<{ Params: { id: string }; Body: { from: string; into: string; author?: string } }>(
    '/api/projects/:id/merge', async (req, reply) => {
      const { from, into, author } = req.body || {};
      if (!from || !into) return reply.code(400).send({ error: 'from/into required' });
      flushBranchDocs(req.params.id, from);
      flushBranchDocs(req.params.id, into);
      const result = await gitops.merge(req.params.id, from, into, author);
      if (result.ok) refreshBranchDocsFromDisk(req.params.id, into);
      return result;
    });

  // ---------- zotero ----------
  app.post<{ Body: { apiKey: string } }>('/api/zotero/validate', async (req, reply) => {
    const { apiKey } = req.body || {};
    if (!apiKey) return reply.code(400).send({ error: 'apiKey required' });
    try {
      const info = await zotero.validateKey(apiKey);
      const groups = await zotero.listGroups(apiKey, info.userID);
      return { ...info, groups };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post<{ Body: { apiKey: string; libraryPrefix: string } }>('/api/zotero/collections', async (req, reply) => {
    const { apiKey, libraryPrefix } = req.body || {};
    if (!apiKey || !libraryPrefix) return reply.code(400).send({ error: 'apiKey and libraryPrefix required' });
    try {
      return await zotero.listCollections(apiKey, libraryPrefix);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string }; Body: { apiKey: string; libraryPrefix: string; collectionKey?: string; bibFile?: string; branch?: string } }>(
    '/api/projects/:id/zotero/link', async (req, reply) => {
      const { apiKey, libraryPrefix, collectionKey, branch = 'main' } = req.body || {};
      const owned = await requireOwner(req, reply, 'link a Zotero library');
      if (!owned) return;
      if (!apiKey || !libraryPrefix) return reply.code(400).send({ error: 'apiKey and libraryPrefix required' });
      try {
        const info = await zotero.validateKey(apiKey);
        const meta = await store.readMeta(req.params.id);
        // default next to the root file — \addbibresource{zotero.bib} resolves
        // relative to its dir, so a project-root default would write a file the
        // document never reads when the root lives in a subdirectory
        const bibFile = req.body?.bibFile || rootSiblingPath(meta.rootFile, 'zotero.bib');
        if (isHiddenPath(bibFile)) return reply.code(403).send({ error: 'forbidden path' });
        meta.zotero = { apiKey, userId: info.userID, username: info.username, libraryPrefix, collectionKey, bibFile };
        await store.writeMeta(meta);
        // sync into the branch the user linked from (the plugin refreshes that branch), not always main
        const sync = await zotero.syncProject(req.params.id, branch, true);
        return { ok: true, ...sync };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

  app.post<{ Params: { id: string }; Body: { branch?: string; force?: boolean } }>(
    '/api/projects/:id/zotero/sync', async (req, reply) => {
      if (!(await requireMember(req, reply, 'sync this Zotero library'))) return;
      try {
        return await zotero.syncProject(req.params.id, req.body?.branch || 'main', !!req.body?.force);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

  app.delete<{ Params: { id: string } }>('/api/projects/:id/zotero', async (req, reply) => {
    const meta = await requireOwner(req, reply, 'unlink the Zotero library');
    if (!meta) return;
    delete meta.zotero;
    await store.writeMeta(meta);
    return { ok: true };
  });

  // Searches run on the OWNER's stored API key and reach their whole personal
  // library, so this is members-only — a link visitor may edit the paper, not
  // read the owner's Zotero account.
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/projects/:id/zotero/search', async (req, reply) => {
    const meta = await requireMember(req, reply, 'search this Zotero library');
    if (!meta) return;
    if (!meta.zotero) return reply.code(400).send({ error: 'no Zotero link' });
    try {
      return await zotero.searchItems(meta.zotero.apiKey, meta.zotero.libraryPrefix, req.query.q || '');
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ---------- reference lookup (DOI / arXiv → BibTeX) ----------
  app.post<{ Params: { id: string }; Body: { query: string; branch?: string; bibFile?: string } }>(
    '/api/projects/:id/references/add', async (req, reply) => {
      const { query, branch = 'main' } = req.body || {};
      if (!query) return reply.code(400).send({ error: 'query required' });
      if (!(await refLimiter.take(clientKey(req, reqUser(req)?.id)))) return reply.code(429).send({ error: 'Rate limit reached — please slow down' });
      try {
        // default next to the root file (see zotero/link) so inserted cites
        // land in a .bib the document actually reads
        const bibFile = req.body?.bibFile || rootSiblingPath((await store.readMeta(req.params.id)).rootFile, 'references.bib');
        if (isHiddenPath(bibFile)) return reply.code(403).send({ error: 'forbidden path' });
        const entry = await fetchBibEntry(query.trim());
        if (!entry) return reply.code(404).send({ error: 'No reference found for that DOI/arXiv id' });
        // append to the .bib (create if missing), skipping duplicate keys
        await gitops.ensureWorktree(req.params.id, branch);
        let existing = '';
        try { existing = store.readFile(req.params.id, branch, bibFile).toString('utf8'); } catch { /* new file */ }
        // key-only dedup via the shared bibKeys scanner — consistent with the
        // /bib index (skips @comment/@string) but without parsing every field
        // of every existing entry just to compare keys.
        const key = [...bibKeys(entry)][0];
        if (key && bibKeys(existing).has(key)) {
          return { ok: true, key, duplicate: true };
        }
        store.writeFile(req.params.id, branch, bibFile, existing.trimEnd() + '\n\n' + entry.trim() + '\n');
        refreshBranchDocsFromDisk(req.params.id, branch);
        scheduleCommit(req.params.id, branch);
        return { ok: true, key, bibFile };
      } catch (err: any) {
        return reply.code(502).send({ error: err.message });
      }
    });

  // ---------- reference search (OpenAlex) ----------
  app.get<{ Querystring: { q?: string } }>('/api/references/search', async (req, reply) => {
    const q = (req.query.q || '').trim();
    if (q.length < 3) return [];
    if (!(await refLimiter.take(clientKey(req, reqUser(req)?.id)))) return reply.code(429).send({ error: 'Search rate limit reached — please slow down' });
    try {
      return await searchWorks(q);
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // ---------- review comments ----------
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/comments', async (req) =>
    comments.listComments(req.params.id, req.query.branch || 'main'));  // returns a Promise; Fastify awaits it

  app.post<{ Params: { id: string }; Body: { branch?: string; file: string; anchor: { from: number; to: number; quote: string }; body: string; suggestion?: string; author?: string } }>(
    '/api/projects/:id/comments', async (req, reply) => {
      const b = req.body || ({} as any);
      if (!b.file || !b.anchor) return reply.code(400).send({ error: 'file and anchor required' });
      const branch = b.branch || 'main';
      // the anchor must point at a real span in a real file
      if (!store.fileExists(req.params.id, branch, b.file)) return reply.code(404).send({ error: 'File not found' });
      const { from, to } = b.anchor;
      if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || to <= from) {
        return reply.code(400).send({ error: 'Invalid comment anchor' });
      }
      if (typeof b.body === 'string' && b.body.length > 5000) return reply.code(400).send({ error: 'Comment is too long (max 5000 characters)' });
      if (typeof b.suggestion === 'string' && b.suggestion.length > 20000) return reply.code(400).send({ error: 'Suggestion is too long' });
      return comments.addComment(req.params.id, {
        branch,
        file: b.file,
        anchor: b.anchor,
        author: reqUser(req)?.name || b.author || 'Anonymous',
        body: b.body || '',
        suggestion: b.suggestion,
      });
    });

  app.post<{ Params: { id: string; cid: string }; Body: { body: string; author?: string } }>(
    '/api/projects/:id/comments/:cid/reply', async (req, reply) => {
      const c = await comments.replyComment(req.params.id, req.params.cid, reqUser(req)?.name || req.body?.author || 'Anonymous', req.body?.body || '');
      return c || reply.code(404).send({ error: 'comment not found' });
    });

  app.post<{ Params: { id: string; cid: string }; Body: { resolved?: boolean } }>(
    '/api/projects/:id/comments/:cid/resolve', async (req, reply) => {
      const c = await comments.resolveComment(req.params.id, req.params.cid, req.body?.resolved !== false);
      return c || reply.code(404).send({ error: 'comment not found' });
    });

  // Anyone in the document may comment and reply, but clearing someone else's
  // review thread is for the team — a link visitor can only delete their own.
  app.delete<{ Params: { id: string; cid: string }; Querystring: Q }>('/api/projects/:id/comments/:cid', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    if (!isMember(meta, reqUser(req))) {
      const all = await comments.listComments(req.params.id, req.query.branch || 'main');
      const mine = all.find((c) => c.id === req.params.cid)?.author === reqUser(req)?.name;
      if (!mine) return reply.code(403).send({ error: 'Only the owner and collaborators can delete this comment' });
    }
    await comments.deleteComment(req.params.id, req.params.cid);
    return { ok: true };
  });

  // ---------- GitHub integration (per-user connection) ----------
  // In no-auth (single-tenant) mode there's no user, so connections hang off a
  // fixed 'local' id. github.enabled reports whether OAuth connect is available.
  const ghUserId = (req: any) => reqUser(req)?.id || 'local';
  // When auth is on, GitHub connections are per signed-in user; without this the
  // anonymous fallback ('local') would let unauthenticated callers share one
  // connection bucket — one user's PAT readable by the next. Mirrors /oauth + /import.
  const requireSignIn = (req: any, reply: any): boolean => {
    if (auth.AUTH_ENABLED && !reqUser(req)) { reply.code(401).send({ error: 'Sign in required' }); return true; }
    return false;
  };

  app.get('/api/github/status', async (req, reply) => {
    if (requireSignIn(req, reply)) return;
    const conn = await github.getConnection(ghUserId(req));
    return { connected: !!conn, login: conn?.login, oauth: github.oauthEnabled() };
  });

  app.post<{ Body: { token?: string } }>('/api/github/connect', async (req, reply) => {
    if (requireSignIn(req, reply)) return;
    const token = (req.body?.token || '').trim();
    if (!token) return reply.code(400).send({ error: 'A GitHub token is required' });
    try {
      const me = await github.whoami(token);
      await github.setConnection(ghUserId(req), { token, login: me.login, name: me.name });
      return { connected: true, login: me.login };
    } catch {
      return reply.code(400).send({ error: 'That token was rejected by GitHub. Check it has repo scope.' });
    }
  });

  app.post('/api/github/disconnect', async (req, reply) => {
    if (requireSignIn(req, reply)) return;
    await github.disconnect(ghUserId(req));
    return { ok: true };
  });

  // OAuth "Connect with GitHub" (repo scope) — links the signed-in user's account.
  app.get('/api/github/oauth', async (req, reply) => {
    if (!github.oauthEnabled()) return reply.code(404).send({ error: 'GitHub OAuth is not configured' });
    if (auth.AUTH_ENABLED && !reqUser(req)) return reply.code(401).send({ error: 'Sign in required' });
    const state = crypto.randomBytes(12).toString('hex');
    reply.header('set-cookie', `aldine_gh_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${auth.SECURE_COOKIES ? '; Secure' : ''}`);
    return reply.redirect(github.connectUrl(state, `${publicBase(req)}/api/github/oauth/callback`));
  });

  app.get<{ Querystring: { code?: string; state?: string } }>('/api/github/oauth/callback', async (req, reply) => {
    if (!github.oauthEnabled()) return reply.code(404).send({ error: 'GitHub OAuth is not configured' });
    const cookies = auth.parseCookies(req.headers.cookie);
    if (!req.query.code || !req.query.state || req.query.state !== cookies.aldine_gh_state) {
      return reply.code(400).send({ error: 'OAuth state mismatch — please try again' });
    }
    try {
      const token = await github.exchangeCode(req.query.code, `${publicBase(req)}/api/github/oauth/callback`);
      const me = await github.whoami(token);
      await github.setConnection(ghUserId(req), { token, login: me.login, name: me.name });
      reply.header('set-cookie', 'aldine_gh_state=; Path=/; Max-Age=0');
      return reply.redirect('/?github=connected');
    } catch (err: any) {
      return reply.code(400).send({ error: `GitHub connect failed: ${err.message}` });
    }
  });

  app.get('/api/github/repos', async (req, reply) => {
    if (requireSignIn(req, reply)) return;
    const conn = await github.getConnection(ghUserId(req));
    if (!conn) return reply.code(400).send({ error: 'GitHub is not connected' });
    try { return await github.listRepos(conn.token); }
    catch (err: any) { return reply.code(502).send({ error: err.message }); }
  });

  // Import a GitHub repo as a new project (the primary create-project flow).
  app.post<{ Body: { fullName?: string } }>('/api/github/import', async (req, reply) => {
    if (auth.AUTH_ENABLED && !reqUser(req)) return reply.code(401).send({ error: 'Sign in required' });
    const conn = await github.getConnection(ghUserId(req));
    if (!conn) return reply.code(400).send({ error: 'Connect GitHub first' });
    const [owner, repo] = (req.body?.fullName || '').trim().split('/');
    if (!owner || !repo) return reply.code(400).send({ error: 'Expected "owner/repo"' });
    let info: github.Repo;
    try { info = await github.getRepo(conn.token, owner, repo); }
    catch (err: any) { return reply.code(400).send({ error: `Repo not found or no access: ${err.message}` }); }
    const id = newId();
    try {
      const { remoteBranch } = await gitops.cloneRepo(id, github.tokenUrl(info.cloneUrl, conn.token));
      const files = store.listFiles(id, 'main').filter((f) => f.type === 'file').map((f) => f.path);
      const rootFile = detectRootFile(id, files);
      const meta: store.ProjectMeta = {
        id, name: info.name, rootFile, engine: 'pdf', createdAt: new Date().toISOString(),
        github: { fullName: info.fullName, owner: info.owner, repo: info.name, remoteBranch, cloneUrl: info.cloneUrl, connectedBy: ghUserId(req) },
      };
      const ownerId = reqUser(req)?.id;
      if (ownerId) { meta.ownerId = ownerId; meta.share = { mode: 'private', collaborators: [] }; }
      await store.writeMeta(meta);
      return publicMeta(meta, reqUser(req));
    } catch (err: any) {
      fs.rmSync(store.repoDir(id), { recursive: true, force: true });
      return reply.code(400).send({ error: `Import failed: ${err.message}` });
    }
  });

  // Pick the typeset root: the .tex that actually has \documentclass (a repo's
  // real main file may live in a subdir like paper/main.tex), preferring main.tex
  // and shallower paths. Falls back gracefully when nothing declares a class.
  function detectRootFile(id: string, files: string[]): string {
    const tex = files.filter((f) => f.endsWith('.tex'));
    const rank = (arr: string[]) => arr.slice().sort((a, b) => {
      const am = /(^|\/)main\.tex$/.test(a), bm = /(^|\/)main\.tex$/.test(b);
      if (am !== bm) return am ? -1 : 1;
      const ad = a.split('/').length, bd = b.split('/').length;
      return ad !== bd ? ad - bd : a.localeCompare(b);
    })[0];
    const withClass = tex.filter((f) => {
      try { return /\\documentclass/.test(store.readFile(id, 'main', f).subarray(0, 4096).toString('utf8')); }
      catch { return false; }
    });
    return rank(withClass) || rank(tex) || 'main.tex';
  }

  // Sync a linked project with its GitHub remote (uses the acting user's token).
  // Syncing pushes the project into the OWNER's repo and can pull remote state
  // over everyone's work, so every remote operation is members-only: link mode
  // grants editing, not control of where the project is mirrored.
  const linkedRemote = async (req: any, reply: any, action = 'sync this project') => {
    const meta = await requireMember(req, reply, action);
    if (!meta) return null;
    if (!meta.github) { reply.code(400).send({ error: 'This project is not linked to GitHub' }); return null; }
    const conn = await github.getConnection(ghUserId(req));
    if (!conn) { reply.code(400).send({ error: 'Connect GitHub to sync' }); return null; }
    return { meta, token: conn.token, owner: meta.github.owner, repo: meta.github.repo, url: github.tokenUrl(meta.github.cloneUrl, conn.token), remoteBranch: meta.github.remoteBranch };
  };

  // Publish a locally-created project to a fresh GitHub repo. This is the only
  // way an unlinked project gains an off-server copy, so the editor nudges
  // toward it. Creates the repo under the connected account, commits the
  // current state, pushes main, and stores the link (same shape as an import).
  app.post<{ Params: { id: string }; Body: { name?: string; private?: boolean } }>('/api/projects/:id/github/link', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    if (auth.AUTH_ENABLED && !isOwner(meta, reqUser(req))) return reply.code(403).send({ error: 'Only the owner can publish this project' });
    if (meta.github) return reply.code(400).send({ error: 'This project is already linked to GitHub' });
    const conn = await github.getConnection(ghUserId(req));
    if (!conn) return reply.code(400).send({ error: 'Connect GitHub first' });
    const name = (req.body?.name || meta.name).trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
    if (!name) return reply.code(400).send({ error: 'Repository name required' });
    let info: github.Repo;
    try { info = await github.createRepo(conn.token, name, req.body?.private !== false); }
    catch (err: any) { return reply.code(400).send({ error: `Could not create repo: ${err.message}` }); }
    flushBranchDocs(req.params.id, 'main');
    await gitops.commitAll(req.params.id, 'main', 'aldine: publish to GitHub', reqUser(req)?.name).catch(() => {});
    meta.github = { fullName: info.fullName, owner: info.owner, repo: info.name, remoteBranch: 'main', cloneUrl: info.cloneUrl, connectedBy: ghUserId(req) };
    await store.writeMeta(meta);
    try { await gitops.pushToRemote(req.params.id, 'main', github.tokenUrl(info.cloneUrl, conn.token)); }
    catch (err: any) {
      // repo exists and the link is stored — the user can retry the push from the sync UI
      return reply.code(502).send({ error: `Repo created but the first push failed: ${err.message}. Use Push to retry.`, github: meta.github });
    }
    return { ok: true, github: meta.github };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/github/status', async (req, reply) => {
    const link = await linkedRemote(req, reply); if (!link) return;
    try { return { linked: true, ...link.meta.github, ...(await gitops.remoteStatus(req.params.id, link.remoteBranch, link.url)) }; }
    catch (err: any) { return reply.code(502).send({ error: err.message }); }
  });

  app.post<{ Params: { id: string }; Body: { message?: string; auto?: boolean } }>('/api/projects/:id/github/push', async (req, reply) => {
    const link = await linkedRemote(req, reply); if (!link) return;
    flushBranchDocs(req.params.id, 'main'); // capture unsaved editor content before committing
    const message = (req.body?.message || '').trim() || 'Update from Aldine';
    const commit = await gitops.commitAll(req.params.id, 'main', message, reqUser(req)?.name).catch(() => ({ committed: false, hash: undefined as string | undefined }));
    // HEAD is the commit hash we just made (when we committed), else look it up.
    const head = commit.committed ? commit.hash ?? null : await gitops.headCommit(req.params.id).catch(() => null);
    // Auto-sync (client sends auto:true, fires ~every 20s) skips the full git-push
    // round-trip when nothing was committed and HEAD is unchanged since our last
    // successful push. A MANUAL push always pushes — so a user pushing to restore
    // content after a remote-side rollback isn't wrongly skipped. In-memory,
    // single-node (see docs/SCALING); defaults to pushing whenever unsure.
    if (req.body?.auto && !commit.committed && head && lastPushedHead.get(req.params.id) === head) {
      return { ok: true, skipped: true };
    }
    try {
      await gitops.pushToRemote(req.params.id, link.remoteBranch, link.url);
      if (head) lastPushedHead.set(req.params.id, head);
      return { ok: true };
    } catch (err: any) { return reply.code(400).send({ error: `Push failed: ${err.message}` }); }
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/github/pull', async (req, reply) => {
    const link = await linkedRemote(req, reply); if (!link) return;
    flushBranchDocs(req.params.id, 'main');
    await gitops.commitAll(req.params.id, 'main', 'Local changes before pull', reqUser(req)?.name).catch(() => {});
    try {
      const result = await gitops.pullFromRemote(req.params.id, link.remoteBranch, link.url);
      if (!result.ok) return reply.code(409).send({ error: 'Merge conflict', conflicts: result.conflicts });
      refreshBranchDocsFromDisk(req.params.id, 'main'); // push the merged content into open editors
      return { ok: true };
    } catch (err: any) { return reply.code(400).send({ error: `Pull failed: ${err.message}` }); }
  });

  // Conflict escape hatch: discard local changes and take the GitHub version.
  // Destroys everyone's unpushed work, so it is the owner's call alone.
  app.post<{ Params: { id: string } }>('/api/projects/:id/github/reset-to-remote', async (req, reply) => {
    if (!(await requireOwner(req, reply, 'discard local changes'))) return;
    const link = await linkedRemote(req, reply); if (!link) return;
    try {
      await gitops.resetToRemote(req.params.id, link.remoteBranch, link.url);
      refreshBranchDocsFromDisk(req.params.id, 'main');
      return { ok: true };
    } catch (err: any) { return reply.code(400).send({ error: `Reset failed: ${err.message}` }); }
  });

  // ---------- GitHub branches + PRs ----------
  app.get<{ Params: { id: string } }>('/api/projects/:id/github/branches', async (req, reply) => {
    const link = await linkedRemote(req, reply); if (!link) return;
    try {
      const [branches, repo] = await Promise.all([
        github.listBranches(link.token, link.owner, link.repo),
        github.getRepo(link.token, link.owner, link.repo),
      ]);
      return { branches, current: link.remoteBranch, default: repo.defaultBranch };
    } catch (err: any) { return reply.code(502).send({ error: err.message }); }
  });

  // Switch which GitHub branch this project tracks. Saves current work (commit +
  // push) first so nothing is lost, then checks out the target branch.
  app.post<{ Params: { id: string }; Body: { branch?: string } }>('/api/projects/:id/github/switch-branch', async (req, reply) => {
    // Persists meta.github.remoteBranch — repoints the project for everyone.
    if (!(await requireOwner(req, reply, 'change the tracked GitHub branch'))) return;
    const link = await linkedRemote(req, reply); if (!link) return;
    const target = (req.body?.branch || '').trim();
    if (!target) return reply.code(400).send({ error: 'branch required' });
    if (target === link.remoteBranch) return { ok: true };
    flushBranchDocs(req.params.id, 'main');
    try {
      await gitops.commitAll(req.params.id, 'main', 'Save before switching branch', reqUser(req)?.name).catch(() => {});
      await gitops.pushToRemote(req.params.id, link.remoteBranch, link.url).catch(() => {}); // best-effort save
      await gitops.resetToRemote(req.params.id, target, link.url);
      const meta = link.meta; meta.github!.remoteBranch = target; await store.writeMeta(meta);
      refreshBranchDocsFromDisk(req.params.id, 'main');
      return { ok: true, branch: target };
    } catch (err: any) { return reply.code(400).send({ error: `Switch failed: ${err.message}` }); }
  });

  // Create a new GitHub branch from the current content and switch to it.
  app.post<{ Params: { id: string }; Body: { name?: string } }>('/api/projects/:id/github/create-branch', async (req, reply) => {
    const link = await linkedRemote(req, reply); if (!link) return;
    const name = (req.body?.name || '').trim();
    // Use the same BRANCH_RE gitops enforces on push/pull, so a name the UI
    // accepts can't later be rejected by git after a stray commit is written.
    if (!BRANCH_RE.test(name) || name.includes('..')) return reply.code(400).send({ error: 'Invalid branch name' });
    flushBranchDocs(req.params.id, 'main');
    try {
      await gitops.commitAll(req.params.id, 'main', `Start branch ${name}`, reqUser(req)?.name).catch(() => {});
      await gitops.pushToRemote(req.params.id, name, link.url); // push creates the remote branch
      const meta = link.meta; meta.github!.remoteBranch = name; await store.writeMeta(meta);
      return { ok: true, branch: name };
    } catch (err: any) { return reply.code(400).send({ error: `Create branch failed: ${err.message}` }); }
  });

  // Open a pull request from the current branch into the repo's default branch.
  app.post<{ Params: { id: string }; Body: { title?: string } }>('/api/projects/:id/github/pr', async (req, reply) => {
    const link = await linkedRemote(req, reply); if (!link) return;
    try {
      flushBranchDocs(req.params.id, 'main'); // capture unsaved editor content before committing (parity with push/pull/switch/create)
      await gitops.commitAll(req.params.id, 'main', 'Update before pull request', reqUser(req)?.name).catch(() => {});
      await gitops.pushToRemote(req.params.id, link.remoteBranch, link.url);
      const repo = await github.getRepo(link.token, link.owner, link.repo);
      if (link.remoteBranch === repo.defaultBranch) return reply.code(400).send({ error: `You're on the default branch (${repo.defaultBranch}). Create a branch first.` });
      const pr = await github.createPullRequest(link.token, link.owner, link.repo, {
        title: (req.body?.title || '').trim() || `Update ${link.remoteBranch}`,
        head: link.remoteBranch,
        base: repo.defaultBranch,
      });
      return pr;
    } catch (err: any) { return reply.code(400).send({ error: `Could not open PR: ${err.message}` }); }
  });

  // ---------- AI error fix ----------
  app.get('/api/ai/status', async () => ({ configured: aiConfigured(), model: aiModel() }));

  app.post<{ Params: { id: string }; Body: { branch?: string; errors?: Array<{ type: string; line: number | null; message: string; file?: string }>; log?: string } }>(
    '/api/projects/:id/ai/fix', async (req, reply) => {
      if (!aiConfigured()) return reply.code(400).send({ error: 'AI is not configured. Set an ANTHROPIC_API_KEY or OPENROUTER_API_KEY on the server to enable it.' });
      if (!(await aiLimiter.take(clientKey(req, reqUser(req)?.id)))) return reply.code(429).send({ error: 'AI rate limit reached — please slow down' });
      const { branch = 'main', errors = [], log = '' } = req.body || {};
      const meta = await store.readMeta(req.params.id);
      flushBranchDocs(req.params.id, branch);
      const files: Array<{ path: string; content: string }> = [];
      for (const f of store.listFiles(req.params.id, branch)) {
        if (f.type === 'file' && f.path.endsWith('.tex')) {
          try { files.push({ path: f.path, content: store.readFile(req.params.id, branch, f.path).toString('utf8') }); } catch { /* skip */ }
        }
      }
      try {
        const result = await diagnose({ rootFile: meta.rootFile, files, errors, log });
        return { ok: true, ...result };
      } catch (err: any) {
        return reply.code(502).send({ error: `AI request failed: ${err.message}` });
      }
    });

  // ---------- plugins ----------
  app.get('/api/plugins', async () => listPlugins());

  app.get<{ Params: { pluginId: string; '*': string } }>('/plugins/:pluginId/*', async (req, reply) => {
    const abs = pluginAssetPath(req.params.pluginId, req.params['*']);
    if (!abs) return reply.code(404).send({ error: 'not found' });
    const ext = path.extname(abs);
    const type = ext === '.js' || ext === '.mjs' ? 'text/javascript'
      : ext === '.css' ? 'text/css'
      : ext === '.json' ? 'application/json'
      : 'application/octet-stream';
    return reply.type(type).send(fs.readFileSync(abs));
  });
}
