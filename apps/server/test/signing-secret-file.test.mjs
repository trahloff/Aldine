/**
 * The generated signing secret in META_DIR (#199). It is written to a temp
 * file, flushed, and only then published under its name, so a crash cannot
 * leave the name on an empty file. One left by an older version stops the
 * server at startup with what to do, not with a bare "unreadable".
 *
 * Env is set before any src import: config reads the roots at module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq, throws } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-signing-secret-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.ALDINE_SIGNING_SECRET;

const { ensureSigningSecret } = await import('../src/output-signing.ts');
const file = path.join(process.env.META_DIR, 'output-signing-secret');

fs.mkdirSync(process.env.META_DIR, { recursive: true });
fs.writeFileSync(file, '');
await throws(() => ensureSigningSecret(), `${file} exists but holds no usable secret`, 'an empty secret file stops startup, naming it');
await throws(() => ensureSigningSecret(), 'Delete it to have a new one generated', 'and says what to do');
eq(fs.readFileSync(file, 'utf8'), '', 'the file is left as it is');

fs.rmSync(file);
ensureSigningSecret();
check(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url').length >= 32, 'a new secret is generated');
eq(fs.statSync(file).mode & 0o777, 0o600, 'private to the server');
eq(fs.readdirSync(process.env.META_DIR).filter((f) => f.endsWith('.tmp')), [], 'and no temp file is left');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ signing secret file: all passed');
