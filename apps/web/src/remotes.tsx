import type { ReactElement } from 'react';
import type { RemoteProviderId } from './api';

/**
 * Everything user-visible about a git host lives here, so no component
 * hardcodes a provider name. Adding a host means adding one entry.
 */

export const GH_ICON: ReactElement = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
);

export const GL_ICON: ReactElement = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}><path d="M8 15.2 5.03 6.06h5.94L8 15.2Zm-6.9-9.14h3.93L8 15.2 1.1 6.06Zm0 0L.06 9.28a.7.7 0 0 0 .26.79L8 15.2 1.1 6.06Zm0 0h3.93L3.7.86a.36.36 0 0 0-.68 0L1.1 6.06Zm13.8 0h-3.93L8 15.2l6.9-5.13a.7.7 0 0 0 .25-.79l-1.03-3.22Zm0 0h-3.93L12.3.86a.36.36 0 0 1 .68 0l1.92 5.2Z"/></svg>
);

export interface RemoteDescriptor {
  id: RemoteProviderId;
  label: string;
  icon: ReactElement;
  /** Noun for a proposed change, lowercase for mid-sentence use. */
  changeRequest: string;
  tokenPlaceholder: string;
  tokenHelp: string;
  /** Only GitLab can be self-hosted, so only GitLab shows an instance field. */
  selfHosted: boolean;
}

export const REMOTES: Record<RemoteProviderId, RemoteDescriptor> = {
  github: {
    id: 'github',
    label: 'GitHub',
    icon: GH_ICON,
    changeRequest: 'pull request',
    tokenPlaceholder: 'GitHub token (needs repo scope)',
    tokenHelp: 'Create one at github.com → Settings → Developer settings → Personal access tokens, with repo access.',
    selfHosted: false,
  },
  gitlab: {
    id: 'gitlab',
    label: 'GitLab',
    icon: GL_ICON,
    changeRequest: 'merge request',
    tokenPlaceholder: 'GitLab token (needs api scope)',
    tokenHelp: 'Create one at your GitLab → Preferences → Access tokens, with api scope.',
    selfHosted: true,
  },
};

/** Sentence-case a descriptor noun for use at the start of a label. */
export const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
