/**
 * Register an OAuth client as the administrator, for servers that run with
 * ALDINE_OAUTH_REGISTRATION=closed:
 *
 *   npm run oauth:add-client -w apps/server -- --name Claude \
 *     --redirect-uri https://claude.ai/api/mcp/auth_callback
 *
 * In the published image: `docker compose exec app node
 * dist/cli/oauth-add-client.js --name … --redirect-uri …`. Same env as the
 * server (DATA_DIR/META_DIR, DATABASE_URL or ALDINE_DATASTORE): the client
 * goes into the datastore the running server reads.
 *
 * The record and its validation are exactly what POST /oauth/register
 * stores, so the client behaves like any registered one.
 */
import { parseArgs } from 'node:util';

// Boot lines from the server modules go to stderr; stdout carries the result.
console.log = (...args: unknown[]) => console.error(...args);

const USAGE = 'Usage: oauth:add-client --name <name> --redirect-uri <uri> [--redirect-uri <uri> …] [--json]';

let values: { name?: string; 'redirect-uri'?: string[]; json?: boolean; help?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      name: { type: 'string' },
      'redirect-uri': { type: 'string', multiple: true },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
  process.exit(2);
}
if (values.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
const name = values.name?.trim();
const uris = values['redirect-uri'] ?? [];
if (!name || !uris.length) {
  process.stderr.write(`Both --name and at least one --redirect-uri are required.\n${USAGE}\n`);
  process.exit(2);
}

const { initDb, closeDb, datastoreKind } = await import('../db/index.js');
const { registerClient } = await import('../oauth/register.js');
const { OAuthError } = await import('../oauth/errors.js');
const { registrationMode } = await import('../oauth/registration.js');

if (datastoreKind() === 'json') {
  // The JSON store caches its files in the server process and writes them back whole.
  process.stderr.write('ALDINE_DATASTORE=json: stop the server before adding a client and start it again afterwards, or the server will not see the client and may overwrite it.\n');
}

await initDb();
let exitCode = 0;
try {
  const c = await registerClient({ client_name: name, redirect_uris: uris });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(c, null, 2)}\n`);
  } else {
    process.stdout.write(`Registered "${c.client_name}"\nclient_id: ${c.client_id}\nredirect_uris: ${c.redirect_uris.join(' ')}\n`);
    process.stdout.write('Enter the client_id in the app\'s OAuth settings (claude.ai: Advanced settings → OAuth Client ID). Leave the client secret empty.\n');
    if (registrationMode() === 'open') {
      process.stdout.write('Note: ALDINE_OAUTH_REGISTRATION is open, so any client can still register itself.\n');
    }
  }
} catch (err) {
  process.stderr.write(`${err instanceof OAuthError ? err.description : (err as Error).message}\n`);
  exitCode = 1;
} finally {
  await closeDb();
}
process.exit(exitCode);
