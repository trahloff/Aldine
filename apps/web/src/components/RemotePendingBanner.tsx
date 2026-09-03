import { useState } from 'react';
import { api, RemoteProviderId } from '../api';
import { REMOTES } from '../remotes';
import { useToast } from './Toast';

/**
 * Shown when auto-provisioning to a git host failed, so the project exists only
 * on this server. Non-blocking by design: the work is safe locally, and an
 * unreachable host must not get in the way of writing.
 */
export default function RemotePendingBanner({ projectId, provider, onLinked }: {
  projectId: string;
  provider: RemoteProviderId;
  onLinked(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const toast = useToast();
  const d = REMOTES[provider];

  if (dismissed) return null;

  const retry = async () => {
    setBusy(true);
    try {
      await api.remoteLink(projectId);
      toast(`Published to ${d.label}`, 'ok');
      onLinked();
    } catch (err: any) { toast(err.message, 'error'); }
    setBusy(false);
  };

  return (
    <div className="banner banner--warn" data-testid="remote-pending">
      <span>This project isn’t in {d.label} yet — it lives only on this server.</span>
      <button className="btn btn--small" onClick={retry} disabled={busy} data-testid="remote-pending-retry">
        {busy ? 'Retrying…' : 'Retry'}
      </button>
      <button className="btn btn--ghost btn--small" onClick={() => setDismissed(true)} data-testid="remote-pending-dismiss" aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
