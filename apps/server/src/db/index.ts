import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { DataStore } from './types.js';
import { JsonStore } from './json.js';
import { PgStore } from './pg.js';
import { SqliteStore } from './sqlite.js';

export * from './types.js';

/** The SQLite datastore's file, in META_DIR beside the JSON files it replaces. */
export const SQLITE_FILE = 'aldine.db';

export type DatastoreKind = 'sqlite' | 'json' | 'postgres';

/** DATABASE_URL selects Postgres; otherwise ALDINE_DATASTORE, `sqlite` (the
 *  default) or `json`. Both set at once is refused rather than guessed. */
export function datastoreKind(env: NodeJS.ProcessEnv = process.env): DatastoreKind {
  const want = (env.ALDINE_DATASTORE ?? '').trim().toLowerCase();
  if (want && want !== 'sqlite' && want !== 'json') {
    throw new Error(`ALDINE_DATASTORE must be sqlite or json, not "${env.ALDINE_DATASTORE}"`);
  }
  if (env.DATABASE_URL) {
    if (want) throw new Error(`ALDINE_DATASTORE=${want} and DATABASE_URL are both set. DATABASE_URL selects Postgres: unset one of them.`);
    return 'postgres';
  }
  return want === 'json' ? 'json' : 'sqlite';
}

let store: DataStore | null = null;

export async function initDb(): Promise<DataStore> {
  if (store) return store;
  const kind = datastoreKind();
  const file = path.join(config.metaRoot, SQLITE_FILE);
  store = kind === 'postgres' ? new PgStore(process.env.DATABASE_URL!)
    : kind === 'json' ? new JsonStore(config.metaRoot)
    : new SqliteStore(file, config.metaRoot);
  await store.init();
  console.log(`[aldine] datastore: ${kind === 'sqlite' ? `sqlite (${file})` : kind}`);
  if (kind === 'json' && fs.existsSync(file)) {
    console.warn(`[aldine] datastore: ALDINE_DATASTORE=json, so ${file} is not used. Whatever changed while Aldine ran on it is only there, not in the JSON files.`);
  }
  return store;
}

/** The active DataStore. Throws if used before initDb() (a startup ordering bug). */
export function db(): DataStore {
  if (!store) throw new Error('datastore not initialized — call initDb() at startup');
  return store;
}

/** Test/shutdown helper. */
export async function closeDb(): Promise<void> {
  await store?.close();
  store = null;
}
