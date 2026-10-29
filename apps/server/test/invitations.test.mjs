/**
 * Sharing by email or ORCID iD stages an invitation, and only the person
 * invited can turn it into access: a signed-in account whose confirmed
 * address, or ORCID iD, is the one invited. Until then the project's share
 * list is untouched, so nothing grants access: not the REST routes, not the
 * project list, not the collab socket. The link is no credential: another
 * account, an unconfirmed one, a signed-out visitor and an access token all
 * get nothing. Decline is final for its invitation, withdraw and expiry
 * close it, Resend and Invite again open it anew, Accept is idempotent.
 * Share entries from before invitations keep working as they did. A
 * project's invitations go with the project.
 *
 * Real route table (Fastify inject), real SMTP backend against a local
 * listener; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { startSmtp, decoded } from './smtp-mock.mjs';

const smtp = await startSmtp();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-invitations-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test/write';
process.env.RL_INVITE_BURST = '100';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.port);
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_USER', 'SMTP_SECURE', 'ALDINE_SSO_ONLY', 'ALDINE_RESET_ECHO', 'ALDINE_TEST_HOOKS', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH', 'ALDINE_TRASH_DAYS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const { isListed } = await import('../src/authz.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

const call = (method, url, who, payload) => app.inject({
  method, url,
  headers: who ? (who.bearer ? { authorization: `Bearer ${who.bearer}` } : { cookie: who.cookie }) : {},
  ...(payload ? { payload } : {}),
});
const json = async (method, url, who, payload, code = 200) => {
  const res = await call(method, url, who, payload);
  eq(res.statusCode, code, `${method} ${url} as ${who?.name ?? 'nobody'}: ${res.body.slice(0, 200)}`);
  return res.json();
};
const settle = () => new Promise((r) => setTimeout(r, 300));

/** An account; confirmed unless asked otherwise. */
async function person(email, name, { confirmed = true, provider, subject } = {}) {
  const user = await auth.register(email, provider ? '' : 'password123', name, provider, subject);
  if (confirmed && !provider) await db().setEmailPending(user.id, null);
  return { id: user.id, name, email, cookie: `${auth.COOKIE}=${await auth.createSession(user.id)}` };
}
const ORCID = '0000-0002-1825-0097';
const owner = await person('owner@example.com', 'Olive Owner');
const bob = await person('bob@example.org', 'Bob');
const carol = await person('carol@example.org', 'Carol');
const josiah = await person(null, 'Josiah', { provider: 'orcid', subject: `orcid:${ORCID}` });

const project = await json('POST', '/api/projects', owner, { name: 'Field notes' });
const P = project.id;
const share = (who, collaborators, mode = 'private', id = P) => json('POST', `/api/projects/${id}/share`, who, { mode, collaborators });
const mine = (who) => json('GET', '/api/invitations', who);
const listed = async (who, id = P) => (await json('GET', '/api/projects', who)).some((p) => p.id === id);
const authenticate = (who, id = P) => collab.hocuspocus.configuration.onAuthenticate({ documentName: collab.docName(id, 'main', 'main.tex'), requestHeaders: { cookie: who.cookie } }).then(() => true, () => false);

// ---- adding people stages invitations; the share list stays as it was ----
let base = smtp.mails.length;
let r = await share(owner, ['Bob@Example.org', ORCID.toLowerCase(), 'owner@example.com']);
eq(r.share.collaborators, [], 'nobody is on the share list yet');
eq([r.invited, r.notEmailed], [1, []], 'the one address is mailed, the ORCID iD has no address to mail');
const byTo = (list) => [...list].sort((a, b) => a.to.localeCompare(b.to));
eq(byTo(r.invitations).map((i) => [i.to, i.state]), [[ORCID, 'pending'], ['bob@example.org', 'pending']], 'two open invitations, none for the owner');
const bobInv = r.invitations.find((i) => i.to === 'bob@example.org');
const orcidInv = r.invitations.find((i) => i.to === ORCID);
check(/^[0-9a-f]{32}$/.test(bobInv.id) && bobInv.id !== orcidInv.id, 'each invitation has its own 128-bit id');
eq(bobInv.link, `https://aldine.test/write/invite/${bobInv.id}`, 'the copy link is on the public URL, base path included');
const days = (Date.parse(bobInv.expiresAt) - Date.parse(bobInv.createdAt)) / 864e5;
eq(days, 14, 'an invitation is open for 14 days');
check(bobInv.emailedAt && !orcidInv.emailedAt, 'only the mailed one says it was emailed');
const mail = decoded(await smtp.waitFor(base + 1));
check(mail.includes('To: bob@example.org'), 'the invitation goes to the address');
check(mail.includes(`https://aldine.test/write/invite/${bobInv.id}`) && !mail.includes(`/p/${P}`), 'the mail links the invitation, not the project');
check(mail.includes('Accept the invitation') && mail.includes('works only for this address'), 'and says how it works');
await settle();
eq(smtp.mails.length, base + 1, 'one mail in all');

r = await share(owner, ['bob@example.org', ORCID]);
eq([r.invited, r.invitations.length], [0, 2], 'saving the same list again changes nothing');
eq(byTo(await json('GET', `/api/projects/${P}/invitations`, owner)).map((i) => i.id), [orcidInv.id, bobInv.id], 'the owner lists the open invitations');

// ---- nothing grants access before an accept ----
eq((await call('GET', `/api/projects/${P}`, bob)).statusCode, 403, 'the invitee cannot open the project');
eq((await call('GET', `/api/projects/${P}/file?branch=main&path=main.tex`, bob)).statusCode, 403, 'nor read a file');
eq((await call('GET', `/api/projects/${P}/thumbnail`, bob)).statusCode, 403, 'nor see its thumbnail');
eq((await call('POST', `/api/projects/${P}/opened`, bob, { branch: 'main' })).statusCode, 403, 'nor put it on their list');
check(!(await listed(bob)), 'it is not on their list');
check(!(await authenticate(bob)), 'the collab socket refuses them');
check(!isListed(await store.readMeta(P), { id: bob.id, email: bob.email, name: 'Bob' }), 'and the Agent API lists nothing');
check(!(await authenticate(josiah)), 'the ORCID invitee is refused as well');

// ---- the invitee sees it waiting, with the project's name ----
const waiting = await mine(bob);
eq(waiting.map((i) => [i.id, i.project.id, i.project.name, i.ownerName]), [[bobInv.id, P, 'Field notes', 'Olive Owner']], 'Bob finds the invitation on his Home');
eq((await mine(josiah)).map((i) => i.id), [orcidInv.id], 'the ORCID account finds the one to its iD');
eq(await mine(carol), [], 'someone else finds nothing');
eq((await call('GET', '/api/invitations', null)).statusCode, 401, 'signed out there is no list');

let view = await json('GET', `/api/invitations/${bobInv.id}`, bob);
eq([view.relation, view.state, view.to, view.ownerName, view.project?.name, view.member], ['match', 'pending', 'bob@example.org', 'Olive Owner', 'Field notes', false], 'the invitee sees the project');

// ---- the link is no credential ----
view = await json('GET', `/api/invitations/${bobInv.id}`, null);
eq([view.relation, view.to, view.ownerName, view.signedInAs], ['signed-out', 'bob@example.org', 'Olive Owner', null], 'signed out: who it is for and from');
check(!('project' in view) && !JSON.stringify(view).includes('Field notes'), 'but not the project');
eq((await call('POST', `/api/invitations/${bobInv.id}/accept`, null)).statusCode, 401, 'accepting signed out is refused');
view = await json('GET', `/api/invitations/${bobInv.id}`, carol);
eq([view.relation, view.signedInAs], ['other', 'carol@example.org'], 'another account is told it is not theirs');
check(!JSON.stringify(view).includes('Field notes'), 'and does not learn the project');
let res = await call('POST', `/api/invitations/${bobInv.id}/accept`, carol);
eq(res.statusCode, 403, 'another account cannot accept');
check(res.json().error.includes('bob@example.org') && res.json().error.includes('carol@example.org'), `and is told why: ${res.json().error}`);
eq((await call('POST', `/api/invitations/${bobInv.id}/decline`, carol)).statusCode, 403, 'nor decline');
eq((await call('POST', `/api/invitations/${orcidInv.id}/accept`, bob)).statusCode, 403, 'an email account cannot take an ORCID invitation');
eq((await call('GET', `/api/projects/${P}`, carol)).statusCode, 403, 'Carol still has no access');
eq((await call('GET', `/api/invitations/${'0'.repeat(32)}`, bob)).statusCode, 404, 'an unknown id is not found');
eq((await call('GET', '/api/invitations/not-an-id', bob)).statusCode, 404, 'nor a malformed one');
const token = (await json('POST', '/api/tokens', bob, { name: 'agent' })).token;
eq((await call('POST', `/api/invitations/${bobInv.id}/accept`, { bearer: token, name: 'token' })).statusCode, 403, "the invitee's access token cannot accept for them");
eq((await call('GET', '/api/invitations', { bearer: token, name: 'token' })).statusCode, 403, 'nor list their invitations');

// ---- an unconfirmed account with the invited address waits ----
r = await share(owner, ['pat@example.org']);
const patInv = r.invitations.find((i) => i.to === 'pat@example.org');
const pat = await person('pat@example.org', 'Pat', { confirmed: false });
eq(await mine(pat), [], 'an unconfirmed address has no invitations yet');
view = await json('GET', `/api/invitations/${patInv.id}`, pat);
eq(view.relation, 'unconfirmed', 'its invitation page asks to confirm first');
check(!('project' in view), 'without naming the project');
res = await call('POST', `/api/invitations/${patInv.id}/accept`, pat);
eq(res.statusCode, 403, 'accepting before confirming is refused');
check(/Confirm your email address/.test(res.json().error), 'and says what to do');
await db().setEmailPending(pat.id, null);
eq((await mine(pat)).map((i) => i.id), [patInv.id], 'once confirmed the invitation is there');

// ---- accepting: exactly today's share entry ----
r = await json('POST', `/api/invitations/${bobInv.id}/accept`, bob);
eq([r.ok, r.projectId], [true, P], 'Bob accepts');
eq((await json('GET', `/api/projects/${P}`, owner)).share.collaborators, ['bob@example.org'], 'his address is on the share list');
eq((await call('GET', `/api/projects/${P}`, bob)).statusCode, 200, 'he opens the project');
eq((await call('GET', `/api/projects/${P}/file?branch=main&path=main.tex`, bob)).statusCode, 200, 'and reads its files');
check(await listed(bob), 'it is on his list');
eq((await json('GET', '/api/projects', bob)).find((p) => p.id === P).access, 'member', 'as a member');
check(await authenticate(bob), 'the collab socket lets him in');
eq(await mine(bob), [], 'nothing waits for him any more');
eq((await json('GET', `/api/projects/${P}/invitations`, owner)).map((i) => i.to), [ORCID, 'pat@example.org'], 'the owner no longer lists his invitation');
r = await json('POST', `/api/invitations/${bobInv.id}/accept`, bob);
eq([r.ok, r.already], [true, true], 'accepting again just opens the project');
view = await json('GET', `/api/invitations/${bobInv.id}`, bob);
eq([view.state, view.member], ['accepted', true], 'the page says it was accepted');
eq((await call('POST', `/api/invitations/${bobInv.id}/decline`, bob)).statusCode, 409, 'an accepted invitation cannot be declined');

const twice = await Promise.all([call('POST', `/api/invitations/${orcidInv.id}/accept`, josiah), call('POST', `/api/invitations/${orcidInv.id}/accept`, josiah)]);
eq(twice.map((x) => [x.statusCode, x.json().projectId]), [[200, P], [200, P]], 'the ORCID account accepts its invitation, from two tabs at once');
check(await authenticate(josiah), 'and gets in');
eq((await json('GET', `/api/projects/${P}`, owner)).share.collaborators, ['bob@example.org', ORCID], 'by its iD');

// ---- a dialog opened before someone accepted removes only what its owner took off ----
r = await json('POST', `/api/projects/${P}/share`, owner, { mode: 'private', collaborators: ['bob@example.org', 'pat@example.org'], previous: ['bob@example.org'] });
eq(r.share.collaborators, ['bob@example.org', ORCID], 'the iD accepted after the dialog opened stays');
check(await authenticate(josiah), 'with its access');

// ---- who may manage invitations ----
eq((await call('GET', `/api/projects/${P}/invitations`, bob)).statusCode, 403, 'a collaborator cannot list the invitations');
eq((await call('POST', `/api/projects/${P}/invitations`, bob, { to: 'mallory@example.org' })).statusCode, 403, 'nor invite');
eq((await call('DELETE', `/api/projects/${P}/invitations/${patInv.id}`, bob)).statusCode, 403, 'nor withdraw');
eq((await call('POST', `/api/projects/${P}/invitations/${patInv.id}/resend`, bob)).statusCode, 403, 'nor resend');
eq((await call('GET', `/api/projects/${P}/invitations`, carol)).statusCode, 403, 'a stranger cannot either');
eq((await call('POST', `/api/projects/${P}/invitations`, owner, { to: 'bob@example.org' })).statusCode, 409, 'someone with access is not invited');
eq((await call('POST', `/api/projects/${P}/invitations`, owner, { to: 'pat@example.org' })).statusCode, 409, 'nor someone already invited');
eq((await call('POST', `/api/projects/${P}/invitations`, owner, { to: 'Owner@Example.com' })).statusCode, 400, 'nor the owner');
eq((await call('POST', `/api/projects/${P}/invitations`, owner, { to: 'nope' })).statusCode, 400, 'nor something that is no address');

// ---- decline is final for that invitation; Invite again sends a new one ----
r = await json('POST', `/api/projects/${P}/invitations`, owner, { to: 'dave@example.org' });
const dave = await person('dave@example.org', 'Dave');
const daveInv = r.invitations.find((i) => i.to === 'dave@example.org');
eq(r.invited, 1, 'a single invitation is mailed');
eq((await json('POST', `/api/invitations/${daveInv.id}/decline`, dave)).ok, true, 'Dave declines');
eq((await json('GET', `/api/projects/${P}/invitations`, owner)).find((i) => i.id === daveInv.id).state, 'declined', 'the owner sees it declined');
eq(await mine(dave), [], 'it leaves his Home');
res = await call('POST', `/api/invitations/${daveInv.id}/accept`, dave);
eq([res.statusCode, res.json().state], [410, 'declined'], 'a declined invitation cannot be accepted');
eq((await call('POST', `/api/projects/${P}/invitations/${daveInv.id}/resend`, owner)).statusCode, 409, 'nor resent');
r = await json('POST', `/api/projects/${P}/invitations`, owner, { to: 'dave@example.org' });
const daveAgain = r.invitations.find((i) => i.to === 'dave@example.org');
check(daveAgain.id !== daveInv.id && daveAgain.state === 'pending', 'Invite again opens a new invitation');
eq((await call('GET', `/api/invitations/${daveInv.id}`, dave)).statusCode, 404, 'and the declined link is gone');
eq(r.invitations.filter((i) => i.to === 'dave@example.org').length, 1, 'one entry per person in the list');

// ---- withdraw ----
r = await share(owner, ['bob@example.org', ORCID, 'erin@example.org']);
const erin = await person('erin@example.org', 'Erin');
const erinInv = r.invitations.find((i) => i.to === 'erin@example.org');
r = await json('DELETE', `/api/projects/${P}/invitations/${erinInv.id}`, owner);
check(!r.invitations.some((i) => i.id === erinInv.id), 'a withdrawn invitation leaves the owner\'s list');
eq(await mine(erin), [], 'and the invitee\'s Home');
eq((await json('GET', `/api/invitations/${erinInv.id}`, erin)).state, 'withdrawn', 'its page says it was withdrawn');
res = await call('POST', `/api/invitations/${erinInv.id}/accept`, erin);
eq([res.statusCode, res.json().state], [410, 'withdrawn'], 'and it cannot be accepted');
eq((await call('GET', `/api/projects/${P}`, erin)).statusCode, 403, 'Erin has no access');
eq((await call('DELETE', `/api/projects/${P}/invitations/${bobInv.id}`, owner)).statusCode, 409, 'an accepted invitation is not withdrawn: the share entry is removed instead');

// ---- expiry; Resend renews under the same link ----
const patRow = await db().getInvitation(patInv.id);
await db().setInvitation({ ...patRow, expiresAt: new Date(Date.now() - 1000).toISOString() });
eq(await mine(pat), [], 'an expired invitation leaves the Home');
eq((await json('GET', `/api/projects/${P}/invitations`, owner)).find((i) => i.id === patInv.id).state, 'expired', 'the owner sees it expired');
res = await call('POST', `/api/invitations/${patInv.id}/accept`, pat);
eq([res.statusCode, res.json().state], [410, 'expired'], 'an expired invitation cannot be accepted');
base = smtp.mails.length;
r = await json('POST', `/api/projects/${P}/invitations/${patInv.id}/resend`, owner);
eq(r.invited, 1, 'Resend mails it again');
const renewed = r.invitations.find((i) => i.id === patInv.id);
check(renewed.state === 'pending' && Date.parse(renewed.expiresAt) > Date.now() + 13 * 864e5, 'and opens it for 14 more days');
check(decoded(await smtp.waitFor(base + 1)).includes(`/invite/${patInv.id}`), 'with the same link');
eq((await json('POST', `/api/invitations/${patInv.id}/accept`, pat)).projectId, P, 'Pat accepts now');

// ---- removal ends access; the accepted link does not bring it back ----
r = await json('POST', `/api/projects/${P}/share`, owner, { mode: 'private', collaborators: [ORCID, 'pat@example.org'], previous: ['bob@example.org', ORCID, 'pat@example.org'] });
eq(r.share.collaborators, [ORCID, 'pat@example.org'], 'what the owner took off the list is removed');
eq((await call('GET', `/api/projects/${P}`, bob)).statusCode, 403, 'a removed collaborator loses access');
view = await json('GET', `/api/invitations/${bobInv.id}`, bob);
eq([view.state, view.member], ['accepted', false], 'his old link says it was used');
eq((await call('POST', `/api/invitations/${bobInv.id}/accept`, bob)).statusCode, 410, 'and grants nothing again');
// Invite again: he had taken the project off his list before; accepting puts it back.
await call('POST', `/api/projects/${P}/opened`, owner, { branch: 'main' });
await db().setProjectOpen({ userId: bob.id, projectId: P, at: new Date().toISOString(), branch: 'main', hidden: true });
r = await share(owner, [ORCID, 'pat@example.org', 'bob@example.org']);
const bobAgain = r.invitations.find((i) => i.to === 'bob@example.org');
check(bobAgain && bobAgain.id !== bobInv.id, 'inviting him again opens a new invitation');
await json('POST', `/api/invitations/${bobAgain.id}/accept`, bob);
check(await listed(bob), 'accepting lists the project again');

// ---- share entries from before invitations keep working ----
const legacyMeta = await store.readMeta(P);
legacyMeta.share.collaborators.push('lee@example.org');
await store.writeMeta(legacyMeta);
await db().createUser({ id: 'legacy-lee', email: 'lee@example.org', name: 'Lee', salt: 's', hash: 'h', createdAt: '2026-01-01T00:00:00.000Z' });
const lee = { name: 'Lee', cookie: `${auth.COOKIE}=${await auth.createSession('legacy-lee')}` };
eq((await call('GET', `/api/projects/${P}`, lee)).statusCode, 200, 'an entry with no invitation behind it still grants access');
r = await share(owner, [ORCID, 'pat@example.org', 'bob@example.org', 'lee@example.org']);
eq(r.share.collaborators.includes('lee@example.org'), true, 'and stays on the list when the owner saves');
check(!r.invitations.some((i) => i.to === 'lee@example.org'), 'without an invitation');

// ---- a trashed project's invitations behave as gone; a purge takes them ----
const p2 = await json('POST', '/api/projects', owner, { name: 'Draft two' });
r = await share(owner, ['carol@example.org'], 'private', p2.id);
const carolInv = r.invitations[0];
eq((await mine(carol)).map((i) => i.id), [carolInv.id], 'Carol is invited to the second project');
await json('DELETE', `/api/projects/${p2.id}`, owner);
eq(await mine(carol), [], 'trashing the project hides the invitation');
eq((await call('GET', `/api/invitations/${carolInv.id}`, carol)).statusCode, 404, 'its link finds nothing');
eq((await call('POST', `/api/invitations/${carolInv.id}/accept`, carol)).statusCode, 404, 'and accepts nothing');
await json('POST', `/api/projects/${p2.id}/restore`, owner);
eq((await mine(carol)).map((i) => i.id), [carolInv.id], 'restoring brings it back');
await json('DELETE', `/api/projects/${p2.id}`, owner);
await json('DELETE', `/api/projects/${p2.id}?permanent=1`, owner);
eq(await db().listProjectInvitations(p2.id), [], 'deleting the project forever deletes its invitations');

// ---- without a transport the invitation is made all the same ----
delete process.env.SMTP_HOST;
const p3 = await json('POST', '/api/projects', owner, { name: 'Quiet' });
base = smtp.mails.length;
r = await share(owner, ['quiet@example.org'], 'private', p3.id);
eq([r.invited, r.notEmailed, r.reason], [0, ['quiet@example.org'], 'no-mail'], 'nothing is mailed, and the response says so');
eq([r.invitations.length, r.invitations[0].emailedAt, r.invitations[0].state], [1, null, 'pending'], 'the invitation exists, never emailed');
check(r.invitations[0].link.endsWith(`/invite/${r.invitations[0].id}`), 'with a link to copy');
const quiet = await person('quiet@example.org', 'Quiet');
eq((await mine(quiet)).map((i) => i.id), [r.invitations[0].id], 'and waits on their Home');
r = await json('POST', `/api/projects/${p3.id}/invitations/${r.invitations[0].id}/resend`, owner);
eq([r.invited, r.reason], [0, 'no-mail'], 'Resend without a transport renews it and says it mailed nothing');
await settle();
eq(smtp.mails.length, base, 'no mail reached the listener');

// ---- at most 50 collaborators and open invitations together ----
const many = Array.from({ length: 49 }, (_, i) => `m${i}@example.org`);
r = await share(owner, ['quiet@example.org', ...many], 'private', p3.id);
eq(r.invitations.length, 50, 'fifty open invitations fit');
eq((await call('POST', `/api/projects/${p3.id}/invitations`, owner, { to: 'one-more@example.org' })).statusCode, 400, 'a fifty-first does not');

await app.close();
smtp.close();
console.log('invitations: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
