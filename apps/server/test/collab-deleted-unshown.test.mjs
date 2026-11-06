/**
 * A git operation that deletes files (merge, revert, pull, reset) leaves
 * their docs loaded when a client still holds them. An editor that shows the
 * file keeps its text: the next store writes it back. A doc nobody shows is
 * one a tab keeps for a switch back (web editor/docCache); it goes with the
 * file, or the next flush (a file listing, a typeset) would restore every
 * file the tab visited lately. Real hooks on a throwaway datastore;
 * env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-collab-unshown-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');

const meta = await store.createProject('Unshown', {
  'main.tex': '\\documentclass{article}\\begin{document}\\input{kept}\\end{document}\n',
  'kept.tex': 'Kept for a switch back.\n',
  'shown.tex': 'Open in an editor.\n',
  'agent.tex': 'Only the agent is here.\n',
}, null);
const id = meta.id;
const dir = store.branchDir(id, 'main');

/** A pane's awareness: who it is, from a client of its own. */
function showIn(doc, name) {
  const client = new Awareness(new Y.Doc());
  client.setLocalState({ user: { name, color: '#e8554d' } });
  applyAwarenessUpdate(doc.awareness, encodeAwarenessUpdate(client, [client.clientID]), 'test');
}

const conns = {};
for (const f of ['kept.tex', 'shown.tex', 'agent.tex']) conns[f] = await collab.hocuspocus.openDirectConnection(collab.docName(id, 'main', f), {});
const loaded = (f) => collab.hocuspocus.documents.get(collab.docName(id, 'main', f));
showIn(loaded('shown.tex'), 'Ada');
collab.markAgentPresence(id, 'main', 'agent.tex');

for (const f of ['kept.tex', 'shown.tex', 'agent.tex']) fs.rmSync(path.join(dir, f));
collab.refreshBranchDocsFromDisk(id, 'main');
collab.flushBranchDocs(id, 'main');

check(!loaded('kept.tex'), 'a doc no editor shows is dropped with its file');
check(!fs.existsSync(path.join(dir, 'kept.tex')), 'and the flush does not write that file back');
check(!loaded('agent.tex') && !fs.existsSync(path.join(dir, 'agent.tex')), "the agent's presence alone keeps nothing");
check(!!loaded('shown.tex'), 'a doc an editor shows stays loaded');
eq(fs.readFileSync(path.join(dir, 'shown.tex'), 'utf8'), 'Open in an editor.\n', 'and its text is written back');
check(fs.existsSync(path.join(dir, 'main.tex')), 'files no git operation deleted are untouched');

for (const c of Object.values(conns)) await c.disconnect().catch(() => {});
console.log('collab-deleted-unshown: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
