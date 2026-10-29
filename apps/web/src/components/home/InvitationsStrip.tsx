import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../Auth';
import { useDialogs } from '../Dialogs';
import { useToast } from '../Toast';
import type { MyInvitation } from '../../util/invites';

/** Invitations to the signed-in account's confirmed address or ORCID iD,
 *  answered in place. This is where an invitation reaches its person when
 *  the server sends no email: signing in with the invited address is enough. */
export default function InvitationsStrip({ onAccepted }: { onAccepted(): void }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const dialogs = useDialogs();
  const toast = useToast();
  const [items, setItems] = useState<MyInvitation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!user) { setItems([]); return; }
    let cancelled = false;
    api.myInvitations().then((list) => { if (!cancelled) setItems(list); }).catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [user?.id, user?.emailPending]);
  // Answered, withdrawn or expired elsewhere: the list says what is left.
  const reload = () => api.myInvitations().then(setItems).catch(() => {});

  if (!items.length) return null;
  const drop = (id: string) => setItems((cur) => cur.filter((i) => i.id !== id));

  const accept = async (inv: MyInvitation) => {
    setBusy(inv.id);
    try {
      const r = await api.acceptInvitation(inv.id);
      drop(inv.id);
      onAccepted();
      toast(`You joined “${inv.project.name}”`, 'ok', { label: 'Open', testId: 'home-invitation-open', onClick: () => navigate(`/p/${r.projectId}`) });
    } catch (err: any) {
      toast(err.message, 'error');
      reload();
    }
    setBusy(null);
  };
  const decline = async (inv: MyInvitation) => {
    const owner = inv.ownerName || 'The owner';
    if (!(await dialogs.confirm({ title: `Decline the invitation to “${inv.project.name}”?`, body: `You can’t accept it afterwards. ${owner} can invite you again.`, confirmLabel: 'Decline' }))) return;
    setBusy(inv.id);
    try {
      await api.declineInvitation(inv.id);
      drop(inv.id);
      toast(`Declined the invitation to “${inv.project.name}”`, 'ok');
    } catch (err: any) {
      toast(err.message, 'error');
      reload();
    }
    setBusy(null);
  };

  return (
    <section className="invites-strip" aria-labelledby="invites-strip-title" data-testid="home-invitations">
      <h2 id="invites-strip-title" className="invites-strip__title">{items.length === 1 ? 'Invitation' : `Invitations (${items.length})`}</h2>
      <ul role="list" className="invites-strip__list">
        {items.map((inv) => (
          <li key={inv.id} className="invites-strip__item" data-testid="home-invitation" data-project={inv.project.id}>
            <span className="invites-strip__text">
              <strong>{inv.ownerName || 'Someone'}</strong> invited you to <strong className="invites-strip__project">{inv.project.name}</strong>
            </span>
            <span className="invites-strip__actions">
              <button className="btn btn--small btn--ghost" onClick={() => decline(inv)} disabled={busy === inv.id} data-testid="home-invitation-decline">Decline</button>
              <button className="btn btn--small btn--primary" onClick={() => accept(inv)} disabled={busy === inv.id} data-testid="home-invitation-accept">Accept</button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
