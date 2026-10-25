import { useState } from 'react';
import { api } from '../api';
import { useAuth } from './Auth';
import { useToast } from './Toast';

/** Home's notice for a password account whose address is not confirmed yet
 *  (projects shared with it by email stay hidden until it is), and the
 *  outcome of following a confirmation link. */
export default function EmailConfirmBanner() {
  const { user, sendsEmail, emailNotice, clearEmailNotice, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  if (emailNotice) {
    return (
      <div className={`email-banner email-banner--${emailNotice.tone}`} role="status" data-testid="email-confirm-notice">
        <span className="email-banner__text">{emailNotice.text}</span>
        <button className="btn btn--small btn--ghost" onClick={clearEmailNotice} data-testid="email-confirm-notice-close">Close</button>
      </div>
    );
  }
  if (!user?.emailPending) return null;

  const resend = async () => {
    setBusy(true);
    try {
      const r = await api.resendConfirmation();
      if (r.confirmed) { toast('Your email address is already confirmed', 'ok'); await refresh(); }
      else if (r.sent) toast(`A new confirmation link is on its way to ${user.email}`, 'ok');
      else toast('A new confirmation link is in the server log. Ask the administrator to send it to you.', 'ok');
    } catch (err: any) {
      toast(err.message, 'error');
    }
    setBusy(false);
  };

  return (
    <div className="email-banner" role="status" data-testid="email-confirm-banner">
      <span className="email-banner__text">
        Confirm your email address to see projects shared with you.{' '}
        {sendsEmail
          ? <>The link is in the mail we sent to <strong>{user.email}</strong>.</>
          : 'This server sends no email, so ask its administrator for your confirmation link.'}
      </span>
      <button className="btn btn--small" onClick={resend} disabled={busy} data-testid="email-confirm-resend">
        {busy ? 'Sending…' : sendsEmail ? 'Send a new link' : 'Request a new link'}
      </button>
    </div>
  );
}
