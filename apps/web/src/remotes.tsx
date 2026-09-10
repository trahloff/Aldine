import type { ReactElement } from 'react';
import type { RemoteProviderId } from './api';

export type { RemoteProviderId } from './api';

/** What the UI needs to know about a git host. Every user-visible string in
 *  the remote dialogs comes from here, so a GitLab project never reads
 *  "pull request". The server's own list (`api.remotes()`) decides which of
 *  these are offered. */
export interface RemoteDescriptor {
  id: RemoteProviderId;
  label: string;
  icon: ReactElement;
  changeRequest: 'pull request' | 'merge request';
  tokenPlaceholder: string;
  /** Where to create a token, and which scope it needs. */
  tokenHelp: string;
  /** The host can be self-hosted, so connecting may take a base URL. */
  selfHosted: boolean;
  defaultBaseUrl: string;
}

const GITHUB_ICON = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }} aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
);

const GITLAB_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }} aria-hidden="true"><path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 5.45H7.582L4.919 1.263a.455.455 0 0 0-.867 0L1.386 9.452.044 13.587a.924.924 0 0 0 .331 1.023L12 23.054l11.625-8.443a.92.92 0 0 0 .33-1.024"/></svg>
);

export const REMOTES: Record<RemoteProviderId, RemoteDescriptor> = {
  github: {
    id: 'github',
    label: 'GitHub',
    icon: GITHUB_ICON,
    changeRequest: 'pull request',
    tokenPlaceholder: 'GitHub token (needs repo scope)',
    tokenHelp: 'Create one at github.com → Settings → Developer settings → Personal access tokens, with repo access.',
    selfHosted: false,
    defaultBaseUrl: 'https://github.com',
  },
  gitlab: {
    id: 'gitlab',
    label: 'GitLab',
    icon: GITLAB_ICON,
    changeRequest: 'merge request',
    tokenPlaceholder: 'GitLab token (needs api scope)',
    tokenHelp: 'Create one on your GitLab under Settings → Access tokens, with the api scope.',
    selfHosted: true,
    defaultBaseUrl: 'https://gitlab.com',
  },
};

export const REMOTE_IDS = Object.keys(REMOTES) as RemoteProviderId[];

export function isRemoteProviderId(v: unknown): v is RemoteProviderId {
  return typeof v === 'string' && v in REMOTES;
}

export function remoteDescriptor(id: RemoteProviderId): RemoteDescriptor {
  return REMOTES[id];
}

/** "merge request" → "Merge request", for the start of a sentence-case string. */
export function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
