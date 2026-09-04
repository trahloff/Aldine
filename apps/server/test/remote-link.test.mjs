import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-link-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');

const { remoteLink, setRemoteLink } = await import('../src/store.ts');

const legacy = {
  id: 'a',
  github: { fullName: 'o/r', owner: 'o', repo: 'r', remoteBranch: 'main', cloneUrl: 'https://x/o/r.git' },
};
check(remoteLink(legacy)?.provider === 'github', 'legacy meta.github reads as a github remote');
check(remoteLink(legacy)?.fullName === 'o/r', 'legacy fields carry over');
check(remoteLink(legacy)?.remoteBranch === 'main', 'legacy branch carries over');

const modern = {
  id: 'b',
  remote: { provider: 'gitlab', fullName: 'g/s/p', owner: 'g/s', repo: 'p', remoteBranch: 'main', cloneUrl: 'https://y/g/s/p.git' },
};
check(remoteLink(modern)?.provider === 'gitlab', 'modern meta.remote is returned as-is');
check(remoteLink(modern)?.fullName === 'g/s/p', 'nested gitlab path survives');

// There is no moment where both fields are authoritative — remote always wins.
const both = { ...legacy, remote: modern.remote };
check(remoteLink(both)?.provider === 'gitlab', 'remote takes precedence over legacy github');

check(remoteLink({ id: 'c' }) === undefined, 'unlinked project has no remote');

// setRemoteLink upgrades in place: the legacy field must not survive the write,
// or a later read would have two candidates.
const upgrading = { ...legacy };
setRemoteLink(upgrading, { provider: 'github', fullName: 'o/r2', owner: 'o', repo: 'r2', remoteBranch: 'main', cloneUrl: 'https://x/o/r2.git' });
check(upgrading.github === undefined, 'setRemoteLink drops the legacy field');
check(upgrading.remote?.fullName === 'o/r2', 'setRemoteLink stores the new link');
check(remoteLink(upgrading)?.fullName === 'o/r2', 'upgraded meta reads back correctly');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('remote-link: ALL PASSED');
