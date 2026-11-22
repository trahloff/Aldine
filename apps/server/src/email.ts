/**
 * Transactional email (password reset). Three backends, picked by env — the
 * SDK/SMTP libs are optionalDependencies loaded dynamically, so the slim
 * self-host default needs neither installed:
 *   - SES_FROM set  → AWS SES via @aws-sdk/client-sesv2 (uses the task's IAM
 *     role; no static credentials). This is the AWS-native path.
 *   - SMTP_HOST set → any SMTP server via nodemailer.
 *   - neither       → log the message (dev / self-host relay).
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export function emailConfigured(): boolean {
  return !!(process.env.SES_FROM || process.env.SMTP_HOST);
}

/** e.g. "Aldine <no-reply@aldine.example.com>" or a bare address. */
function fromAddress(): string {
  return process.env.SES_FROM || process.env.SMTP_FROM || `Aldine <no-reply@localhost>`;
}

let sesClient: any = null;
let smtpTransport: any = null;

/** Mails logged for want of a transport, per recipient; kept under
 *  ALDINE_TEST_HOOKS only, for the e2e suite to read. */
const logged = new Map<string, Mail[]>();
export const loggedMailsTo = (to: string): Mail[] => logged.get(to.trim().toLowerCase()) ?? [];

export async function sendMail(mail: Mail): Promise<void> {
  if (process.env.SES_FROM) return sendViaSes(mail);
  if (process.env.SMTP_HOST) return sendViaSmtp(mail);
  console.log(`[aldine] email (no transport configured) → ${mail.to}: ${mail.subject}\n${mail.text}`);
  if (process.env.ALDINE_TEST_HOOKS === '1') {
    const key = mail.to.toLowerCase();
    logged.set(key, [...(logged.get(key) ?? []), mail].slice(-20));
  }
}

async function sendViaSes(mail: Mail): Promise<void> {
  if (!sesClient) {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (!region) console.warn('[aldine] SES_FROM is set but AWS_REGION/AWS_DEFAULT_REGION is not — SES sends will fail with "Region is missing"');
    const mod: any = await import('@aws-sdk/client-sesv2');
    sesClient = { mod, client: new mod.SESv2Client({ region }) };
  }
  const { mod, client } = sesClient;
  await client.send(new mod.SendEmailCommand({
    FromEmailAddress: fromAddress(),
    Destination: { ToAddresses: [mail.to] },
    Content: {
      Simple: {
        Subject: { Data: mail.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: mail.text, Charset: 'UTF-8' },
          ...(mail.html ? { Html: { Data: mail.html, Charset: 'UTF-8' } } : {}),
        },
      },
    },
  }));
}

async function sendViaSmtp(mail: Mail): Promise<void> {
  if (!smtpTransport) {
    // computed specifier: keeps nodemailer a runtime-only optional dep (no @types needed)
    const spec = 'nodemailer';
    const mod: any = await import(spec);
    const nodemailer: any = mod.default ?? mod;
    const port = Number(process.env.SMTP_PORT || 587);
    smtpTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === '1' || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  await smtpTransport.sendMail({ from: fromAddress(), to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** To an administrator: an account waits for approval (ALDINE_SIGNUP=approval).
 *  `account` is its address or ORCID iD, never its display name. `note` is
 *  the signer's own text ("what will you use Aldine for?"): quoted as theirs,
 *  never as a link. Links are built from ALDINE_PUBLIC_URL only.
 *  `noteAdded`: the account waited already and has just added its note. */
export function approvalRequestMail(to: string, m: { account: string; signIn: string; instance: string; adminLink: string; note?: string; noteAdded?: boolean }): Mail {
  const line = `${m.account} (signs in with ${m.signIn})`;
  const lead = m.noteAdded
    ? `An account waiting for approval on the Aldine server at ${m.instance} added a note:`
    : `A new account on the Aldine server at ${m.instance} is waiting for approval:`;
  const noteText = m.note ? `\n\nThey wrote what they will use Aldine for (their words, not checked):\n"${m.note}"` : '';
  const noteHtml = m.note ? `<p>They wrote what they will use Aldine for (their words, not checked):</p><blockquote style="margin:0 0 1em;padding-left:1em;border-left:3px solid #ccc">${escapeHtml(m.note)}</blockquote>` : '';
  return {
    to,
    subject: m.noteAdded ? 'A waiting Aldine account added a note' : 'A new Aldine account is waiting for approval',
    text: `${lead}\n\n${line}${noteText}\n\nApprove or delete it on the admin page:\n${m.adminLink}\n\nYou get this email because your address is on ALDINE_ADMIN_EMAILS.`,
    html: `<p>${escapeHtml(lead)}</p><p><strong>${escapeHtml(line)}</strong></p>${noteHtml}<p><a href="${escapeHtml(m.adminLink)}">Approve or delete it on the admin page</a>.</p><p>You get this email because your address is on ALDINE_ADMIN_EMAILS.</p>`,
  };
}

/** Where an approved person asks for help: the instance's support contact,
 *  or its administrators and Aldine's issue tracker when it has none. */
type Support = { kind: 'email' | 'url'; value: string } | null;
const ISSUES_URL = 'https://github.com/trahloff/Aldine/issues';

/**
 * To the person whose waiting account an administrator approved: the account
 * is ready, where to sign in, and three first steps. `link` is built from
 * ALDINE_PUBLIC_URL only; `support` is the instance's contact (ALDINE_SUPPORT
 * or the one set on /admin).
 */
export function approvedMail(to: string, instance: string, link: string, support: Support = null): Mail {
  const feedbackText = support
    ? `Questions, or something slow, broken or missing? Write to ${support.value}.`
    : `Questions, or something slow, broken or missing? Ask the administrator of this server, or open an issue at ${ISSUES_URL}.`;
  const supportHref = support?.kind === 'email' ? `mailto:${support.value}` : support?.value;
  const feedbackHtml = support
    ? `Questions, or something slow, broken or missing? Write to <a href="${escapeHtml(supportHref!)}">${escapeHtml(support.value)}</a>.`
    : `Questions, or something slow, broken or missing? Ask the administrator of this server, or <a href="${ISSUES_URL}">open an issue for Aldine</a>.`;
  const steps = [
    'Create a project: New project starts one blank or from a template, and Import a ZIP brings one in from Overleaf or another Aldine.',
    'Share it: Share in the project invites co-authors by email address or ORCID iD, or creates a link for guests who have no account.',
  ];
  return {
    to,
    subject: 'Your Aldine account is ready',
    text: `Hi there,\n\nAn administrator approved your account on the Aldine server at ${instance}, so it is ready to use. Sign in here:\n${link}\n\nThree first steps:\n\n1. ${steps[0]}\n2. ${steps[1]}\n3. ${feedbackText}`,
    html: `<p>Hi there,</p><p>An administrator approved your account on the Aldine server at ${escapeHtml(instance)}, so it is ready to use. <a href="${escapeHtml(link)}">Sign in here</a>.</p><p>Three first steps:</p><ol><li>${escapeHtml(steps[0])}</li><li>${escapeHtml(steps[1])}</li><li>${feedbackHtml}</li></ol>`,
  };
}

/** The password-reset mail. The forgot-password form and an administrator
 *  send the same one; `link` is built from ALDINE_PUBLIC_URL only. */
export function resetMail(to: string, link: string, token: string): Mail {
  return {
    to,
    subject: 'Reset your Aldine password',
    text: `Someone requested a password reset for your Aldine account.\n\nOpen this link to set a new password (expires in 1 hour):\n${link}\n\nOr enter this token manually: ${token}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>Someone requested a password reset for your Aldine account.</p><p><a href="${link}">Set a new password</a> (expires in 1 hour).</p><p>Or enter this token manually: <code>${token}</code></p><p>If you didn't request this, you can ignore this email.</p>`,
  };
}
