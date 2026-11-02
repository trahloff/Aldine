/**
 * A consistent copy of the SQLite datastore, taken while the server runs:
 *
 *   node dist/db/snapshot.js <file>
 *
 * A plain copy of a live aldine.db can miss the writes that are still in
 * aldine.db-wal, or catch the two at different moments. deploy/backup.sh runs
 * this in the app container; the copy is a complete database on its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { SQLITE_FILE } from './index.js';
import { loadSqlite } from './sqlite.js';

const out = process.argv[2];
if (!out) {
  console.error('usage: node dist/db/snapshot.js <file>');
  process.exit(2);
}
const file = path.join(config.metaRoot, SQLITE_FILE);
if (!fs.existsSync(file)) {
  console.error(`No SQLite datastore at ${file}.`);
  process.exit(1);
}
// VACUUM INTO fills an empty file and keeps its mode, so the copy is as private as the original.
fs.rmSync(out, { force: true });
fs.closeSync(fs.openSync(out, 'wx', 0o600));
const { DatabaseSync } = await loadSqlite();
const db = new DatabaseSync(file);
try {
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare('VACUUM INTO ?1').run(out);
} finally {
  db.close();
}
console.log(`Wrote a copy of ${file} to ${out}.`);
