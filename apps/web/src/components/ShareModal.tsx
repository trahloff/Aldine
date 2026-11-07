import { useEffect, useRef, useState } from 'react';
import { withBase } from '../basePath';
import { api, ProjectSummary, type ShareRole } from '../api';
import { useToast } from './Toast';
import { useAuth } from './Auth';
import Modal from './Modal';
import { useDialogs } from './Dialogs';
import { addedEntries, invitationStatus, inviteSummary, isOrcidEntry, type InviteReport, type OwnerInvitation } from '../util/invites';
import { outputSibling, type OutputFile } from '../util/outputFiles';

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
  const invitations = canManage && authEnabled;
  // With invitations the field only adds people, and who has access is the
  // list below it. Without accounts the field is the whole list.
  const [emails, setEmails] = useState(invitations ? '' : (project.share?.collaborators || []).join(', '));
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<OwnerInvitation[]>([]);
  // After a save that invited someone the dialog stays open to say who got
  // mail and to offer the links; the caller hears of the save when it
  // closes, however it closes. A removal and a change of mode apply at once
  // and are heard of the same way.
  const [result, setResult] = useState<{ updated: ProjectSummary; sent: string | null; manual: string | null } | null>(null);
  const [applied, setApplied] = useState<ProjectSummary | null>(null);
  const toast = useToast();
  const dialogs = useDialogs();
  const shareUrl = `${location.origin}${withBase(`/p/${project.id}`)}`;
  const fileStem = (project.name || 'document').replace(/[\\/:*?"<>|]/g, '-');
  const outputs = useOutputFiles(downloads?.pdfUrl ?? null);
  const bbl = outputs.find((f) => f.name.endsWith('.bbl'));

  // Accepting adds people to the list while the page that opened this
  // dialog still holds the old one: start from the server's.
  const [base, setBase] = useState(project.share?.collaborators || []);
  const [savedMode, setSavedMode] = useState(project.share?.mode || 'private');
  // Roles: the entries that can only view, what the link allows, and the
  // role the people typed into the field get.
  const [viewers, setViewers] = useState(project.share?.viewers || []);
  const [linkRole, setLinkRole] = useState<ShareRole>(project.share?.linkRole || 'edit');
  const [inviteRole, setInviteRole] = useState<ShareRole>('edit');
  // A change made here is newer than the server's answer to the fetches
  // below: one to the share for the project's, one to an invitation for the list's.
  const changed = useRef(false);
  const invitesChanged = useRef(false);
  const changeInvites = (list: OwnerInvitation[]) => { invitesChanged.current = true; setInvites(list); };
  // The mode a radio click is applying; the link is offered only once the
  // server has it, so a copied link always opens.
  const [switching, setSwitching] = useState<'private' | 'link' | null>(null);
  const mode = switching ?? savedMode;
  useEffect(() => {
    if (!invitations) return;
    api.projectInvitations(project.id)
      .then((list) => { if (!invitesChanged.current) setInvites(list); })
      .catch(() => { if (!invitesChanged.current) setInvites([]); });
    api.getProject(project.id).then((p) => {
      if (!p.share || changed.current) return;
      setBase(p.share.collaborators);
      setSavedMode(p.share.mode);
      setViewers(p.share.viewers || []);
      setLinkRole(p.share.linkRole || 'edit');
    }).catch(() => {});
  }, [invitations, project.id]);

  const typedEntries = () => emails.split(/[,;\n]/).map((e) => e.trim()).filter(Boolean);
  // The mode applies on click; only the address field waits for Save.
  const unsaved = () => (invitations ? typedEntries().length > 0 : typedEntries().join(',') !== base.join(','));
  const finish = () => (result ? onSaved(result.updated) : applied ? onSaved(applied) : onClose());
  const close = async () => {
    if (!result && canManage && unsaved()) {
      const ok = await dialogs.confirm({
        title: invitations ? 'Close without inviting?' : 'Close without saving?',
        body: invitations
          ? 'The addresses you typed have not been invited. To invite them, go back and press Save.'
          : 'The collaborator list you typed has not been saved. To keep it, go back and press Save.',
        confirmLabel: 'Discard and close',
      });
      if (!ok) return;
    }
    finish();
  };

  const switchMode = async (next: 'private' | 'link') => {
    if (next === savedMode || switching) return;
    changed.current = true;
    setSwitching(next);
    try {
      const updated = await api.shareMode(project.id, next);
      setSavedMode(updated.share?.mode || next);
      setApplied(updated);
      toast(next === 'link'
        ? `Link sharing on: anyone signed in with the link can ${updated.share?.linkRole === 'view' ? 'view' : 'edit'}`
        : 'Link sharing off: only you and your collaborators can open the project', 'ok');
    } catch (err: any) {
      toast(`Could not change link sharing: ${err.message}`, 'error');
    } finally {
      setSwitching(null);
    }
  };

  const changeLinkRole = async (next: ShareRole) => {
    if (next === linkRole || switching) return;
    changed.current = true;
    setLinkRole(next);
    try {
      const updated = await api.shareMode(project.id, 'link', next);
      setLinkRole(updated.share?.linkRole || 'edit');
      setApplied(updated);
      toast(`Anyone signed in with the link can ${next} now`, 'ok');
    } catch (err: any) {
      setLinkRole(linkRole);
      toast(`Could not change what the link allows: ${err.message}`, 'error');
    }
  };

  /** One person's role, with access or invited. */
  const changeRole = async (who: string, role: ShareRole) => {
    changed.current = true;
    try {
      const updated = await api.setRole(project.id, who, role);
      setViewers(updated.share?.viewers || []);
      setApplied(updated);
      toast(role === 'view' ? `${who} can only view now` : `${who} can edit now`, 'ok');
    } catch (err: any) {
      toast(`Could not change what ${who} can do: ${err.message}`, 'error');
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast('Link copied', 'ok');
    } catch {
      toast('Could not copy the link — select it and copy manually', 'error');
    }
  };

  const save = async () => {
    if (busy || switching) return;
    // Separators people actually paste: commas, semicolons, newlines.
    const typed = typedEntries();
    const bad = typed.filter((e) => !EMAIL_RE.test(e) && !ORCID_RE.test(e));
    if (bad.length) { toast(`Not an email address or ORCID iD: ${bad.join(', ')}`, 'error'); return; }
    const list = invitations ? [...base, ...addedEntries(base, typed)] : typed;
    if (list.length > MAX_COLLABORATORS) {
      toast(`Too many collaborators — ${MAX_COLLABORATORS} is the maximum, this would make ${list.length}`, 'error');
      return;
    }
    setBusy(true);
    changed.current = true;
    try {
      const open = new Set(invites.filter((i) => i.state === 'pending').map((i) => i.to));
      const updated = await api.share(project.id, savedMode, list, base, invitations ? inviteRole : undefined);
      if (updated.invitations) changeInvites(updated.invitations);
      setViewers(updated.share?.viewers || []);
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

  const remove = async (who: string) => {
    const ok = await dialogs.confirm({
      title: `Remove ${who}?`,
      body: savedMode === 'link'
        ? `${who} is no longer a collaborator, but anyone signed in with the link can still open “${project.name}”. To keep them out, choose Invite only as well.`
        : `${who} loses access to “${project.name}” right away. If they have it open, their edits stop reaching the project. To let them back in, invite them again.`,
      confirmLabel: 'Remove access',
      danger: true,
    });
    if (!ok) return;
    changed.current = true;
    try {
      const updated = await api.removeCollaborator(project.id, who);
      setBase(updated.share?.collaborators || []);
      setViewers(updated.share?.viewers || []);
      setApplied(updated);
      toast(`Removed ${who}`, 'ok');
    } catch (err: any) {
      toast(`Could not remove ${who}: ${err.message}`, 'error');
    }
  };

  const list = invitations && invites.length > 0 && (
    <InvitationList projectId={project.id} invites={invites} onChange={changeInvites} viewers={viewers} onRole={changeRole} />
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
            <p className="modal__sub">{invitations ? 'Choose who can open this project, and whether they can edit it or only view it.' : 'Choose who can open and edit this project.'}</p>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input type="radio" name="share-mode" checked={mode === 'private'} disabled={busy || !!switching} onChange={() => switchMode('private')} data-testid="share-private" />
              <span><strong>Invite only</strong> — you and the collaborators below</span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <input type="radio" name="share-mode" checked={mode === 'link'} disabled={busy || !!switching} onChange={() => switchMode('link')} data-testid="share-link" />
              <span><strong>Anyone signed in with the link</strong>{invitations ? '' : ' can edit'} — once they open it, it stays in their project list until they remove it</span>
            </label>
            {savedMode === 'link' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                {invitations && <RoleSelect value={linkRole} onChange={changeLinkRole} disabled={!!switching} label="What people with the link can do" testId="share-link-role" />}
                <code data-testid="share-url" style={{ flex: '1 1 auto', minWidth: '6em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--text-s)' }}>{shareUrl}</code>
                <button className="btn btn--small" style={{ flexShrink: 0, marginLeft: 'auto' }} onClick={copyLink} data-testid="share-copy-link">Copy link</button>
              </div>
            )}
            <label htmlFor="share-emails" className="modal__sub" style={{ display: 'block', margin: '0 0 4px' }}>{invitations ? 'Invite people by email or ORCID iD, comma-separated' : 'Collaborator emails or ORCID iDs, comma-separated'}</label>
            <div className="share__invite-field">
              <input
                id="share-emails"
                className="input"
                placeholder="ada@example.edu, grace@example.edu"
                value={emails}
                data-testid="share-emails"
                aria-describedby={authEnabled ? 'share-emails-hint' : undefined}
                onChange={(e) => setEmails(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
              />
              {invitations && <RoleSelect value={inviteRole} onChange={setInviteRole} label="What the people you invite can do" testId="share-invite-role" />}
            </div>
            {authEnabled && <p className="settings__hint" id="share-emails-hint">Each person gets an invitation, and has access once they accept it. People who can view read, typeset and comment; they cannot change the files.</p>}
            {invitations && base.length > 0 && <PeopleList people={base} viewers={viewers} onRemove={remove} onRole={changeRole} />}
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
              {outputs.map((f) => (
                <a key={f.name} className="btn" href={f.url} download={f.name} title={f === bbl ? 'Download the bibliography the last typeset wrote' : 'Download the log of the last typeset'} data-testid={`download-${f.name.slice(f.name.lastIndexOf('.') + 1)}`}>{f.name}</a>
              ))}
            </div>
            <p className="settings__hint">The ZIP holds every file on {downloads.branch}; it imports back into Aldine, or into Overleaf.{bbl && ` arXiv also needs ${bbl.name}, which the ZIP leaves out.`}</p>
          </section>
        )}

        <div className="modal__row">
          {result ? (
            <button className="btn btn--primary" onClick={close} data-testid="share-done">Done</button>
          ) : canManage ? (
            <>
              <button className="btn" onClick={close} data-testid="share-close">Close</button>
              <button className="btn btn--primary" onClick={save} disabled={busy || !!switching} data-testid="share-save">Save</button>
            </>
          ) : (
            <button className="btn" onClick={onClose} data-testid="share-close">Close</button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** The .bbl and the .log the typeset of `pdfUrl` wrote beside it, those
 *  that are there: a document without a bibliography has no .bbl. */
function useOutputFiles(pdfUrl: string | null): OutputFile[] {
  const [found, setFound] = useState<OutputFile[]>([]);
  useEffect(() => {
    if (!pdfUrl) return;
    let live = true;
    const files = ['.bbl', '.log'].map((ext) => outputSibling(pdfUrl, ext)).filter((f): f is OutputFile => f != null);
    const exists = (f: OutputFile) => fetch(f.url.replace('/output?', '/output/exists?'))
      .then((r) => (r.ok ? r.json() : null), () => null)
      .then((b: { exists?: boolean } | null) => !!b?.exists);
    void Promise.all(files.map(exists))
      .then((ok) => { if (live) setFound(files.filter((_, i) => ok[i])); });
    return () => { live = false; };
  }, [pdfUrl]);
  return pdfUrl ? found : [];
}

/** "Can edit" or "Can view". */
function RoleSelect({ value, onChange, label, testId, disabled = false }: { value: ShareRole; onChange(role: ShareRole): void; label: string; testId: string; disabled?: boolean }) {
  return (
    <select className="input share__role" value={value} disabled={disabled} aria-label={label} data-testid={testId}
      onChange={(e) => onChange(e.target.value === 'view' ? 'view' : 'edit')}>
      <option value="edit">Can edit</option>
      <option value="view">Can view</option>
    </select>
  );
}

/** Whether `who` is one of the entries that can only view. */
const roleOf = (viewers: string[], who: string): ShareRole => (viewers.some((v) => v.toLowerCase() === who.toLowerCase()) ? 'view' : 'edit');

/** Who has accepted an invitation, each with their role and a way to take their access away. */
function PeopleList({ people, viewers, onRemove, onRole }: { people: string[]; viewers: string[]; onRemove(who: string): Promise<void>; onRole(who: string, role: ShareRole): Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (who: string, work: () => Promise<void>) => {
    setBusy(who);
    try { await work(); } finally { setBusy(null); }
  };
  return (
    <section className="share__invites" aria-labelledby="share-people-label" data-testid="share-people">
      <div className="menu__label share__label" id="share-people-label">People with access</div>
      <ul role="list" className="share__invite-list">
        {people.map((who) => (
          <li key={who} className="share__person" data-testid="person-row" data-to={who}>
            <span className="share__invite-to" data-testid="person-name">{who}</span>
            <RoleSelect value={roleOf(viewers, who)} disabled={busy === who} onChange={(role) => run(who, () => onRole(who, role))} label={`What ${who} can do`} testId="person-role" />
            <button className="btn btn--small btn--ghost" disabled={busy === who} onClick={() => run(who, () => onRemove(who))}
              aria-label={`Remove ${who}`} data-testid="person-remove">Remove</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The project's open, declined and expired invitations, each with what the
 *  owner can do about it. The link works only for the person invited, so it
 *  is safe to send any way the owner likes. */
function InvitationList({ projectId, invites, onChange, viewers, onRole }: { projectId: string; invites: OwnerInvitation[]; onChange(list: OwnerInvitation[]): void; viewers: string[]; onRole(who: string, role: ShareRole): Promise<void> }) {
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
              <RoleSelect value={roleOf(viewers, inv.to)} disabled={busy === inv.id} label={`What ${inv.to} can do`} testId="invite-role"
                onChange={(role) => { setBusy(inv.id); void onRole(inv.to, role).finally(() => setBusy(null)); }} />
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
