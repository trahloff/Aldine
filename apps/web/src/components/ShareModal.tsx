import { useState } from 'react';
import { withBase } from '../basePath';
import { api, ProjectSummary } from '../api';
import { useToast } from './Toast';
import Modal from './Modal';
import { addedEmails, inviteSummary } from '../util/invites';

/** Mirrors the server's collaborator filter (the share route) so an address it
 *  would silently discard is reported here instead of vanishing on save. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// An ORCID iD invites a researcher who signed in with ORCID and has no public email.
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dXx]$/;
const MAX_COLLABORATORS = 50;

/** Who may open the project (the owner's call, and only with sign-in) and,
 *  from the editor, the PDF and the source as files, which everyone gets. */
export default function ShareModal({ project, canManage = true, downloads, onClose, onSaved }: {
  project: Pick<ProjectSummary, 'id' | 'name' | 'share'>;
  canManage?: boolean;
  /** The branch the source download archives, and the PDF on screen (null
   *  until a typeset succeeds). */
  downloads?: { branch: string; pdfUrl: string | null };
  onClose(): void;
  onSaved(updated: ProjectSummary): void;
}) {
  const [mode, setMode] = useState<'private' | 'link'>(project.share?.mode || 'private');
  const [emails, setEmails] = useState((project.share?.collaborators || []).join(', '));
  const [busy, setBusy] = useState(false);
  // After a save that added addresses the dialog stays open to say who got
  // mail; the caller hears of the save when it closes, however it closes.
  const [result, setResult] = useState<{ updated: ProjectSummary; sent: string | null; manual: string | null } | null>(null);
  const close = () => (result ? onSaved(result.updated) : onClose());
  const toast = useToast();
  const shareUrl = `${location.origin}${withBase(`/p/${project.id}`)}`;
  const fileStem = (project.name || 'document').replace(/[\\/:*?"<>|]/g, '-');

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
      const updated = await api.share(project.id, mode, list);
      const added = addedEmails(project.share?.collaborators || [], list);
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

  return (
    <Modal onClose={close} label={`Share ${project.name}`} testId="share-modal">
      <div>
        <h2>Share “{project.name}”</h2>
        {result ? (
          <div data-testid="share-invite-result">
            <p className="modal__sub">Sharing updated.</p>
            {result.sent && <p data-testid="share-invite-sent">{result.sent}</p>}
            {result.manual && <p data-testid="share-invite-manual">{result.manual}</p>}
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
              onChange={(e) => setEmails(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            />
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
