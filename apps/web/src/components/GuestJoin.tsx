import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type GuestInfo, type ShareRole } from '../api';
import Wordmark from './Wordmark';
import { useDocumentTitle } from '../util/documentTitle';
import { forgetShareLink } from '../util/shareLink';

/** What a guest may do, by the link's role. */
const GUEST_CAN: Record<ShareRole, string> = {
  edit: 'You can edit it with the others.',
  review: 'You can read it, comment on it and suggest changes.',
  view: 'You can read it.',
};

/**
 * In place of the sign-in form on a project page opened with a share link
 * `token`: a link that admits guests offers to join under a name, with
 * signing in as the other way; any other link shows `signIn` straight away.
 */
export default function GuestJoin({ projectId, token, signIn, onJoined }: { projectId: string; token: string; signIn: ReactNode; onJoined(guest: GuestInfo): void }) {
  const [offer, setOffer] = useState<{ project: string; role: ShareRole; label?: string } | null | undefined>(undefined);
  const [wantsSignIn, setWantsSignIn] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useDocumentTitle(offer ? `Join “${offer.project}”` : 'Sign in');

  useEffect(() => {
    let live = true;
    api.peekShareLink(projectId, token).then(
      (r) => { if (!live) return; setOffer(r.guests ? r : null); if (r.label) setName(r.label); },
      () => { if (live) setOffer(null); },
    );
    return () => { live = false; };
  }, [projectId, token]);

  if (offer === undefined) return <div style={{ height: '100%' }} />;
  if (offer === null || wantsSignIn) return <>{signIn}</>;

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) { setError('Enter the name the others see you by.'); return; }
    setBusy(true);
    setError('');
    try {
      const r = await api.joinAsGuest(projectId, token, name.trim());
      forgetShareLink(projectId);
      onJoined(r.guest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429 && err.code !== 'name') forgetShareLink(projectId);
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login__card consent" data-testid="guest-join">
        <h1 className="home__brand"><Wordmark height={21} /></h1>
        <h2 className="consent__title invite__title">You’re invited to “{offer.project}”</h2>
        <p className="consent__hint">{GUEST_CAN[offer.role]} No account needed: join as a guest under your name, which the others see on your cursor, your comments and your commits. Guests see the PDF the others typeset and cannot typeset it themselves.</p>
        <form onSubmit={join}>
          <label className="modal__sub" htmlFor="guest-name" style={{ display: 'block', margin: '0 0 4px' }}>Your name</label>
          <input id="guest-name" className="input" value={name} maxLength={60} autoFocus autoComplete="name" onChange={(e) => setName(e.target.value)} data-testid="guest-name" />
          {error && <p className="login__error" role="alert" data-testid="guest-join-error">{error}</p>}
          <div className="consent__actions invite__actions">
            <button type="button" className="btn" onClick={() => setWantsSignIn(true)} data-testid="guest-sign-in">Sign in instead</button>
            <button type="submit" className="btn btn--primary" disabled={busy} data-testid="guest-join-submit">{busy ? 'Joining…' : 'Join as guest'}</button>
          </div>
        </form>
      </div>
    </main>
  );
}
