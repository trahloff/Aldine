/**
 * The welcome mail goes to an address nobody confirmed, so the only part of
 * the sign-up request in it is that address: a name (text, markup or a link)
 * would make the instance send the signer's own message, under its own
 * branding, to anyone.
 *
 * Real register route (Fastify inject) and the real SMTP backend, against a
 * minimal SMTP listener on a free local port; env is set before any src
 * import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { check, eq } from './assert.mjs';

const mails = [];
const smtp = net.createServer((sock) => {
  let buf = '';
  let inData = false;
  sock.write('220 test ESMTP\r\n');
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    for (;;) {
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        mails.push(buf.slice(0, end));
        buf = buf.slice(end + 5);
        inData = false;
        sock.write('250 queued\r\n');
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      const cmd = buf.slice(0, nl).slice(0, 4).toUpperCase();
      buf = buf.slice(nl + 2);
      if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
      else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); return; }
      else sock.write('250 ok\r\n');
    }
  });
});
await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-welcome-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.address().port);
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_USER', 'SMTP_SECURE', 'ALDINE_SSO_ONLY']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);

/** Every body part as text: raw, quoted-printable decoded, and any base64 part decoded. */
function readable(raw) {
  const qp = raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const b64 = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n(?:[^\r\n]+\r\n)*\r\n([A-Za-z0-9+/=\r\n]+)/gi)]
    .map((m) => Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8'));
  return [raw, qp, ...b64].join('\n');
}

const name = 'Mallory <a href="https://evil.example/reset">Reset your password</a>';
const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'someone@example.com', password: 'password123', name } });
eq(res.statusCode, 200, 'sign-up succeeds');
eq(res.json().user.name, name, 'the account keeps the name it was given');

const deadline = Date.now() + 10_000;
while (!mails.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
eq(mails.length, 1, 'one welcome mail was sent');
const text = readable(mails[0]);
check(/Welcome to Aldine/.test(text) && text.includes('https://aldine.test'), 'the mail is the welcome mail with the workspace link');
check(text.includes('someone@example.com'), 'the mail is addressed to the sign-up address');
for (const part of ['evil.example', 'Reset your password', 'Mallory']) {
  check(!text.includes(part), `the mail carries nothing of the name (found ${JSON.stringify(part)})`);
}

await app.close();
smtp.close();
console.log('welcome-mail: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
