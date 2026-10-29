import { useEffect, useRef, useState } from 'react';
import { withBase } from '../basePath';
import { api, ProjectSummary } from '../api';
import { useToast } from './Toast';
import { useAuth } from './Auth';
import Modal from './Modal';
import { addedEntries, invitationStatus, inviteSummary, isOrcidEntry, type InviteReport, type OwnerInvitation } from '../util/invites';

/** Mirrors the server's collaborator filter (the share route) so an address it
 *  would silently discard is reported here instead of vanishing on save. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// An ORCID iD invites a researcher who signed in with ORCID and has no public email.
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dXx]$/;
const MAX_COLLABORATORS = 50;

/** Who may open the project (the owner's call, and only with sign-in) and,
 *  from the editor, the PDF and the source as files, which everyone gets.
 *  With accounts on, an address or iD added here is invited: it joins the
 *  list when its person accepts. */
export default function ShareModal({ project, canManage = true, downloads, onClose, onSaved }: {
  project: Pick<ProjectSummary, 'id' | 'name' | 'share'>;
  canManage?: boolean;
  /** The branch the source download archives, and the PDF on screen (null
   *  until a typeset succeeds). */
  downloads?: { branch: string; pdfUrl: string | null };
  onClose(): void;
  onSaved(updated: ProjectSummary): void;
}) {
  const { authEnabled } = useAuth();
  const [mode, setMode] = useState<'private' | 'link'>(project.share?.mode || 'private');
  const [emails, setEmails] = useState((project.share?.collaborators || []).join(', '));
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<OwnerInvitation[]>([]);
  // After a save that invited someone the dialog stays open to say who got
  // mail and to offer the links; the caller hears of the save when it
  // closes, however it closes.
  const [result, setResult] = useState<{ updated: ProjectSummary; sent: string | null; manual: string | null } | null>(null);
  const close = () => (result ? onSaved(result.updated) : onClose());
  const toast = useToast();
  const shareUrl = `${location.origin}${withBase(`/p/${project.id}`)}`;
  const fileStem = (project.name || 'document').replace(/[\\/:*?"<>|]/g, '-');
  const invitations = canManage && authEnabled;

  // Accepting adds people to the list while the page that opened this
  // dialog still holds the old one: start from the server's, unless the
  // owner has begun typing.
  const edited = useRef(false);
  const [base, setBase] = useState(project.share?.collaborators || []);
  useEffect(() => {
    if (!invitations) return;
    api.projectInvitations(project.id).then(setInvites).catch(() => setInvites([]));
    api.getProject(project.id).then((p) => {
      if (edited.current || !p.share) return;
      setBase(p.share.collaborators);
      setEmails(p.share.collaborators.join(', '));
    }).catch(() => {});
  }, [invitations, project.id]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast('Link copied', 'ok');
    } catch {
      toast('Could not copy the link — select it and copy manually', 'error');
    }
  };

  const save = async () => {
    // Separators people actually paste: commas, semicolons, newlines.
    const list = emails.split(/[,;\n]/).map((e) => e.trim()).filter(Boolean);
    const bad = list.filter((e) => !EMAIL_RE.test(e) && !ORCID_RE.test(e));
    if (bad.length) { toast(`Not an email address or ORCID iD: ${bad.join(', ')}`, 'error'); return; }
    if (list.length > MAX_COLLABORATORS) {
      toast(`Too many collaborators — ${MAX_COLLABORATORS} is the maximum, you listed ${list.length}`, 'error');
      return;
    }
    setBusy(true);
    try {
      const open = new Set(invites.filter((i) => i.state === 'pending').map((i) => i.to));
      const updated = await api.share(project.id, mode, list, base);
      if (updated.invitations) setInvites(updated.invitations);
      const added = addedEntries(base, list).filter((c) => !open.has(c));
      if (added.length === 0) {
        toast('Sharing updated', 'ok');
        onSaved(updated);
        return;
      }
      setResult({ updated, ...inviteSummary(added, updated) });
    } catch (err: any) {
      toast(`Could not update sharing: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const list = invitations && invites.length > 0 && (
    <InvitationList projectId={project.id} invites={invites} onChange={setInvites} />
  );

  return (
    <Modal onClose={close} label={`Share ${project.name}`} testId="share-modal">
      <div>
        <h2>Share “{project.name}”</h2>
        {result ? (
          <div data-testid="share-invite-result">
            <p className="modal__sub">Sharing updated.</p>
            {result.sent && <p data-testid="share-invite-sent">{result.sent}</p>}
            {result.manual && <p data-testid="share-invite-manual">{result.manual}</p>}
            {list}
          </div>
        ) : canManage ? (
          <>
            <p className="modal__sub">Choose who can open and edit this project.</p>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input type="radio" name="share-mode" checked={mode === 'private'} onChange={() => setMode('private')} data-testid="share-private" />
              <span><strong>Invite only</strong> — you and the collaborators below</span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <input type="radio" name="share-mode" checked={mode === 'link'} onChange={() => setMode('link')} data-testid="share-link" />
              <span><strong>Anyone signed in with the link</strong> can edit — once they open it, it stays in their project list until they remove it</span>
            </label>
            {mode === 'link' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                <code data-testid="share-url" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--text-s)' }}>{shareUrl}</code>
                <button className="btn btn--small" style={{ flexShrink: 0, marginLeft: 'auto' }} onClick={copyLink} data-testid="share-copy-link">Copy link</button>
              </div>
            )}
            <label htmlFor="share-emails" className="modal__sub" style={{ display: 'block', margin: '0 0 4px' }}>Collaborator emails or ORCID iDs, comma-separated</label>
            <input
              id="share-emails"
              className="input"
              placeholder="ada@example.edu, grace@example.edu"
              value={emails}
              data-testid="share-emails"
              aria-describedby={authEnabled ? 'share-emails-hint' : undefined}
              onChange={(e) => { edited.current = true; setEmails(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            />
            {authEnabled && <p className="settings__hint" id="share-emails-hint">Someone new gets an invitation, and has access once they accept it.</p>}
            {list}
          </>
        ) : (
          <p className="modal__sub">Download the typeset PDF or the whole source.</p>
        )}

        {downloads && !result && (
          <section className="share__downloads" data-testid="share-downloads">
            <div className="menu__label share__label">Download</div>
            <div className="share__buttons">
              {downloads.pdfUrl ? (
                <a className="btn" href={downloads.pdfUrl} download={`${fileStem}.pdf`} title="Download the compiled PDF" data-testid="download-pdf">PDF</a>
              ) : (
                <button className="btn" disabled title="Typeset the document first" data-testid="download-pdf">PDF</button>
              )}
              <a className="btn" href={api.archiveUrl(project.id, downloads.branch)} download data-testid="download-zip">Source as ZIP</a>
            </div>
            <p className="settings__hint">The ZIP holds every file on {downloads.branch}; it imports back into Aldine, or into Overleaf.</p>
          </section>
        )}

        <div className="modal__row">
          {result ? (
            <button className="btn btn--primary" onClick={close} data-testid="share-done">Done</button>
          ) : canManage ? (
            <>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn--primary" onClick={save} disabled={busy} data-testid="share-save">Save</button>
            </>
          ) : (
            <button className="btn" onClick={onClose} data-testid="share-close">Close</button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** The project's open, declined and expired invitations, each with what the
 *  owner can do about it. The link works only for the person invited, so it
 *  is safe to send any way the owner likes. */
function InvitationList({ projectId, invites, onChange }: { projectId: string; invites: OwnerInvitation[]; onChange(list: OwnerInvitation[]): void }) {
  const { sendsEmail } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  // Shown after a copy that failed (no clipboard on a plain-http address).
  const [shown, setShown] = useState<string | null>(null);

  const run = async (inv: OwnerInvitation, work: () => Promise<{ invitations: OwnerInvitation[] } & InviteReport>, done: (r: InviteReport) => string) => {
    setBusy(inv.id);
    try {
      const r = await work();
      onChange(r.invitations);
      toast(done(r), 'ok');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const copy = async (inv: OwnerInvitation) => {
    try {
      await navigator.clipboard.writeText(inv.link);
      setShown(null);
      toast(`Invite link for ${inv.to} copied. It works only for them.`, 'ok');
    } catch {
      setShown(inv.id);
      toast('Could not copy the link: select it below and copy it yourself', 'error');
    }
  };
  const mailed = (r: InviteReport, to: string, what: string) => (r.invited ? `${what} emailed to ${to}` : `${what} ready: copy the invite link and send it to ${to} yourself`);

  return (
    <section className="share__invites" aria-labelledby="share-invites-label" data-testid="share-invitations">
      <div className="menu__label share__label" id="share-invites-label">Invitations</div>
      <ul role="list" className="share__invite-list">
        {invites.map((inv) => (
          <li key={inv.id} className="share__invite" data-testid="invite-row" data-to={inv.to}>
            <div className="share__invite-line">
              <span className="share__invite-to">{inv.to}</span>
              <span className={`share__invite-state share__invite-state--${inv.state}`} data-testid="invite-state">{invitationStatus(inv)}</span>
            </div>
            <div className="share__invite-actions">
              {inv.state === 'pending' ? (
                <>
                  <button className="btn btn--small" onClick={() => copy(inv)} data-testid="invite-copy">Copy invite link</button>
                  {sendsEmail && !isOrcidEntry(inv.to) && (
                    <button className="btn btn--small" disabled={busy === inv.id} data-testid="invite-resend"
                      onClick={() => run(inv, () => api.resendInvitation(projectId, inv.id), (r) => mailed(r, inv.to, 'Invitation'))}>Resend</button>
                  )}
                  <button className="btn btn--small btn--ghost" disabled={busy === inv.id} data-testid="invite-withdraw"
                    onClick={() => run(inv, () => api.withdrawInvitation(projectId, inv.id), () => `Withdrew the invitation to ${inv.to}`)}>Withdraw</button>
                </>
              ) : (
                <>
                  <button className="btn btn--small" disabled={busy === inv.id} data-testid="invite-again"
                    onClick={() => run(inv, () => api.invite(projectId, inv.to), (r) => mailed(r, inv.to, 'New invitation'))}>Invite again</button>
                  <button className="btn btn--small btn--ghost" disabled={busy === inv.id} data-testid="invite-remove"
                    onClick={() => run(inv, () => api.withdrawInvitation(projectId, inv.id), () => `Removed ${inv.to} from the invitations`)}>Remove</button>
                </>
              )}
            </div>
            {shown === inv.id && <LinkField link={inv.link} to={inv.to} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The link, selected for copying by hand. */
function LinkField({ link, to }: { link: string; to: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return <input ref={ref} className="input share__invite-link" readOnly value={link} aria-label={`Invite link for ${to}`} data-testid="invite-link" />;
}
