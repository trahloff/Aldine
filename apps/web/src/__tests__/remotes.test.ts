import { describe, expect, it } from 'vitest';
import { instanceBase, remoteDescriptor } from '../remotes';

describe('instanceBase', () => {
  it('keeps origin and sub-path, without a trailing slash or API path', () => {
    expect(instanceBase('https://gitlab.example.org/')).toBe('https://gitlab.example.org');
    expect(instanceBase(' https://example.org/git/ ')).toBe('https://example.org/git');
    expect(instanceBase('https://gitlab.example.org/api/v4')).toBe('https://gitlab.example.org');
    expect(instanceBase('https://codeberg.org/api/v1/')).toBe('https://codeberg.org');
    expect(instanceBase('https://gitlab.example.org/?x=1#y')).toBe('https://gitlab.example.org');
  });

  it('takes nothing but an http(s) URL', () => {
    for (const bad of [undefined, '', 'not a url', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'gitlab.example.org']) {
      expect(instanceBase(bad)).toBeNull();
    }
  });
});

describe('tokenPage', () => {
  it('fills in the scope where the host allows it', () => {
    expect(remoteDescriptor('github').tokenPage(undefined)).toBe('https://github.com/settings/tokens/new?scopes=repo&description=Aldine');
    expect(remoteDescriptor('gitlab').tokenPage(undefined)).toBe('https://gitlab.com/-/user_settings/personal_access_tokens?name=Aldine&scopes=api');
    expect(remoteDescriptor('gitlab').tokenPage('https://example.org/git')).toBe('https://example.org/git/-/user_settings/personal_access_tokens?name=Aldine&scopes=api');
  });

  it('has a page for a one-repository token only where the host has one apart', () => {
    expect(remoteDescriptor('github').repoTokenPage?.url).toBe('https://github.com/settings/personal-access-tokens/new');
    expect(remoteDescriptor('gitlab').repoTokenPage).toBeUndefined();
    expect(remoteDescriptor('gitea').repoTokenPage).toBeUndefined();
  });

  it('has no Gitea / Forgejo page without an instance', () => {
    expect(remoteDescriptor('gitea').tokenPage(undefined)).toBeNull();
    expect(remoteDescriptor('gitea').tokenPage('https://codeberg.org')).toBe('https://codeberg.org/user/settings/applications');
  });
});
