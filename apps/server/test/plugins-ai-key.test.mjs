/**
 * The Fix tab answers with the server's AI key. On a server without one the
 * plugin list marks it disabled, so the editor loads no Fix tab that could
 * only tell co-authors to set a key they cannot set. The other plugins load
 * either way.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-plugins-ai-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[k];

const { default: Fastify } = await import('fastify');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const app = Fastify({ logger: false });
await registerRoutes(app);

const enabled = async () => Object.fromEntries((await app.inject({ method: 'GET', url: '/api/plugins' })).json().map((p) => [p.id, p.enabled]));
try {
  let list = await enabled();
  eq(list.aifix, false, 'without a key the Fix tab is not loaded');
  eq(list.references, true, 'the other plugins are');

  process.env.ANTHROPIC_API_KEY = 'test-ai-key';
  list = await enabled();
  eq(list.aifix, true, 'with a key it is');
  console.log('plugins-ai-key: OK');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
