import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-glsvc-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');

delete process.env.GITLAB_TOKEN;
delete process.env.GITLAB_DEFAULT_GROUP;
delete process.env.GITLAB_DEFAULT_VISIBILITY;

const { autoProvisionEnabled, serviceConnection } = await import('../src/gitlab.ts');
const { gitlabConfig } = await import('../src/config.ts');

// Both vars are required: a token with no group has nowhere to put projects,
// and a group with no token no way to create them.
check(autoProvisionEnabled() === false, 'off with no env');
check(serviceConnection() === null, 'no service connection without a token');

process.env.GITLAB_TOKEN = 'svc-token';
check(autoProvisionEnabled() === false, 'a token alone is not enough');

delete process.env.GITLAB_TOKEN;
process.env.GITLAB_DEFAULT_GROUP = 'research/latex';
check(autoProvisionEnabled() === false, 'a group alone is not enough');

process.env.GITLAB_TOKEN = 'svc-token';
check(autoProvisionEnabled() === true, 'on with token + group');

const c = serviceConnection();
check(c.token === 'svc-token', 'service connection carries the token');
check(c.login === 'aldine-service', 'service connection is marked, not a real username');
check(c.baseUrl === 'https://gitlab.com', 'defaults to gitlab.com');

process.env.GITLAB_URL = 'https://git.example.com';
check(serviceConnection().baseUrl === 'https://git.example.com', 'honours GITLAB_URL');

// Visibility is read lazily and falls back rather than throwing on a typo.
check(gitlabConfig.visibility === 'private', 'defaults to private');
process.env.GITLAB_DEFAULT_VISIBILITY = 'internal';
check(gitlabConfig.visibility === 'internal', 'accepts internal');
process.env.GITLAB_DEFAULT_VISIBILITY = 'public';
check(gitlabConfig.visibility === 'public', 'accepts public');
process.env.GITLAB_DEFAULT_VISIBILITY = 'nonsense';
check(gitlabConfig.visibility === 'private', 'an unrecognised visibility falls back to private');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('gitlab-service: ALL PASSED');
