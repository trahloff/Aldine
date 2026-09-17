import { useState } from 'react';
import { withBase } from '../basePath';
import { api, RemoteStatus } from '../api';
import { remoteDescriptor, RemoteProviderId } from '../remotes';
import { useToast } from './Toast';

/** Connect a git host with OAuth (when the server has it configured) or a
 *  token. Shared by the import and publish dialogs so both carry the same
 *  `<p>-token` / `<p>-connect` / `<p>-connect-oauth` / `<p>-baseurl` controls. */
export default function RemoteConnectForm({ provider, status, onConnected }: {
  provider: RemoteProviderId; status: RemoteStatus; onConnected(): void | Promise<void>;
}) {
  const d = remoteDescriptor(provider);
  const [token, setToken] = useState('');
  const [selfHosted, setSelfHosted] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const connect = async () => {
    if (!token.trim()) return;
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
          <a className="btn login__oauth" href={withBase(`/api/remotes/${provider}/oauth`)} data-testid={`${provider}-connect-oauth`}>{d.icon} Connect with {d.label}</a>
          <div className="login__or">or use a token</div>
        </>
      )}
      {d.selfHosted && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 8px', fontSize: 12.5, color: 'var(--text-2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={selfHosted} data-testid={`${provider}-selfhosted-toggle`} onChange={(e) => setSelfHosted(e.target.checked)} />
          Using a self-hosted {d.label}?
        </label>
      )}
      {d.selfHosted && selfHosted && (
        <input
          className="input login__input" type="url" placeholder="https://gitlab.example.org"
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
      <p style={{ color: 'var(--text-3)', fontSize: 11.5, marginTop: 8 }}>{d.tokenHelp}</p>
    </div>
  );
}
