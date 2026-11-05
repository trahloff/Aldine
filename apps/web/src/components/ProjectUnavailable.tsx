import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from './Auth';
import { useToast } from './Toast';
import Wordmark from './Wordmark';
import { useDocumentTitle } from '../util/documentTitle';
import type { MyInvitation } from '../util/invites';

export interface ProjectLoadError {
  /** 'denied': the server refused this account. 'signed-out': the session
   *  ended. 'unreachable': no answer, or a server error. */
  reason: 'denied' | 'signed-out' | 'unreachable';
  message: string;
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
}

/** In place of the editor when a project would not open: who is signed in
 *  and what they can do about it, or a way to try again. A refusal is not a
 *  missing project, and a server restart should not send anyone home. */
export default function ProjectUnavailable({ projectId, error, onRetry }: { projectId: string; error: ProjectLoadError; onRetry(): void }) {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [invite, setInvite] = useState<MyInvitation | null>(null);
  const [busy, setBusy] = useState(false);
  useDocumentTitle(error.reason === 'denied' ? 'No access' : error.reason === 'signed-out' ? 'Sign in again' : 'Could not open the project');

  // Each failed attempt is a new error: the buttons wake up again.
  useEffect(() => { setBusy(false); }, [error]);
  useEffect(() => {
    if (error.reason !== 'denied') return;
    api.myInvitations().then((list) => setInvite(list.find((i) => i.project.id === projectId) ?? null)).catch(() => setInvite(null));
  }, [error.reason, projectId]);

  const retry = () => { setBusy(true); onRetry(); };
  const accept = async () => {
    if (!invite) return;
    setBusy(true);
    try {
      await api.acceptInvitation(invite.id);
      onRetry();
    } catch (err: any) {
      toast(`Could not accept the invitation: ${err.message}`, 'error');
      setBusy(false);
    }
  };
  // Signed out, the app shows its sign-in form on this same page, and a
  // sign-in through an SSO provider comes back here (projectSignInStarts).
  const switchAccount = async () => { await api.logout().catch(() => {}); setUser(null); };
  const who = user?.email || user?.orcid || user?.name;

  return (
    <main className="login">
      {error.reason === 'denied' ? (
        <div className="login__card consent" data-testid="project-denied">
          <h1 className="home__brand"><Wordmark height={21} /></h1>
          <h2 className="consent__title invite__title">{invite ? `You’re invited to “${invite.project.name}”` : 'You don’t have access to this project'}</h2>
          <p className="consent__hint">
            {who && <>You’re signed in as <strong data-testid="project-denied-account">{who}</strong>. </>}
            {invite
              ? `${invite.ownerName || 'The owner'} invited ${invite.to}. Accept the invitation to open the project.`
              : 'Ask the owner to invite this account, or switch to the account they invited.'}
          </p>
          <div className="consent__actions invite__actions">
            <Link className="btn" to="/" data-testid="project-denied-back">Back to your projects</Link>
            {user && <button className={`btn${invite ? '' : ' btn--primary'}`} onClick={switchAccount} disabled={busy} data-testid="project-denied-switch">Switch account</button>}
            {invite && <button className="btn btn--primary" onClick={accept} disabled={busy} data-testid="project-denied-accept">Accept invitation</button>}
          </div>
        </div>
      ) : error.reason === 'signed-out' ? (
        <div className="login__card consent" data-testid="project-signed-out">
          <h1 className="home__brand"><Wordmark height={21} /></h1>
          <h2 className="consent__title invite__title">Your session has ended</h2>
          <p className="consent__hint">Sign in again to open this project. You come back to it afterwards.</p>
          <div className="consent__actions invite__actions">
            <button className="btn btn--primary" onClick={switchAccount} data-testid="project-signin">Sign in again</button>
          </div>
        </div>
      ) : (
        <div className="login__card consent" data-testid="project-unreachable">
          <h1 className="home__brand"><Wordmark height={21} /></h1>
          <h2 className="consent__title invite__title">Could not open the project</h2>
          <p className="consent__hint" data-testid="project-unreachable-reason">
            {error.status
              ? `The server had a problem (${error.message}). Try again in a moment.`
              : 'The server did not answer. Check your connection, then try again.'}
          </p>
          <div className="consent__actions invite__actions">
            <Link className="btn" to="/" data-testid="project-unreachable-back">Back to your projects</Link>
            <button className="btn btn--primary" onClick={retry} disabled={busy} data-testid="project-retry">{busy ? 'Trying…' : 'Try again'}</button>
          </div>
        </div>
      )}
    </main>
  );
}
