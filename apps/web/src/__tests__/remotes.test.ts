import { describe, expect, it } from 'vitest';
import { instanceBase, pushSummary, remoteDescriptor } from '../remotes';

describe('instanceBase', () => {
  it('keeps origin and sub-path, without a trailing slash or API path', () => {
    expect(instanceBase('https://gitlab.example.org/')).toBe('https://gitlab.example.org');
    expect(instanceBase(' https://example.org/git/ ')).toBe('https://example.org/git');
    expect(instanceBase('https://gitlab.example.org/api/v4')).toBe('https://gitlab.example.org');
    expect(instanceBase('https://codeberg.org/api/v1/')).toBe('https://codeberg.org');
    expect(instanceBase('https://github.example.edu/api/v3')).toBe('https://github.example.edu');
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
    expect(remoteDescriptor('github').repoTokenPage?.page(undefined)).toBe('https://github.com/settings/personal-access-tokens/new');
    // GitHub Enterprise Server: the same pages on the instance
    expect(remoteDescriptor('github').tokenPage('https://github.example.edu')).toBe('https://github.example.edu/settings/tokens/new?scopes=repo&description=Aldine');
    expect(remoteDescriptor('github').repoTokenPage?.page('https://github.example.edu')).toBe('https://github.example.edu/settings/personal-access-tokens/new');
    expect(remoteDescriptor('gitlab').repoTokenPage).toBeUndefined();
    expect(remoteDescriptor('gitea').repoTokenPage).toBeUndefined();
  });

  it('has no Gitea / Forgejo page without an instance', () => {
    expect(remoteDescriptor('gitea').tokenPage(undefined)).toBeNull();
    expect(remoteDescriptor('gitea').tokenPage('https://codeberg.org')).toBe('https://codeberg.org/user/settings/applications');
  });
});

describe('pushSummary', () => {
  it('with every edit in a checkpoint, counts what goes and asks for no message', () => {
    expect(pushSummary({ pending: 0, ahead: 1 }, false, 'GitHub')).toBe('Pushes 1 saved checkpoint to GitHub.');
    expect(pushSummary({ pending: 0, ahead: 40 }, false, 'GitHub')).toBe('Pushes 40 saved checkpoints to GitHub.');
    expect(pushSummary({ pending: 0, ahead: 0 }, false, 'GitLab')).toBe('Nothing new to push: GitLab has every saved checkpoint.');
    expect(pushSummary({ pending: 0, ahead: null }, false, 'GitLab')).toBe('Pushes the saved checkpoints GitLab does not have yet.');
  });

  it('with edits waiting, says the message names only those', () => {
    expect(pushSummary({ pending: 2, ahead: 0 }, false, 'GitHub')).toBe('Your message names only the edits not yet saved as a checkpoint (2 files).');
    expect(pushSummary({ pending: 1, ahead: 1 }, false, 'GitHub')).toBe('Your message names only the edits not yet saved as a checkpoint (1 file). The saved checkpoint before them goes as it is.');
    expect(pushSummary({ pending: 1, ahead: 3 }, false, 'GitHub')).toBe('Your message names only the edits not yet saved as a checkpoint (1 file). The 3 saved checkpoints before them go as they are.');
  });

  it('on a project that commits by hand, speaks of commits', () => {
    expect(pushSummary({ pending: 0, ahead: 2 }, true, 'Gitea / Forgejo')).toBe('Pushes 2 commits to Gitea / Forgejo.');
    expect(pushSummary({ pending: 3, ahead: 1 }, true, 'GitHub')).toBe('Your message names the edits not yet committed (3 files). The commit before them goes as it is.');
    expect(pushSummary({ pending: 0, ahead: 0 }, true, 'GitHub')).toBe('Nothing new to push: GitHub has every commit.');
  });
});
