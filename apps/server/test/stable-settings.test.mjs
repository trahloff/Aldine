/**
 * docs/STABILITY.md, "Settings": every variable in the main table of
 * deploy/README.md ("All configuration", not "Tests and internals") keeps its
 * name within 1.x. Each one must still be read: by the server or the compiler,
 * or, for the few that only the deployment uses, by the compose files, the
 * Caddyfile or the backup scripts. Passing a variable through in
 * docker-compose.full.yml does not count as reading it: the compose file
 * would go on passing a name the app no longer reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './assert.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Read outside the app, so the code never names them. */
const DEPLOY_ONLY = ['ALDINE_DOMAIN', 'ALDINE_APP_BIND', 'ALDINE_PORT', 'ALDINE_PROJECT', 'ALDINE_TEXLIVE_SCHEME', 'ALDINE_VERSION', 'ALDINE_TEXLIVE'];
const DEPLOY_FILES = ['docker-compose.yml', 'docker-compose.full.yml', 'deploy/docker-compose.prod.yml', 'deploy/Caddyfile', 'deploy/backup.sh', 'deploy/restore.sh'];

/** The variable names in the first column of the table under "## All configuration". */
function stableSettings(readme) {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => /^##\s+All configuration\s*$/.test(l));
  check(start !== -1, 'deploy/README.md has an "## All configuration" section');
  const names = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#/.test(line)) break;
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const first = line.split(/(?<!\\)\|/)[1].trim();
    if (first === 'Variable' || /^:?-+:?$/.test(first)) continue;
    // e.g. `SMTP_HOST/PORT/USER/PASS/FROM`, `SES_FROM` + `AWS_REGION`
    const found = [...first.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((s) => /^[A-Z][A-Z0-9_]*(\/[A-Z0-9_]+)*$/.test(s))
      .flatMap((s) => {
        const [head, ...tails] = s.split('/');
        const prefix = head.slice(0, head.lastIndexOf('_') + 1);
        return [head, ...tails.map((t) => prefix + t)];
      });
    // An italic note in place of a name, like the per-repository token row.
    if (found.length === 0 && first.startsWith('*')) continue;
    check(found.length > 0, `cannot read a variable name from this row of deploy/README.md, "All configuration": ${line.slice(0, 120)}`);
    names.push(...found);
  }
  return names;
}

function sources(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(abs, ext));
    else if (ext.test(e.name)) out.push(abs);
  }
  return out;
}

/** Comment lines dropped: a variable named only in a comment is not read. */
const codeOf = (file, comment) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => !comment.test(l)).join('\n');
const code = [...sources(path.join(repo, 'apps/server/src'), /\.ts$/), ...sources(path.join(repo, 'apps/compiler'), /\.m?js$/)]
  .map((f) => codeOf(f, /^\s*(\/\/|\/\*|\*)/)).join('\n');
const deploy = DEPLOY_FILES.map((f) => codeOf(path.join(repo, f), /^\s*#/)).join('\n');

// env.NAME, env['NAME'], or either side of a rename: envWithFallback('NAME', ['OLD'])
const readInCode = (name) => new RegExp(`\\benv(\\.${name}\\b|\\[['"\`]${name}['"\`]\\])|\\benvWithFallback\\([^)]*['"]${name}['"]`).test(code);
// ${NAME}, ${NAME:-x}, ${NAME-x}, ${NAME:?x} in compose and sh; {$NAME} in the Caddyfile
const readInDeploy = (name) => new RegExp(`\\$\\{${name}[}:?-]|\\{\\$${name}\\}`).test(deploy);

const names = stableSettings(fs.readFileSync(path.join(repo, 'deploy/README.md'), 'utf8'));
check(names.length >= 50, `the stable table yields at least 50 variables (got ${names.length}: ${names.join(', ')})`);
check(!names.includes('ALDINE_TEST_HOOKS') && !names.includes('TEMPLATES_DIR'), 'the parser stops before "Tests and internals"');
for (const n of ['GOOGLE_OAUTH_CLIENT_SECRET', 'SMTP_FROM', 'AWS_REGION', 'OPENAI_API_KEY', 'TEMPLATE_REPOS_FILE', 'RL_OAUTH_CLIENT_BURST']) {
  check(names.includes(n), `the parser expands the table's shorthand to ${n}`);
}
for (const n of DEPLOY_ONLY) check(names.includes(n), `${n} is listed as read by the deployment but is not in the stable table any more; drop it from DEPLOY_ONLY`);

const unread = [];
for (const name of new Set(names)) {
  if (DEPLOY_ONLY.includes(name)) { if (!readInDeploy(name)) unread.push(`${name}: not read in ${DEPLOY_FILES.join(', ')}`); }
  else if (!readInCode(name)) unread.push(`${name}: not read in apps/server/src or apps/compiler`);
}
check(unread.length === 0, `deploy/README.md lists these as stable settings (docs/STABILITY.md, "Settings"), but nothing reads them any more:\n  - ${unread.join('\n  - ')}\nWithin 1.x a stable setting keeps its name`);

console.log(`stable settings: ${new Set(names).size} variables, all read; ALL PASSED`);
