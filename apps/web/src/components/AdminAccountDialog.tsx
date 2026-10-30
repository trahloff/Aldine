import { useState } from 'react';
import Modal from './Modal';
import { api, ApiError, AdminUserRow, AdminResetResult } from '../api';

/**
 * One account on the admin page: its status and the actions an administrator
 * may take on it. Every action asks first; deleting asks for the address to
 * be typed. The server applies the same guard rails, this dialog only says
 * why an action is not offered.
 */

type View = 'main' | 'disable' | 'enable' | 'approve' | 'confirm-email' | 'reset' | 'reset-done' | 'delete';

interface Props {
  user: AdminUserRow;
  /** Every account on the page, for the delete dialog's new-owner picker. */
  accounts: AdminUserRow[];
  /** The signed-in administrator's id. */
  meId: string | null;
  /** ALDINE_ADMIN_EMAILS, lowercased. */
  admins: string[];
  sendsEmail: boolean;
  passwordAuth: boolean;
  onChanged(row: AdminUserRow): void;
  onDeleted(message: string): void;
  onClose(): void;
}

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Try again.');

function since(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function AdminAccountDialog({ user, accounts, meId, admins, sendsEmail, passwordAuth, onChanged, onDeleted, onClose }: Props) {
  const [view, setView] = useState<View>('main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoke, setRevoke] = useState(false);
  const [reset, setReset] = useState<AdminResetResult | null>(null);
  const [copied, setCopied] = useState(false);
  const owned = user.projects + user.trashedProjects;
  const [mode, setMode] = useState<'transfer' | 'trash' | null>(owned === 0 ? 'trash' : null);
  const [heir, setHeir] = useState('');
  const [typed, setTyped] = useState('');

  const self = user.id === meId;
  const label = user.email ?? user.name;
  const keepWhy = self
    ? 'You cannot disable or delete your own account.'
    : user.admin
      ? `${user.email} is on ALDINE_ADMIN_EMAILS. Remove it from that list and restart the server to disable or delete this account.`
      : null;
  const onAdminList = !!user.email && admins.includes(user.email.toLowerCase());
  const confirmWhy = onAdminList
    ? 'This address is on ALDINE_ADMIN_EMAILS, so confirming it here would make the account an administrator. Its owner confirms it with the link from the sign-up email or the server log.'
    : null;
  const resetWhy = !passwordAuth
    ? 'Password sign-in is off on this server.'
    : !sendsEmail && onAdminList && !self
      ? 'This address is on ALDINE_ADMIN_EMAILS and this server sends no email: a link shown here would make whoever you give it to an administrator. Its owner resets the password from the sign-in page and gets the link from the server log.'
      : null;
  const heirs = accounts.filter((a) => a.id !== user.id && !a.disabledAt);
  const expected = label.trim().toLowerCase();
  const canDelete = !!mode && (mode === 'trash' || !!heir) && typed.trim().toLowerCase() === expected && !busy;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  const back = () => { setView('main'); setError(null); };

  const confirmStep = (title: string, body: React.ReactNode, confirmLabel: string, onConfirm: () => Promise<void>, danger = false, extra?: React.ReactNode) => (
    <form onSubmit={(e) => { e.preventDefault(); run(onConfirm); }} data-testid="admin-action-step">
      <h2>{title}</h2>
      <p className="modal__sub" data-testid="admin-action-message">{body}</p>
      {extra}
      {error && <p className="admin__error" role="alert" data-testid="admin-action-error">{error}</p>}
      <div className="modal__row">
        <button type="button" className="btn" onClick={back} data-testid="admin-action-cancel">Cancel</button>
        <button type="submit" className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} disabled={busy} data-testid="admin-action-confirm">{confirmLabel}</button>
      </div>
    </form>
  );

  let content: React.ReactNode;
  if (view === 'disable') {
    content = confirmStep(
      `Disable ${user.name}?`,
      'They are signed out everywhere at once and cannot sign in again, with a password or single sign-on. Their access tokens and connected agents stop working while the account is disabled. Their projects stay, and collaborators keep access.',
      'Disable account',
      async () => { onChanged(await api.adminDisable(user.id, revoke)); back(); },
      true,
      <label className="admin-account__check">
        <input type="checkbox" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} data-testid="admin-disable-revoke" />
        <span>Also revoke their access tokens and agent connections for good, so enabling the account does not bring them back</span>
      </label>,
    );
  } else if (view === 'enable') {
    content = confirmStep(
      `Enable ${user.name}?`,
      'They can sign in again. Access tokens and agent connections that were not revoked work again.',
      'Enable account',
      async () => { onChanged(await api.adminEnable(user.id)); back(); },
    );
  } else if (view === 'approve') {
    content = confirmStep(
      `Approve ${user.name}?`,
      `They can sign in from now on.${sendsEmail && user.email ? ` Aldine emails ${user.email} to tell them.` : ''}`,
      'Approve account',
      async () => { onChanged(await api.adminEnable(user.id)); back(); },
    );
  } else if (view === 'confirm-email') {
    content = confirmStep(
      `Confirm ${user.email}?`,
      'Confirm it only when you know the address belongs to this person: projects shared with it appear in their list at once.',
      'Confirm address',
      async () => { onChanged(await api.adminConfirmEmail(user.id)); back(); },
    );
  } else if (view === 'reset') {
    content = sendsEmail
      ? confirmStep(
        `Email ${user.name} a reset link?`,
        `Aldine sends ${user.email} the mail the “Forgot password” form sends. The link works once, for an hour.`,
        'Email reset link',
        async () => { setReset(await api.adminResetLink(user.id)); setView('reset-done'); },
      )
      : confirmStep(
        `Create a reset link for ${user.name}?`,
        `This server sends no email, so you get the link to pass on yourself. It works once, for an hour, and whoever opens it can set the password: send it to ${user.email} only.`,
        'Create reset link',
        async () => { setReset(await api.adminResetLink(user.id)); setView('reset-done'); },
      );
  } else if (view === 'reset-done' && reset) {
    const link = reset.link ? new URL(reset.link, window.location.origin).toString() : null;
    content = (
      <div data-testid="admin-reset-result">
        <h2>{link ? 'Reset link' : 'Reset email sent'}</h2>
        {link ? (
          <>
            <p className="modal__sub">Pass this link on to {user.email}. It works once, for an hour, and is not shown again.</p>
            <div className="admin-account__link">
              <input className="input" readOnly value={link} aria-label="Reset link" data-testid="admin-reset-link-value" onFocus={(e) => e.target.select()} />
              <button
                type="button"
                className="btn"
                data-testid="admin-reset-link-copy"
                onClick={() => { navigator.clipboard?.writeText(link).then(() => setCopied(true), () => setCopied(false)); }}
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </>
        ) : (
          <p className="modal__sub" data-testid="admin-reset-sent">Sent to {reset.to}. The link in it works once, for an hour.</p>
        )}
        <div className="modal__row">
          <button type="button" className="btn btn--primary" onClick={() => { setReset(null); back(); }} data-testid="admin-reset-done">Done</button>
        </div>
      </div>
    );
  } else if (view === 'delete') {
    content = (
      <form
        data-testid="admin-delete-step"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canDelete || !mode) return;
          run(async () => {
            const r = await api.adminDeleteUser(user.id, { projects: mode, ...(mode === 'transfer' ? { transferTo: heir } : {}), confirm: typed });
            const to = accounts.find((a) => a.id === heir);
            const count = (n: number) => `${n} ${n === 1 ? 'project' : 'projects'}`;
            const what = mode === 'transfer'
              ? `${to?.email ?? to?.name ?? 'The new owner'} now owns ${count(r.transferred)}`
              : `${count(r.trashed)} moved to the trash`;
            onDeleted(`Deleted ${label}. ${what}.`);
          });
        }}
      >
        <h2>Delete {user.name}?</h2>
        <p className="modal__sub">
          This cannot be undone. The account, its sessions, access tokens and agent connections are removed, and it comes off every project it was invited to.
        </p>
        {owned === 0 ? (
          <p className="modal__sub" data-testid="admin-delete-no-projects">They own no projects.</p>
        ) : (
          <fieldset className="admin-account__choice">
            <legend>
              Their {user.projects} {user.projects === 1 ? 'project' : 'projects'}{user.trashedProjects ? ` (and ${user.trashedProjects} in the trash)` : ''}:
            </legend>
            <label>
              <input type="radio" name="admin-delete-projects" checked={mode === 'transfer'} onChange={() => setMode('transfer')} data-testid="admin-delete-transfer" disabled={!heirs.length} />
              <span>Give them to another account. Their Zotero links are removed; the new owner links their own library.</span>
            </label>
            {mode === 'transfer' && (
              <select className="input admin-account__heir" value={heir} onChange={(e) => setHeir(e.target.value)} aria-label="New owner" data-testid="admin-delete-transfer-to">
                <option value="">Choose the new owner…</option>
                {heirs.map((a) => <option key={a.id} value={a.id}>{a.name}{a.email ? ` — ${a.email}` : ''}</option>)}
              </select>
            )}
            <label>
              <input type="radio" name="admin-delete-projects" checked={mode === 'trash'} onChange={() => setMode('trash')} data-testid="admin-delete-trash" />
              <span>Move them to the trash. With the owner gone nobody can restore them, and the trash purges them on schedule.</span>
            </label>
          </fieldset>
        )}
        <label htmlFor="admin-delete-confirm" className="modal__sub admin-account__type">Type <strong>{label}</strong> to confirm</label>
        <input
          id="admin-delete-confirm"
          className="input"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          data-testid="admin-delete-confirm-input"
        />
        {error && <p className="admin__error" role="alert" data-testid="admin-action-error">{error}</p>}
        <div className="modal__row">
          <button type="button" className="btn" onClick={back} data-testid="admin-action-cancel">Cancel</button>
          <button type="submit" className="btn btn--danger" disabled={!canDelete} data-testid="admin-delete-submit">Delete account</button>
        </div>
      </form>
    );
  } else {
    content = (
      <div>
        <h2>{user.name}</h2>
        <p className="modal__sub">{user.email ?? 'No email address'}</p>
        <dl className="admin-account__facts">
          <dt>Address</dt>
          <dd>{!user.email ? '—' : user.emailPending ? 'Not confirmed' : 'Confirmed'}</dd>
          <dt>Account</dt>
          <dd data-testid="admin-account-status">{user.awaitingApproval ? `Waiting for approval since ${since(user.createdAt)}` : user.disabledAt ? `Disabled since ${since(user.disabledAt)}` : 'Active'}</dd>
          <dt>Sign-in</dt>
          <dd>{user.signIn}</dd>
          <dt>Last seen</dt>
          <dd>{user.lastSeenAt ? since(user.lastSeenAt) : 'never'}</dd>
          <dt>Projects</dt>
          <dd>{user.projects}{user.trashedProjects ? `, ${user.trashedProjects} in the trash` : ''}</dd>
        </dl>
        <ul className="admin-account__actions">
          {user.awaitingApproval ? (
            <li>
              <button className="btn btn--primary" onClick={() => setView('approve')} data-testid="admin-approve">Approve account</button>
              <span>Lets them sign in. To turn them away, delete the account.</span>
            </li>
          ) : user.disabledAt ? (
            <li>
              <button className="btn" onClick={() => setView('enable')} data-testid="admin-enable">Enable account</button>
              <span>Lets them sign in again.</span>
            </li>
          ) : (
            <li>
              <button className="btn" onClick={() => setView('disable')} disabled={!!keepWhy} data-testid="admin-disable">Disable account</button>
              <span>{keepWhy ?? 'Signs them out everywhere and stops every sign-in. Reversible.'}</span>
            </li>
          )}
          {user.emailPending && (
            <li>
              <button className="btn" onClick={() => setView('confirm-email')} disabled={!!confirmWhy} data-testid="admin-confirm-email">Confirm address</button>
              <span>{confirmWhy ?? 'For a server without email, in place of the link from the log.'}</span>
            </li>
          )}
          {user.password && (
            <li>
              <button className="btn" onClick={() => setView('reset')} disabled={!!resetWhy} data-testid="admin-reset-link">{sendsEmail ? 'Email reset link' : 'Create reset link'}</button>
              <span>{resetWhy ?? (sendsEmail ? `Mails ${user.email} a link to set a new password.` : 'Gives you a link to set a new password, to pass on.')}</span>
            </li>
          )}
          <li>
            <button className="btn btn--danger" onClick={() => setView('delete')} disabled={!!keepWhy} data-testid="admin-delete">Delete account</button>
            <span>{keepWhy ?? 'Removes the account for good. You choose what happens to its projects.'}</span>
          </li>
        </ul>
        <div className="modal__row">
          <button type="button" className="btn" onClick={onClose} data-testid="admin-account-close">Close</button>
        </div>
      </div>
    );
  }

  return (
    <Modal onClose={onClose} label={`Manage ${label}`} testId="admin-account-dialog" width={520}>
      {content}
    </Modal>
  );
}
