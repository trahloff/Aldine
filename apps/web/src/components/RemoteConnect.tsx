import { useState } from 'react';
import { withBase } from '../basePath';
import { api, RemoteStatus } from '../api';
import { instanceBase, remoteDescriptor, RemoteProviderId } from '../remotes';
import { useToast } from './Toast';

/** Connect a git host with OAuth (when the server has it configured) or a
 *  token. Shared by the import and publish dialogs so both carry the same
 *  `<p>-token` / `<p>-connect` / `<p>-connect-oauth` / `<p>-baseurl` controls.
 *  `returnTo` is the page OAuth comes back to (a project's `/p/<id>`); without
 *  it the host's callback opens the import dialog on Home. `reopen` names the
 *  dialog that page opens again on the way back. */
export default function RemoteConnectForm({ provider, status, onConnected, returnTo, reopen }: {
  provider: RemoteProviderId; status: RemoteStatus; onConnected(): void | Promise<void>; returnTo?: string; reopen?: 'publish' | 'access';
}) {
  const d = remoteDescriptor(provider);
  const [token, setToken] = useState('');
  // A host without a canonical instance (Gitea / Forgejo) always takes a URL; the others offer it behind a toggle.
  const [selfHosted, setSelfHosted] = useState(d.baseUrlRequired);
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const connect = async () => {
    if (!token.trim()) return;
    if (d.baseUrlRequired && !baseUrl.trim()) { toast(`Enter the ${d.label} instance URL, ${d.baseUrlPlaceholder} for example`, 'error'); return; }
    setBusy(true);
    try {
      await api.remoteConnect(provider, token.trim(), selfHosted && baseUrl.trim() ? baseUrl.trim() : undefined);
      setToken('');
      await onConnected();
    } catch (err: any) { toast(err.message, 'error'); }
    setBusy(false);
  };

  return (
    <div>
      {status.oauth && (
        <>
          <a className="btn login__oauth" href={withBase(`/api/remotes/${provider}/oauth${returnTo ? `?return=${encodeURIComponent(returnTo)}${reopen ? `&reopen=${reopen}` : ''}` : ''}`)} data-testid={`${provider}-connect-oauth`}>{d.icon} Connect with {d.label}</a>
          <div className="login__or">or use a token</div>
        </>
      )}
      {d.selfHosted && !d.baseUrlRequired && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 8px', fontSize: 'var(--text-s)', color: 'var(--text-2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={selfHosted} data-testid={`${provider}-selfhosted-toggle`} onChange={(e) => setSelfHosted(e.target.checked)} />
          {d.selfHostedQuestion ?? `Using a self-hosted ${d.label}?`}
        </label>
      )}
      {d.selfHosted && selfHosted && (
        <input
          className="input login__input" type="url" placeholder={d.baseUrlPlaceholder} aria-label={`${d.label} instance URL`}
          value={baseUrl} data-testid={`${provider}-baseurl`} onChange={(e) => setBaseUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && connect()}
        />
      )}
      <input
        className="input login__input" type="password" placeholder={d.tokenPlaceholder}
        value={token} data-testid={`${provider}-token`} onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && connect()}
      />
      <button className="btn btn--primary" style={{ width: '100%', justifyContent: 'center' }} onClick={connect} disabled={busy} data-testid={`${provider}-connect`}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
      <TokenHelp provider={provider} base={selfHosted ? baseUrl : undefined} instanceUrl={status.instanceUrl} testId={`${provider}-token-page`} />
    </div>
  );
}

/** "Create a token on <host>", linked to the host's new-token page on the
 *  instance the token will be sent to: `base` when it is a URL, else the
 *  server's default `instanceUrl`. The menu path when there is no page.
 *  `oneRepo` prefers the host's page for a token limited to one repository. */
export function TokenHelp({ provider, base, instanceUrl, testId, oneRepo }: {
  provider: RemoteProviderId; base?: string; instanceUrl?: string; testId: string; oneRepo?: boolean;
}) {
  const d = remoteDescriptor(provider);
  const repoPage = oneRepo ? d.repoTokenPage : undefined;
  const at = instanceBase(base) ?? instanceBase(instanceUrl) ?? undefined;
  const page = repoPage ? repoPage.page(at) : d.tokenPage(at);
  return (
    <p style={{ color: 'var(--text-3)', fontSize: 'var(--text-s)', marginTop: 8 }}>
      {page
        ? <><a href={page} target="_blank" rel="noopener noreferrer" data-testid={testId}>Create a token on {new URL(page).host}</a>{repoPage?.note ?? d.tokenPageNote}</>
        : d.tokenHelp}
    </p>
  );
}
