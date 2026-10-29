/**
 * A collab snapshot damaged by a crash (#199): empty, cut short or
 * zero-filled. It is ignored with a log line, the document loads from its
 * file exactly once, and a valid snapshot is written in its place, so a
 * client that syncs after the reload and edits merges its edit, nothing
 * duplicated. Snapshots are replaced atomically: no temp file is left.
 *
 * Real hooks on a throwaway JSON datastore, auth off; env is set before any
 * src import. The autosave debounce is pushed past the test's lifetime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-torn-snapshot-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');

const p = await store.createProject('Torn', { 'main.tex': '\\section{Intro}\nFirst line.\n' });
const id = p.id;
const yjsDir = path.join(process.env.META_DIR, 'yjs');
const snapFile = path.join(yjsDir, crypto.createHash('sha1').update(collab.docName(id, 'main', 'main.tex')).digest('hex') + '.ybin');
const disk = () => fs.readFileSync(path.join(store.branchDir(id, 'main'), 'main.tex'), 'utf8');
const open = () => collab.hocuspocus.openDirectConnection(collab.docName(id, 'main', 'main.tex'), {});
const textOf = (bytes) => { const d = new Y.Doc(); Y.applyUpdate(d, bytes); return d.getText('content').toString(); };

/** Disconnect and wait for Hocuspocus's unload, so the next open loads from disk. */
async function close(conn) {
  await conn.disconnect();
  for (let i = 0; i < 100 && collab.openDocContent(id, 'main', 'main.tex') !== null; i++) await new Promise((r) => setTimeout(r, 20));
  check(collab.openDocContent(id, 'main', 'main.tex') === null, 'setup: the document unloaded');
}

async function errorsOf(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  try { return { value: await fn(), lines }; } finally { console.error = orig; }
}

// a history worth tearing: several edits, so the snapshot is more than a few bytes
let conn = await open();
for (let i = 0; i < 20; i++) await conn.transact((doc) => doc.getText('content').insert(doc.getText('content').length, `Line ${i} of the paper.\n`));
collab.flushBranchDocs(id, 'main');
await close(conn);
let content = disk();
check(content.includes('Line 19 of the paper.'), 'setup: the edits are on disk');
eq(textOf(fs.readFileSync(snapFile)), content, 'setup: the snapshot holds the same text');
eq(fs.readdirSync(yjsDir).filter((f) => f.endsWith('.tmp')), [], 'snapshot writes leave no temp file');

const damages = [
  ['empty', () => Buffer.alloc(0), 'empty file'],
  ['cut short', (b) => b.subarray(0, Math.floor(b.length * 0.6)), 'does not decode'],
  ['zero-filled', (b) => Buffer.alloc(b.length), 'zero-filled'],
];
for (const [label, damage, reason] of damages) {
  fs.writeFileSync(snapFile, damage(fs.readFileSync(snapFile)));
  const { value: c, lines } = await errorsOf(open);
  const text = c.document.getText('content');
  eq(text.toString(), content, `an ${label} snapshot: the document loads from its file, once`);
  check(lines.some((l) => l.includes('ignoring the snapshot') && l.includes(reason)), `and the damaged snapshot is logged (got ${JSON.stringify(lines)})`);
  eq(textOf(fs.readFileSync(snapFile)), content, 'a valid snapshot replaces the damaged one');

  // a tab that synced after the reload, with an edit the server has not seen
  const tab = new Y.Doc();
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(c.document));
  const at = content.indexOf('First line.') + 'First line.'.length;
  tab.getText('content').insert(at, ` (${label})`);
  await close(c);

  conn = await open();
  const reloaded = conn.document.getText('content');
  eq(reloaded.toString(), content, 'reloading from the new snapshot gives the same text');
  const toServer = Y.encodeStateAsUpdate(tab, Y.encodeStateVector(conn.document));
  const toTab = Y.encodeStateAsUpdate(conn.document, Y.encodeStateVector(tab));
  await conn.transact((doc) => Y.applyUpdate(doc, toServer));
  Y.applyUpdate(tab, toTab);
  const merged = content.slice(0, at) + ` (${label})` + content.slice(at);
  eq(reloaded.toString(), merged, 'the reconnecting tab\'s edit merges where it was typed, nothing duplicated');
  eq(tab.getText('content').toString(), merged, 'and the tab ends up with the same text');
  collab.flushBranchDocs(id, 'main');
  eq(disk(), merged, 'the file gets the edit');
  await close(conn);
  content = merged;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ collab torn snapshot: all passed');
process.exit(0);
