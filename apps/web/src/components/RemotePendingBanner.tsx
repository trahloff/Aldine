import { useState } from 'react';
import { api } from '../api';
import { useToast } from './Toast';

const dismissKey = (id: string) => `aldine.remotePendingDismissed.${id}`;

/** Owner's notice that provisioning failed when the project was created:
 *  retry re-runs it into the same group; dismiss hides it for this tab
 *  session only, since the project stays local until a retry succeeds. */
export default function RemotePendingBanner({ projectId, namespace, onProvisioned }: { projectId: string; namespace: string; onProvisioned(): unknown }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(dismissKey(projectId)) === '1'; } catch { return false; }
  });
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  if (dismissed) return null;

  const retry = async () => {
    setBusy(true);
    try {
      const r = await api.remoteRetryProvision(projectId);
      toast(`Created on GitLab in ${r.remote.owner}`, 'ok');
      await onProvisioned();
    } catch (err: any) {
      toast(err.message, 'error');
    }
    setBusy(false);
  };
  const dismiss = () => {
    try { sessionStorage.setItem(dismissKey(projectId), '1'); } catch { /* private mode */ }
    setDismissed(true);
  };

  return (
    <div className="remote-pending" role="status" data-testid="remote-pending">
      <span className="remote-pending__text">This project is not on GitLab yet ({namespace}). GitLab was unreachable when it was created.</span>
      <button className="btn btn--small btn--primary" onClick={retry} disabled={busy} data-testid="remote-pending-retry">{busy ? 'Creating…' : 'Create on GitLab'}</button>
      <button className="btn btn--small btn--ghost" onClick={dismiss} disabled={busy} data-testid="remote-pending-dismiss" title="Hide this until the next visit">Not now</button>
    </div>
  );
}
