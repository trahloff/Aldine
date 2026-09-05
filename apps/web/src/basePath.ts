/**
 * The URL path this instance is served under ('' at the root,
 * '/internal/aldine' for https://host/internal/aldine/). The server stamps it
 * into index.html; the Vite dev server has no tag, so it is ''. Every
 * root-relative URL the app builds — API, websocket, plugin assets, share
 * links — goes through withBase() so the same build works at any depth.
 */
function readBasePath(): string {
  if (typeof document === 'undefined') return '';
  const meta = document.querySelector('meta[name="aldine-base-path"]') as HTMLMetaElement | null;
  const raw = (meta?.content || '').trim().replace(/\/+$/, '');
  return raw && raw !== '/' ? raw : '';
}

export const BASE_PATH: string = readBasePath();

/** Prefix a root-relative path ('/api/…') with the base path. */
export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}

/** Websocket URL for a root-relative path, on this page's host and scheme. */
export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${withBase(path)}`;
}
