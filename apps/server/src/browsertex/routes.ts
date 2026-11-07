import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import * as auth from '../auth.js';
import * as store from '../store.js';
import { flushBranchDocs } from '../collab.js';
import { ensureWorktree } from '../gitops.js';
import { detectRoot } from '../root.js';
import { BRANCH_RE, invalidRootFile } from '../util.js';
import { compileProject, pagesFromLog, reserveRunId } from '../compile.js';
import { assetType } from './assets.js';
import { browserTexAssets, packageSource } from './build.js';
import { BUNDLE_TYPE, decodeBundle } from './bundle.js';
import { claimJob, completeJob, listJobFiles, type Snapshot } from './jobs.js';
import { parseRun, type Upload } from './ingest.js';

type ReqUser = (req: unknown) => auth.PublicUser | null;

const UPLOAD_LIMIT = Number(process.env.ALDINE_BROWSER_UPLOAD_MAX_BYTES || 256 * 1024 * 1024);

export async function registerBrowserTex(app: FastifyInstance, reqUser: ReqUser): Promise<void> {
  const a = browserTexAssets();
  const servable = new Set(a.files);
  // The TeX Live build is public software, but hundreds of megabytes per
  // request: with accounts on, only signed-in people may pull it.
  const signedIn = (req: unknown) => !auth.AUTH_ENABLED || !!reqUser(req);

  // What the editor needs to typeset in this browser; a server in server mode
  // has no such route, which tells the editor so.
  app.get('/api/typeset', async (req, reply) => {
    if (!signedIn(req)) return reply.code(401).send({ error: 'Sign in required' });
    const m = a.manifest;
    const bundle = m.profiles[a.profile];
    return {
      mode: 'browser',
      assets: {
        base: `${config.basePath}/browser-tex/${m.version}/`,
        version: m.version,
        texlive: m.texlive,
        profile: a.profile,
        bundle: bundle[0],
        biber: m.biber.every((f) => servable.has(f)),
        bytes: a.files.reduce((n, f) => n + m.files[f].size, 0),
      },
      ...(packageSource() ? { packages: { endpoint: `${config.basePath}/api/texlive/` } } : {}),
      ...a.state(),
    };
  });

  app.get<{ Params: { version: string; name: string } }>('/browser-tex/:version/:name', async (req, reply) => {
    if (!signedIn(req)) return reply.code(401).send({ error: 'Sign in required' });
    const { version, name } = req.params;
    if (version !== a.manifest.version || !servable.has(name)) return reply.code(404).send({ error: 'not found' });
    const file = a.pathOf(name);
    if (!file) return reply.code(503).header('retry-after', '30').send({ error: 'TeX for the browser is still being prepared on the server' });
    const st = await fs.promises.stat(file);
    // Versioned path: the bytes behind a URL never change.
    return reply
      .type(assetType(name))
      .header('content-length', st.size)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(fs.createReadStream(file));
  });

  // A file the served profile lacks, asked for by kpathsea while TeX runs in
  // the worker (synchronously, so this answers or 404s within its timeout).
  // A package is fetched from the mirror once, then every request is a read.
  app.get<{ Params: { format: string; name: string } }>('/api/texlive/:format/:name', async (req, reply) => {
    if (!signedIn(req)) return reply.code(401).send({ error: 'Sign in required' });
    const source = packageSource();
    if (!source) return reply.code(404).send({ error: 'not found' });
    let file: string | null;
    try {
      file = await source.resolve(Number(req.params.format), req.params.name);
    } catch (err: any) {
      req.log.warn(`[aldine] TeX Live file ${req.params.name} could not be fetched: ${err.message}`);
      return reply.code(503).header('cache-control', 'no-store').send({ error: err.message });
    }
    if (!file) return reply.code(404).header('cache-control', 'public, max-age=3600').send({ error: 'not in TeX Live' });
    const st = await fs.promises.stat(file);
    return reply
      .type('application/octet-stream')
      .header('content-length', st.size)
      .header('cache-control', 'public, max-age=604800')
      .header('x-content-type-options', 'nosniff')
      .send(fs.createReadStream(file));
  });

  // ---------- the browser's side of a typeset (jobs.ts) ----------
  // Under /api/projects/:id, so the shared guard has checked access and token
  // scope. The snapshot is a read, so a viewer may typeset in their own
  // browser; publishing is a write, so only an editor's run reaches the
  // branch (these routes are not viewer writes).

  app.get<{ Params: { id: string }; Querystring: { branch?: string } }>('/api/projects/:id/compile/snapshot', async (req, reply) => {
    const projectId = req.params.id;
    const branch = req.query.branch || 'main';
    if (!BRANCH_RE.test(branch)) return reply.code(400).send({ error: 'invalid branch name' });
    const meta = await store.readMeta(projectId);
    try { await ensureWorktree(projectId, branch); } catch { return reply.code(404).send({ error: 'Project or branch not found' }); }
    flushBranchDocs(projectId, branch);
    // As compile.ts does: files also arrive through git without passing the file routes.
    if (!meta.rootFile) {
      const root = detectRoot(projectId, branch);
      if (!root) return reply.code(400).send({ error: 'No .tex file to typeset. Create one to start writing.' });
      meta.rootFile = root;
      await store.writeMeta(meta);
    }
    let files;
    try { files = listJobFiles(store.branchDir(projectId, branch)); } catch (err: any) { return reply.code(400).send({ error: err.message }); }
    const snapshot: Snapshot = { branch, rootFile: meta.rootFile, engine: meta.engine || 'pdf', haltOnError: !!meta.stopOnFirstError, files, runId: reserveRunId() };
    return reply.header('cache-control', 'no-store').send(snapshot);
  });

  // The compiler's reading of a log, for a run a browser shows without
  // publishing it: the same rows either way.
  app.post<{ Body: { log?: unknown; blg?: unknown; rootFile?: unknown; exitCode?: unknown; pdf?: unknown; draft?: unknown } }>('/api/typeset/parse', async (req, reply) => {
    if (!signedIn(req)) return reply.code(401).send({ error: 'Sign in required' });
    const b = req.body ?? {};
    const log = typeof b.log === 'string' ? b.log : '';
    const parsed = parseRun({
      log,
      blg: typeof b.blg === 'string' ? b.blg : undefined,
      rootFile: typeof b.rootFile === 'string' && b.rootFile ? b.rootFile : 'main.tex',
      exitCode: Number.isInteger(b.exitCode) ? (b.exitCode as number) : 1,
      pdf: b.pdf === true,
      draft: b.draft === true,
    });
    const pages = parsed.ok ? pagesFromLog(log) : null;
    return { ...parsed, ...(pages !== null ? { pages } : {}) };
  });

  // A claimed run nobody's browser asked for (an agent's): first claim wins.
  app.post<{ Params: { id: string }; Body: { branch?: string } }>('/api/projects/:id/compile/jobs/claim', async (req, reply) => {
    const job = claimJob(req.params.id, req.body?.branch || 'main');
    if (!job) return reply.code(404).send({ error: 'No typeset is waiting' });
    return { job };
  });

  app.addContentTypeParser(BUNDLE_TYPE, { parseAs: 'buffer', bodyLimit: UPLOAD_LIMIT }, (_req, body, done) => done(null, body));

  // A run a browser typeset, for everyone else: written to .aldine-out and
  // finished by compile.ts, so it answers what POST /compile answers in
  // server mode. With `jobId` it is the claimed run that job waits for.
  app.post<{ Params: { id: string } }>('/api/projects/:id/compile/publish', { bodyLimit: UPLOAD_LIMIT }, async (req, reply) => {
    const projectId = req.params.id;
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: `Send the output as ${BUNDLE_TYPE}` });
    let parts: Map<string, Buffer>;
    let meta: { branch?: unknown; rootFile?: unknown; draft?: unknown; runId?: unknown; jobId?: unknown; exitCode?: number; durationMs?: number; thumb?: { w?: number; h?: number } };
    try {
      parts = decodeBundle(req.body);
      meta = JSON.parse(parts.get('meta')?.toString('utf8') || '{}');
    } catch (err: any) {
      return reply.code(400).send({ error: `Unreadable typeset output: ${err.message}` });
    }
    const text = (name: string) => parts.get(name)?.toString('utf8');
    const upload: Upload = {
      meta: { exitCode: meta.exitCode, durationMs: meta.durationMs, thumb: meta.thumb },
      pdf: parts.get('pdf'),
      synctex: parts.get('synctex'),
      log: text('log'),
      blg: text('blg'),
      transcript: text('transcript'),
      thumb: parts.get('thumb'),
    };
    if (typeof meta.jobId === 'string') {
      const result = await completeJob(projectId, meta.jobId, upload);
      if (!result) return reply.code(410).send({ error: 'This typeset was stopped or has timed out' });
      return result;
    }
    const branch = typeof meta.branch === 'string' && BRANCH_RE.test(meta.branch) ? meta.branch : 'main';
    // The snapshot's root, which the project's may have left since: output
    // lands beside the document it was typeset from, and only beside one.
    const rootFile = typeof meta.rootFile === 'string' && meta.rootFile ? meta.rootFile : (await store.readMeta(projectId)).rootFile;
    const rootAbs = path.join(store.branchDir(projectId, branch), rootFile || '');
    if (!rootFile || invalidRootFile(rootFile) || !/\.tex$/i.test(rootFile) || !fs.existsSync(rootAbs)) return reply.code(400).send({ error: 'invalid rootFile' });
    try {
      return await compileProject(projectId, branch, {
        draft: meta.draft === true,
        browserOutput: { upload, rootFile, draft: meta.draft === true, runId: typeof meta.runId === 'number' ? meta.runId : undefined },
      });
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
}
