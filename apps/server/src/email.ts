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

export async function sendMail(mail: Mail): Promise<void> {
  if (process.env.SES_FROM) return sendViaSes(mail);
  if (process.env.SMTP_HOST) return sendViaSmtp(mail);
  console.log(`[aldine] email (no transport configured) → ${mail.to}: ${mail.subject}\n${mail.text}`);
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
