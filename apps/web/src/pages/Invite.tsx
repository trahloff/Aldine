import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { LoginScreen, useAuth } from '../components/Auth';
import EmailConfirmBanner from '../components/EmailConfirmBanner';
import { useDialogs } from '../components/Dialogs';
import Wordmark from '../components/Wordmark';
import { useDocumentTitle } from '../util/documentTitle';
import { forgetInviteResume, isOrcidEntry, type InvitationView } from '../util/invites';
import { inviteSignInStarts } from '../util/signInStart';

type Loaded = { status: 'loading' } | { status: 'missing'; message: string } | { status: 'ok'; view: InvitationView };

/**
 * /invite/:id — one invitation, answered by the person it is for. The link
 * is not a credential: the server names the project only to the account
 * whose confirmed address (or ORCID iD) was invited, and accepts only from
 * it. Everyone else learns who the invitation is for and from whom.
 */
export default function Invite() {
  const { id = '' } = useParams();
  const { authEnabled, user, setUser } = useAuth();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  useDocumentTitle('Invitation');

  const load = useCallback(() => {
    api.invitation(id).then(
      (view) => setLoaded({ status: 'ok', view }),
      (err: unknown) => setLoaded({ status: 'missing', message: err instanceof ApiError && err.status === 404 ? err.message : 'Could not load the invitation. Reload the page to try again.' }),
    );
  }, [id]);
  useEffect(() => { load(); }, [load, user?.id, user?.emailPending]);
  // Signed in here: an SSO return must not bring anyone back to this page later.
  useEffect(() => { if (user) forgetInviteResume(); }, [user]);

  if (!authEnabled) return <Card title="Invitations need accounts" testId="invite-missing"><p className="consent__hint">This server runs without sign-in, so every project is open to everyone who can reach it.</p><BackLink /></Card>;
  if (loaded.status === 'loading') return <div className="login"><div className="spinner" /></div>;
  if (loaded.status === 'missing') return <Card title="This invitation can’t be found" testId="invite-missing"><p className="consent__hint">{loaded.message}</p><BackLink /></Card>;

  const view = loaded.view;
  const owner = view.ownerName || 'The owner';
  const orcid = isOrcidEntry(view.to);
  const closedText = {
    expired: `This invitation expired. Ask ${owner} to send a new one.`,
    withdrawn: `${owner} withdrew this invitation.`,
    declined: `This invitation was declined. ${owner} can send a new one.`,
  } as const;
  if (view.state === 'expired' || view.state === 'withdrawn' || view.state === 'declined') {
    return <Card title="This invitation is closed" testId={`invite-${view.state}`}><p className="consent__hint">{closedText[view.state]}</p><BackLink /></Card>;
  }
  if (view.state === 'accepted') {
    return view.relation === 'match' && view.member && view.project ? (
      <Card title={`You’re a collaborator on “${view.project.name}”`} testId="invite-accepted">
        <p className="consent__hint">You accepted this invitation already.</p>
        <div className="consent__actions invite__actions"><Link className="btn btn--primary" to={`/p/${view.project.id}`} data-testid="invite-open">Open the project</Link></div>
      </Card>
    ) : (
      <Card title="This invitation was used" testId="invite-used"><p className="consent__hint">{`It was accepted already. If you need access, ask ${owner} to invite you again.`}</p><BackLink /></Card>
    );
  }

  if (view.relation === 'signed-out') return <SignInStep view={view} onAuthed={setUser} />;
  if (view.relation === 'unconfirmed') {
    return (
      <Card title="Confirm your email address first" testId="invite-unconfirmed">
        <p className="consent__hint">{`${owner} invited ${view.to}. That is your address, but it isn’t confirmed yet. Open the confirmation link, then come back to this page or to your projects: the invitation waits there.`}</p>
        <EmailConfirmBanner />
        <BackLink />
      </Card>
    );
  }
  if (view.relation === 'other') {
    const switchAccount = async () => { await api.logout().catch(() => {}); setUser(null); };
    return (
      <Card title="This invitation is for someone else" testId="invite-mismatch">
        <p className="consent__hint">
          This invitation is for <strong data-testid="invite-to">{view.to}</strong>. You’re signed in as <strong data-testid="invite-signed-in-as">{view.signedInAs}</strong>.{' '}
          {orcid ? `Sign in with ORCID as ${view.to}` : `Sign in with ${view.to}`}, or ask {owner} to invite {view.signedInAs}.
        </p>
        <div className="consent__actions invite__actions">
          <Link className="btn" to="/" data-testid="invite-back">Back to your projects</Link>
          <button className="btn btn--primary" onClick={switchAccount} data-testid="invite-switch-account">Switch account</button>
        </div>
      </Card>
    );
  }
  return <AnswerStep view={view} />;
}

function Card({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <main className="login">
      <div className="login__card consent" data-testid={testId}>
        <h1 className="home__brand"><Wordmark height={21} /></h1>
        <h2 className="consent__title invite__title">{title}</h2>
        {children}
      </div>
    </main>
  );
}

function BackLink() {
  return <Link className="btn consent__back" to="/" data-testid="invite-back">Back to your projects</Link>;
}

function SignInStep({ view, onAuthed }: { view: InvitationView; onAuthed: Parameters<typeof LoginScreen>[0]['onAuthed'] }) {
  const { providers, passwordAuth, signupApproval } = useAuth();
  const owner = view.ownerName || 'Someone';
  const orcid = isOrcidEntry(view.to);
  return (
    <LoginScreen
      providers={providers}
      passwordAuth={passwordAuth}
      signupApproval={signupApproval}
      onAuthed={onAuthed}
      // An SSO provider's callback lands on "/", and Home brings the person
      // back here: only for a sign-in started here, and not long after.
      onStart={() => inviteSignInStarts(view.id)}
      heading={orcid ? 'Sign in with ORCID to answer the invitation.' : 'Sign in to answer the invitation.'}
      registerHeading="Create an account to answer the invitation."
      notice={orcid
        ? `${owner} invited the ORCID iD ${view.to} to a project. Sign in with that ORCID iD to see it.`
        : `${owner} invited ${view.to} to a project. Sign in or create an account with that address to see it.`}
      initialEmail={orcid ? undefined : view.to}
    />
  );
}

function AnswerStep({ view }: { view: InvitationView }) {
  const navigate = useNavigate();
  const dialogs = useDialogs();
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const owner = view.ownerName || 'The owner';
  const name = view.project?.name ?? 'a project';

  const accept = async () => {
    setBusy('accept');
    setError(null);
    try {
      const r = await api.acceptInvitation(view.id);
      navigate(`/p/${r.projectId}`, { replace: true });
    } catch (err: any) {
      setError(err.message);
      setBusy(null);
    }
  };
  const decline = async () => {
    if (!(await dialogs.confirm({ title: `Decline the invitation to “${name}”?`, body: `You can’t accept it afterwards. ${owner} can invite you again.`, confirmLabel: 'Decline' }))) return;
    setBusy('decline');
    setError(null);
    try {
      await api.declineInvitation(view.id);
      setDeclined(true);
    } catch (err: any) {
      setError(err.message);
    }
    setBusy(null);
  };

  if (declined) {
    return <Card title="Invitation declined" testId="invite-declined-now"><p className="consent__hint">{`${owner} sees that you declined. Nothing else changes.`}</p><BackLink /></Card>;
  }
  return (
    <Card title={`${owner} invited you to “${name}”`} testId="invite-pending">
      <p className="consent__what">Accept to open and edit this LaTeX project. It joins your project list, and you can take it off the list again at any time.</p>
      <p className="consent__hint">Invited: <strong>{view.to}</strong></p>
      {error && <p className="consent__error" role="alert" data-testid="invite-error">{error}</p>}
      <div className="consent__actions invite__actions">
        <button className="btn" onClick={decline} disabled={busy !== null} data-testid="invite-decline">{busy === 'decline' ? 'Declining…' : 'Decline'}</button>
        <button className="btn btn--primary" onClick={accept} disabled={busy !== null} aria-busy={busy === 'accept' || undefined} data-testid="invite-accept">{busy === 'accept' ? 'Accepting…' : 'Accept'}</button>
      </div>
    </Card>
  );
}
