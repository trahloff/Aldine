import { useEffect, useRef, useState } from 'react';
import { withBase } from '../basePath';
import { api, ProjectSummary, type ShareLinkInfo, type ShareRole } from '../api';
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
  const fileStem = (project.name || 'document').replace(/[\\/:*?"<>|]/g, '-');
  const outputs = useOutputFiles(downloads?.pdfUrl ?? null);
  const bbl = outputs.find((f) => f.name.endsWith('.bbl'));

  // Accepting adds people to the list while the page that opened this
  // dialog still holds the old one: start from the server's.
  const [base, setBase] = useState(project.share?.collaborators || []);
  // Roles: the entries that cannot edit, and the role the people typed into
  // the field get.
  const [roles, setRoles] = useState(project.share?.roles || {});
  const [links, setLinks] = useState<ShareLinkInfo[]>(project.share?.links || []);
  const [inviteRole, setInviteRole] = useState<ShareRole>('edit');
  // A change made here is newer than the server's answer to the fetches
  // below: one to the share for the project's, one to an invitation for the list's.
  const changed = useRef(false);
  const invitesChanged = useRef(false);
  const changeInvites = (list: OwnerInvitation[]) => { invitesChanged.current = true; setInvites(list); };
  useEffect(() => {
    if (!invitations) return;
    api.projectInvitations(project.id)
      .then((list) => { if (!invitesChanged.current) setInvites(list); })
      .catch(() => { if (!invitesChanged.current) setInvites([]); });
    api.getProject(project.id).then((p) => {
      if (!p.share || changed.current) return;
      setBase(p.share.collaborators);
      setRoles(p.share.roles || {});
      setLinks(p.share.links || []);
    }).catch(() => {});
  }, [invitations, project.id]);

  const typedEntries = () => emails.split(/[,;\n]/).map((e) => e.trim()).filter(Boolean);
  // Links and roles apply on click; only the address field waits for Save.
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
        danger: true,
      });
      if (!ok) return;
    }
    finish();
  };

  /** A change to the links, applied already. */
  const linksChanged = (updated: ProjectSummary) => {
    changed.current = true;
    setLinks(updated.share?.links || []);
    setApplied(updated);
  };

  /** One person's role, with access or invited. */
  const changeRole = async (who: string, role: ShareRole) => {
    changed.current = true;
    try {
      const updated = await api.setRole(project.id, who, role);
      setRoles(updated.share?.roles || {});
      setApplied(updated);
      toast(`${who} ${ROLE_DOES[role]} now`, 'ok');
    } catch (err: any) {
      toast(`Could not change what ${who} can do: ${err.message}`, 'error');
    }
  };

  const save = async () => {
    if (busy) return;
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
      const updated = await api.share(project.id, list, base, invitations ? inviteRole : undefined);
      if (updated.invitations) changeInvites(updated.invitations);
      setRoles(updated.share?.roles || {});
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
      body: links.length
        ? `${who} loses access to “${project.name}” right away, unless a share link you gave them still lets them in. If they have it open, their edits stop reaching the project. To let them back in, invite them again.`
        : `${who} loses access to “${project.name}” right away. If they have it open, their edits stop reaching the project. To let them back in, invite them again.`,
      confirmLabel: 'Remove access',
      danger: true,
    });
    if (!ok) return;
    changed.current = true;
    try {
      const updated = await api.removeCollaborator(project.id, who);
      setBase(updated.share?.collaborators || []);
      setRoles(updated.share?.roles || {});
      setApplied(updated);
      toast(`Removed ${who}`, 'ok');
    } catch (err: any) {
      toast(`Could not remove ${who}: ${err.message}`, 'error');
    }
  };

  const list = invitations && invites.length > 0 && (
    <InvitationList projectId={project.id} invites={invites} onChange={changeInvites} roles={roles} onRole={changeRole} />
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
            <p className="modal__sub">{invitations ? 'Choose who can open this project, and whether they can edit it, review it or only view it.' : 'Choose who can open and edit this project.'}</p>
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
            {authEnabled && <p className="settings__hint" id="share-emails-hint">Each person gets an invitation, and has access once they accept it. People who can review read, typeset, comment and suggest changes; people who can view read and typeset. Neither can change the files.</p>}
            {invitations && base.length > 0 && <PeopleList people={base} roles={roles} onRemove={remove} onRole={changeRole} />}
            {list}
            {invitations && <ShareLinks project={project} links={links} onChange={linksChanged} />}
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

/** What each role lets a person do, after their name. */
const ROLE_DOES: Record<ShareRole, string> = { edit: 'can edit', review: 'can comment and suggest changes', view: 'can only view' };

/** "Can edit", "Can review" or "Can view". */
function RoleSelect({ value, onChange, label, testId, disabled = false }: { value: ShareRole; onChange(role: ShareRole): void; label: string; testId: string; disabled?: boolean }) {
  return (
    <select className="input share__role" value={value} disabled={disabled} aria-label={label} data-testid={testId}
      onChange={(e) => onChange(e.target.value === 'view' ? 'view' : e.target.value === 'review' ? 'review' : 'edit')}>
      <option value="edit">Can edit</option>
      <option value="review">Can review</option>
      <option value="view">Can view</option>
    </select>
  );
}

/** The role of `who`, one of the entries with access or invited. */
const roleOf = (roles: Record<string, 'review' | 'view'>, who: string): ShareRole => roles[who.toLowerCase()] ?? roles[who.toUpperCase()] ?? roles[who] ?? 'edit';

/** Who has accepted an invitation, each with their role and a way to take their access away. */
function PeopleList({ people, roles, onRemove, onRole }: { people: string[]; roles: Record<string, 'review' | 'view'>; onRemove(who: string): Promise<void>; onRole(who: string, role: ShareRole): Promise<void> }) {
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
            <RoleSelect value={roleOf(roles, who)} disabled={busy === who} onChange={(role) => run(who, () => onRole(who, role))} label={`What ${who} can do`} testId="person-role" />
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
function InvitationList({ projectId, invites, onChange, roles, onRole }: { projectId: string; invites: OwnerInvitation[]; onChange(list: OwnerInvitation[]): void; roles: Record<string, 'review' | 'view'>; onRole(who: string, role: ShareRole): Promise<void> }) {
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
              <RoleSelect value={roleOf(roles, inv.to)} disabled={busy === inv.id} label={`What ${inv.to} can do`} testId="invite-role"
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

/** The address a link opens: the project's own, with the link's token. */
export const shareLinkUrl = (projectId: string, link: Pick<ShareLinkInfo, 'token'>) =>
  `${location.origin}${withBase(`/p/${projectId}`)}${link.token ? `#link=${link.token}` : ''}`;

/** The end of the chosen day in the owner's time zone, as an ISO time. */
const endOfDay = (day: string) => new Date(`${day}T23:59:59`).toISOString();
const todayInput = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ROLE_NAME: Record<ShareRole, string> = { edit: 'Can edit', review: 'Can review', view: 'Can view' };

/** The project's share links, each with its own role, name and expiry, and
 *  a way to make one and to revoke one. */
function ShareLinks({ project, links, onChange }: { project: Pick<ProjectSummary, 'id' | 'name'>; links: ShareLinkInfo[]; onChange(updated: ProjectSummary): void }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const [role, setRole] = useState<ShareRole>('review');
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('');
  const [guests, setGuests] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Shown after a copy that failed (no clipboard on a plain-http address).
  const [shown, setShown] = useState<string | null>(null);

  const copy = async (link: ShareLinkInfo, made = false) => {
    try {
      await navigator.clipboard.writeText(shareLinkUrl(project.id, link));
      setShown(null);
      toast(made ? (link.guests ? 'Link created and copied. Anyone who opens it gets its role, with or without an account.' : 'Link created and copied. Anyone signed in who opens it gets its role.') : 'Link copied', 'ok');
    } catch {
      setShown(link.id);
      toast(made ? 'Link created. Copy it from below and send it yourself.' : 'Could not copy the link: select it below and copy it yourself', made ? 'ok' : 'error');
    }
  };
  const create = async () => {
    setBusy('new');
    try {
      const r = await api.createShareLink(project.id, { role, ...(label.trim() ? { label: label.trim() } : {}), ...(expiry ? { expiresAt: endOfDay(expiry) } : {}), ...(guests ? { guests: true } : {}) });
      onChange(r);
      setLabel('');
      setExpiry('');
      setGuests(false);
      await copy(r.link, true);
    } catch (err: any) {
      toast(`Could not create the link: ${err.message}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const revoke = async (link: ShareLinkInfo) => {
    const name = link.label ? `“${link.label}”` : 'this link';
    const who = link.token ? (link.joined === 1 ? 'The person who came in through it loses' : link.joined > 1 ? `The ${link.joined} people who came in through it lose` : 'Everyone who came in through it loses') : 'Everyone who opened the project at its address, without being invited, loses';
    const ok = await dialogs.confirm({
      title: `Revoke ${name}?`,
      body: `${who} access to “${project.name}” now, and anyone with it open is cut off. People you invited by email or ORCID iD keep their access. A revoked link cannot be turned back on: to let people in again, create a new link.`,
      confirmLabel: 'Revoke link',
      danger: true,
    });
    if (!ok) return;
    setBusy(link.id);
    try {
      onChange(await api.revokeShareLink(project.id, link.id));
      toast(link.label ? `Revoked “${link.label}”` : 'Link revoked', 'ok');
    } catch (err: any) {
      toast(`Could not revoke the link: ${err.message}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const toggleGuests = async (link: ShareLinkInfo) => {
    const name = link.label ? `“${link.label}”` : 'this link';
    if (link.guests && (link.joinedGuests ?? 0) > 0) {
      const n = link.joinedGuests ?? 0;
      const ok = await dialogs.confirm({
        title: `Turn off guests for ${name}?`,
        body: `${n === 1 ? 'The guest who came in through it loses' : `The ${n} guests who came in through it lose`} access to “${project.name}” now, and anyone of them with it open is cut off. People with an account keep the access the link gave them.`,
        confirmLabel: 'Turn off guests',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(link.id);
    try {
      onChange(await api.setShareLinkGuests(project.id, link.id, !link.guests));
      toast(link.guests ? 'Only people with an account can use the link now' : 'Anyone with the link can join now, no account needed', 'ok');
    } catch (err: any) {
      toast(`Could not change the link: ${err.message}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const expiryText = (l: ShareLinkInfo) => {
    if (!l.expiresAt) return 'No expiry';
    const at = new Date(l.expiresAt);
    const day = at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    return at.getTime() <= Date.now() ? `Expired ${day}` : `Expires ${day}`;
  };

  return (
    <section className="share__invites" aria-labelledby="share-links-label" data-testid="share-links">
      <div className="menu__label share__label" id="share-links-label">Share links</div>
      <p className="settings__hint">Anyone signed in who opens a link gets its role; a link can also let people in as guests, without an account, under a name they give. Guests never typeset. Revoking a link locks its people out at once; people you invited keep their access.</p>
      {links.length > 0 && (
        <ul role="list" className="share__invite-list">
          {links.map((l) => (
            <li key={l.id} className="share__invite" data-testid="share-link-row" data-link-id={l.id}>
              <div className="share__invite-line">
                <span className="share__invite-to" data-testid="share-link-label">{l.label || (l.token ? 'Unnamed link' : 'Project address')}</span>
                <span className="share__invite-state" data-testid="share-link-role">{ROLE_NAME[l.role]}</span>
                <span className="share__invite-state" data-testid="share-link-expiry">{expiryText(l)}</span>
                <span className="share__invite-state" data-testid="share-link-joined">{l.joined === 1 ? '1 person joined' : `${l.joined} people joined`}{l.joinedGuests ? `, ${l.joinedGuests === 1 ? '1 guest' : `${l.joinedGuests} guests`}` : ''}</span>
                {l.guests && <span className="share__invite-state" data-testid="share-link-guests">No account needed</span>}
              </div>
              <div className="share__invite-actions">
                <button className="btn btn--small" onClick={() => copy(l)} data-testid="share-link-copy">Copy link</button>
                {l.token && (
                  <button className="btn btn--small btn--ghost" disabled={busy === l.id} onClick={() => toggleGuests(l)} data-testid="share-link-toggle-guests">
                    {l.guests ? 'Turn off guests' : 'Allow guests'}
                  </button>
                )}
                <button className="btn btn--small btn--ghost" disabled={busy === l.id} onClick={() => revoke(l)} data-testid="share-link-revoke">Revoke</button>
              </div>
              {shown === l.id && <LinkField link={shareLinkUrl(project.id, l)} to={l.label || 'this link'} />}
            </li>
          ))}
        </ul>
      )}
      <div className="share__invite-field" data-testid="share-link-new">
        <input className="input" placeholder="Name, e.g. Reviewers" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)}
          aria-label="Name of the new link (optional)" data-testid="share-link-new-label" />
        <RoleSelect value={role} onChange={setRole} label="What people with the new link can do" testId="share-link-new-role" />
      </div>
      <label className="share__guests settings__hint" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '0 0 6px' }}>
        <input type="checkbox" checked={guests} onChange={(e) => setGuests(e.target.checked)} data-testid="share-link-new-guests" />
        Anyone with the link, no account needed
      </label>
      <div className="share__invite-field">
        <label className="settings__hint" htmlFor="share-link-new-expiry" style={{ margin: 0 }}>Expires after</label>
        <input id="share-link-new-expiry" className="input" type="date" min={todayInput()} value={expiry} onChange={(e) => setExpiry(e.target.value)} data-testid="share-link-new-expiry" />
        <button className="btn btn--small" disabled={busy === 'new'} onClick={create} data-testid="share-link-create">Create link</button>
      </div>
    </section>
  );
}
