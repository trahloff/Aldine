/**
 * Profile pictures (#277): an OIDC `picture` claim is fetched once by the
 * server at sign-in, stored in META_DIR and served from
 * /api/users/:id/avatar to signed-in accounts only. SVG and non-images are
 * refused, a remote http URL is refused, a provider that stops reporting a
 * picture takes its own away, and a deleted account leaves no picture.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { createMockOidc, AVATAR_PNG } from '../../../e2e/auth-tests/mock-oidc.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-avatars-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_SSO_ONLY = '1';
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
delete process.env.ALDINE_BASE_PATH;
delete process.env.ALDINE_AVATARS;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.SENTRY_DSN;
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><title>Aldine</title>\n');

const mock = await createMockOidc().listen();
Object.assign(process.env, { OIDC_ISSUER: mock.issuer, OIDC_CLIENT_ID: 'aldine-e2e', OIDC_CLIENT_SECRET: 'aldine-e2e-secret' });

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const avatars = await import('../src/avatars.ts');
const { profileFrom, oidcConfig } = await import('../src/oidc.ts');
const auth = await import('../src/auth.ts');
const app = await buildApp();

let ip = 0;
const get = (url, cookie) => app.inject({ method: 'GET', url, remoteAddress: `10.8.0.${1 + (ip++ % 250)}`, headers: cookie ? { cookie } : {} });
const cookieValue = (res, name) => {
  const c = [res.headers['set-cookie'] ?? []].flat().find((s) => s.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(';')[0] : undefined;
};
async function signIn(code) {
  const res = await get('/api/auth/oauth/oidc');
  const [, state, secret] = cookieValue(res, 'aldine_oauth_state').split('.');
  const loc = new URL(res.headers.location);
  loc.searchParams.set('persona', code);
  const back = new URL((await fetch(loc, { redirect: 'manual' })).headers.get('location'));
  const cb = await get(`/api/auth/oauth/oidc/callback${back.search}`, `aldine_oauth_state=oidc.${state}.${secret}`);
  eq(cb.statusCode, 302, `sign-in as ${code} (${cb.body})`);
  return `aldine_session=${cookieValue(cb, 'aldine_session')}`;
}
/** The picture is fetched after the redirect, off the sign-in's path. */
async function meEventually(cookie, want) {
  for (let i = 0; i < 50; i++) {
    const me = (await get('/api/auth/me', cookie)).json().user;
    if (want(me)) return me;
    await new Promise((r) => setTimeout(r, 20));
  }
  return (await get('/api/auth/me', cookie)).json().user;
}

// ---- the claim: ID token first, then userinfo; long data: URIs pass uncut ----
{
  const c = oidcConfig();
  eq(profileFrom({ iss: 'https://i/', sub: 's', picture: 'https://idp/a.png' }, { sub: 's', picture: 'https://idp/b.png' }, c).picture, 'https://idp/a.png', 'ID token picture wins');
  eq(profileFrom({ iss: 'https://i/', sub: 's' }, { sub: 's', picture: 'https://idp/b.png' }, c).picture, 'https://idp/b.png', 'userinfo supplies a picture');
  check(!('picture' in profileFrom({ iss: 'https://i/', sub: 's', picture: 42 }, null, c)), 'a non-string picture is ignored');
  const data = `data:image/png;base64,${'A'.repeat(4000)}`;
  eq(profileFrom({ iss: 'https://i/', sub: 's', picture: data }, null, c).picture, data, 'a data: URI is kept whole');
}

// ---- sniffing ----
{
  eq(avatars.sniffImage(AVATAR_PNG), 'image/png', 'PNG');
  eq(avatars.sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg', 'JPEG');
  eq(avatars.sniffImage(Buffer.from('GIF89a......')), 'image/gif', 'GIF');
  eq(avatars.sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp', 'WebP');
  eq(avatars.sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null, 'SVG is refused');
}

// ---- sign-in stores the picture; the route serves it to accounts only ----
const pic = `${mock.origin}/media/avatar.png`;
mock.addPersona({ code: 'ada', sub: 'ada-1', claims: { name: 'Ada', email: 'ada@example.org', email_verified: true, picture: pic } });
mock.addPersona({ code: 'bob', sub: 'bob-1', claims: { name: 'Bob', email: 'bob@example.org', email_verified: true } });
const ada = await signIn('ada');
const me = await meEventually(ada, (u) => !!u.avatar);
check(/^[0-9a-f]+$/.test(me.avatar ?? ''), `/me names the picture's version (${JSON.stringify(me)})`);
const bob = await signIn('bob');
{
  const bobMe = await meEventually(bob, () => true);
  check(!bobMe.avatar, 'no picture claim, no avatar');
  const img = await get(`/api/users/${me.id}/avatar?v=${me.avatar}`, bob);
  eq(img.statusCode, 200, 'another signed-in account loads it');
  eq(img.headers['content-type'], 'image/png', 'served as the sniffed type');
  check(img.rawPayload.equals(AVATAR_PNG), 'the bytes the IdP served');
  eq(img.headers['x-content-type-options'], 'nosniff', 'nosniff');
  check(String(img.headers['content-security-policy']).includes('sandbox'), 'sandboxed');
  eq((await get(`/api/users/${me.id}/avatar`)).statusCode, 401, 'anonymous → 401');
  eq((await get(`/api/users/${bobMe.id}/avatar`, bob)).statusCode, 404, 'no picture → 404');
  eq((await get('/api/users/..%2F..%2Fx/avatar', bob)).statusCode, 404, 'a path in the id finds nothing');
}

// ---- a second sign-in within a day does not fetch again ----
{
  const hits = mock.state.avatarHits;
  await signIn('ada');
  await meEventually(ada, () => true);
  eq(mock.state.avatarHits, hits, 'unchanged picture is not fetched again');
}

// ---- refusals keep what is stored ----
{
  const v = avatars.avatarVersion(me.id);
  await avatars.syncAvatar(me.id, 'oidc', `${mock.origin}/media/avatar.svg`, { allowLoopbackHttp: true });
  eq(avatars.avatarVersion(me.id), v, 'an SVG is not stored');
  await avatars.syncAvatar(me.id, 'oidc', 'http://idp.example.org/a.png', { allowLoopbackHttp: true });
  eq(avatars.avatarVersion(me.id), v, 'remote plain http is not fetched');
  await avatars.syncAvatar(me.id, 'oidc', `${mock.origin}/media/avatar.png?size=2`, { allowLoopbackHttp: false });
  eq(avatars.avatarVersion(me.id), v, 'loopback http only when the issuer is local');
  await avatars.syncAvatar(me.id, 'oidc', `data:image/png;base64,${Buffer.alloc(avatars.MAX_AVATAR_BYTES + 10).toString('base64')}`);
  eq(avatars.avatarVersion(me.id), v, 'an oversized data: URI is refused');
}

// ---- data: URIs; the reporting provider alone takes its picture away ----
{
  const bobId = (await get('/api/auth/me', bob)).json().user.id;
  await avatars.syncAvatar(bobId, 'oidc', `data:image/png;base64,${AVATAR_PNG.toString('base64')}`);
  check(avatars.avatarVersion(bobId), 'a data: URI picture is stored');
  await avatars.syncAvatar(bobId, 'github', undefined);
  check(avatars.avatarVersion(bobId), 'another provider without a picture leaves it');
  await signIn('bob');
  await meEventually(bob, (u) => !u.avatar);
  check(!avatars.avatarVersion(bobId), 'the provider that set it, now without one, removes it');
}

// ---- account deletion removes the files ----
{
  await auth.deleteAccount(me.id);
  check(!fs.existsSync(path.join(tmp, 'meta', 'meta', 'avatars', `${me.id}.img`)), 'deleted account leaves no picture');
}

await app.close();
await mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Avatars: ALL PASSED');
