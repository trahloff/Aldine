import { useState } from 'react';
import { withBase } from '../basePath';
import { api, ProjectSummary } from '../api';
import { useToast } from './Toast';
import Modal from './Modal';

/** Mirrors the server's collaborator filter (the share route) so an address it
 *  would silently discard is reported here instead of vanishing on save. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// An ORCID iD invites a researcher who signed in with ORCID and has no public email.
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dXx]$/;
const MAX_COLLABORATORS = 50;

/** Owner-only sharing dialog: private/link mode + collaborator emails. */
export default function ShareModal({ project, onClose, onSaved }: {
  project: Pick<ProjectSummary, 'id' | 'name' | 'share'>;
  onClose(): void;
  onSaved(updated: ProjectSummary): void;
}) {
  const [mode, setMode] = useState<'private' | 'link'>(project.share?.mode || 'private');
  const [emails, setEmails] = useState((project.share?.collaborators || []).join(', '));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const shareUrl = `${location.origin}${withBase(`/p/${project.id}`)}`;

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
      toast('Sharing updated', 'ok');
      onSaved(updated);
    } catch (err: any) {
      toast(`Could not update sharing: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={`Share ${project.name}`} testId="share-modal">
      <div>
        <h2>Share “{project.name}”</h2>
        <p className="modal__sub">Choose who can open and edit this project.</p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <input type="radio" name="share-mode" checked={mode === 'private'} onChange={() => setMode('private')} data-testid="share-private" />
          <span><strong>Invite only</strong> — you and the collaborators below</span>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <input type="radio" name="share-mode" checked={mode === 'link'} onChange={() => setMode('link')} data-testid="share-link" />
          <span><strong>Anyone signed in with the link</strong> can edit — it won’t appear in their project list</span>
        </label>
        {mode === 'link' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <code data-testid="share-url" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{shareUrl}</code>
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
        <div className="modal__row">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={busy} data-testid="share-save">Save</button>
        </div>
      </div>
    </Modal>
  );
}
