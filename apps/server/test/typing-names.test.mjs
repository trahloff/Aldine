/**
 * Names for typing (North Star WP2): the commit that takes a person's bytes
 * names them. The first to write signs an autosave, everyone else is a
 * Co-authored-by line; History reads the names back without the addresses.
 * Real gitops on a throwaway datastore; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-typing-names-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');

const meta = await store.createProject('Names', { 'a.tex': 'A.\n', 'b.tex': 'B.\n' }, null);
const id = meta.id;
const head = (fmt) => execFileSync('git', ['log', '-1', `--format=${fmt}`, 'main'], { cwd: store.branchDir(id, 'main'), encoding: 'utf8' }).trim();
const ada = { id: 'u-ada', name: 'Ada Lovelace', email: 'ada@example.org' };
const ben = { id: 'u-ben', name: 'Ben' };
let n = 0;
const edit = (f) => store.writeFile(id, 'main', f, `${f} edit ${++n}\n`);

// one person
edit('a.tex');
gitops.noteWriters(id, 'main', ['a.tex'], ada);
let r = await gitops.autosave(id, 'main');
check(r.committed, 'the autosave committed');
eq(head('%an <%ae>|%s'), 'Ada Lovelace <ada@example.org>|aldine: autosave', 'the typist signs the autosave, with her commit email');
eq(head('%(trailers:key=Co-authored-by,valueonly)'), '', 'and nobody else is named');
eq(gitops.pendingWriters(id, 'main'), [], 'the names went with the commit');

// two people in one save: first to write signs, the other is a co-author
edit('b.tex'); gitops.noteWriters(id, 'main', ['b.tex'], ben);
edit('a.tex'); gitops.noteWriters(id, 'main', ['a.tex'], ada);
gitops.noteWriters(id, 'main', ['a.tex'], ben);
await gitops.autosave(id, 'main');
eq(head('%an <%ae>'), 'Ben <ben@aldine.local>', 'the first to write signs; no commit email means the derived address');
eq(head('%(trailers:key=Co-authored-by,valueonly)'), 'Ada Lovelace <ada@example.org>', 'the other typist is a Co-authored-by line, once');
const log = await gitops.log(id, 'main', 5);
eq(log[0].author, 'Ben', 'History has the author');
eq(log[0].coAuthors, ['Ada Lovelace'], 'and the co-author by name');
check(!JSON.stringify(log).includes('ada@example.org'), 'no address in the log answer');
const detailed = await gitops.log(id, 'main', 5, { details: true });
eq(detailed[0].coAuthors, ['Ada Lovelace'], 'the detailed log has it too');
eq(detailed[0].files, ['a.tex', 'b.tex'], 'and the files still parse');
eq(detailed[0].message, 'aldine: autosave', 'the subject stays the autosave subject');
eq(log[1].coAuthors, undefined, 'a save by one person has no co-authors');

// the names History reads as nobody or the agent, and brackets, are refused
edit('a.tex');
gitops.noteWriters(id, 'main', ['a.tex'], { id: 'u-c', name: 'Assistant' });
gitops.noteWriters(id, 'main', ['a.tex'], { id: 'u-d', name: '  Aldine ' });
await gitops.autosave(id, 'main');
eq(head('%an'), 'Aldine', 'a person named Claude or Aldine leaves the save anonymous');
edit('a.tex');
gitops.noteWriters(id, 'main', ['a.tex'], { id: 'u-e', name: 'Eve <eve@x>\nCo-authored-by: Mallory <m@x>' });
await gitops.autosave(id, 'main');
eq(head('%an'), 'Eve eve@x Co-authored-by: Mallory m@x', 'brackets and line breaks are removed from the name');
eq(head('%(trailers:key=Co-authored-by,valueonly)'), '', 'a name cannot plant a trailer');

// a checkpoint by one person names the others who typed
edit('a.tex'); gitops.noteWriters(id, 'main', ['a.tex'], ada);
await gitops.checkpoint(id, 'main', 'Draft one', 'Ben');
eq(head('%an|%s'), 'Ben|Draft one', 'the checkpoint is the person who saved it');
eq(head('%(trailers:key=Co-authored-by,valueonly)'), 'Ada Lovelace <ada@example.org>', 'the typist is a co-author');

// a tree with nothing new drops the names: they belong to bytes already saved
gitops.noteWriters(id, 'main', ['a.tex'], ada);
r = await gitops.autosave(id, 'main');
check(!r.committed, 'nothing to commit');
eq(gitops.pendingWriters(id, 'main'), [], 'and nobody waits to be named on the next save');

// the save before an agent write names only the typists of those paths
edit('a.tex'); gitops.noteWriters(id, 'main', ['a.tex'], ada);
edit('b.tex'); gitops.noteWriters(id, 'main', ['b.tex'], ben);
await gitops.checkpointPaths(id, 'main', ['a.tex']);
eq(head('%an|%s'), 'Ada Lovelace|aldine: autosave', 'the typing in a.tex is Ada’s');
eq(gitops.pendingWriters(id, 'main'), ['Ben'], 'Ben waits for the save that takes b.tex');
await gitops.autosave(id, 'main');
eq(head('%an'), 'Ben', 'and signs it');

// an agent commit is never signed by a typist
edit('a.tex'); gitops.noteWriters(id, 'main', ['a.tex'], ada);
gitops.registerAttributedPaths(id, 'main', 'Tighten the intro', gitops.AGENT_COMMIT_AUTHOR, ['b.tex']);
edit('b.tex');
await gitops.autosave(id, 'main');
const two = await gitops.log(id, 'main', 2);
eq(two[1].author, 'Assistant', 'the agent’s path commits under Claude');
eq(two[1].coAuthors, undefined, 'with no typist on it');
eq(two[0].author, 'Ada Lovelace', 'the sweep after it is Ada’s');

// combining unpushed commits keeps everyone named
const combinedAuthors = execFileSync('git', ['log', '--format=%an <%ae>%n%(trailers:key=Co-authored-by,valueonly)', 'main'], { cwd: store.branchDir(id, 'main'), encoding: 'utf8' });
check(combinedAuthors.includes('Ada Lovelace <ada@example.org>') && combinedAuthors.includes('Ben <ben@aldine.local>'), 'the squash input sees authors and co-authors');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('typing-names: ok');
