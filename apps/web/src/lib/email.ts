/**
 * Transactional email over SMTP (configured for Resend's SMTP endpoint by
 * default, but any SMTP host works). Email is an OPTIONAL integration: when the
 * SMTP credentials aren't present the sender is a no-op that logs and returns
 * `{ sent: false }` — the same graceful-stub pattern the Sheets export uses — so
 * local/dev runs and the background jobs never fail on missing secrets.
 */
import nodemailer from 'nodemailer';

export type SendEmailArgs = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

function getTransport(): nodemailer.Transporter | null {
  const user = process.env['SMTP_USER'];
  const pass = process.env['SMTP_PASSWORD'];
  if (!user || !pass) return null;

  const host = process.env['SMTP_HOST'] || 'smtp.resend.com';
  const port = Number(process.env['SMTP_PORT'] || 465);
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user, pass },
  });
}

/**
 * Best-effort send. Never throws — callers (including Inngest steps that have
 * already marked an estimate DONE) must not fail because email is unavailable.
 */
export async function sendEmail(args: SendEmailArgs): Promise<{ sent: boolean }> {
  const from = process.env['EMAIL_FROM'];
  const transport = getTransport();
  if (!transport || !from) {
    console.info(`[email] SMTP not configured — skipping "${args.subject}" to ${args.to}`);
    return { sent: false };
  }
  try {
    await transport.sendMail({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text ?? htmlToText(args.html),
    });
    return { sent: true };
  } catch (err) {
    console.error(`[email] failed to send "${args.subject}" to ${args.to}:`, err);
    return { sent: false };
  }
}

/** Absolute app origin used to build links inside emails. */
export function appBaseUrl(): string {
  const raw = process.env['APP_URL'] || process.env['AUTH_URL'] || 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

export function estimateUrl(id: string): string {
  return `${appBaseUrl()}/estimates/${id}`;
}

type EstimateNotice = { to: string; name?: string | null; title: string; estimateId: string };

/** Email sent when document ingestion finishes and the SOW is ready. */
export function sendIngestCompleteEmail(n: EstimateNotice): Promise<{ sent: boolean }> {
  const url = estimateUrl(n.estimateId);
  return sendEmail({
    to: n.to,
    subject: `Documents ingested — "${n.title}" is ready to estimate`,
    html: renderEmail({
      greeting: greet(n.name),
      lead: `We've finished reading the uploaded documents for <strong>${escapeHtml(n.title)}</strong>. The statement of work is ready — you can now run the estimate.`,
      cta: { label: 'Open estimate', url },
      url,
    }),
  });
}

/** Welcome email for a newly created account — login link + temporary password. */
export function sendWelcomeEmail(n: {
  to: string;
  name?: string | null;
  tempPassword: string;
  role: string;
}): Promise<{ sent: boolean }> {
  const url = `${appBaseUrl()}/login`;
  return sendEmail({
    to: n.to,
    subject: 'Your AI Estimation account is ready',
    html: renderEmail({
      greeting: greet(n.name),
      lead: `An account has been created for you on AI Estimation with the <strong>${escapeHtml(n.role)}</strong> role. Use the temporary password below to sign in, then change it.`,
      credentials: { email: n.to, password: n.tempPassword },
      cta: { label: 'Sign in', url },
      url,
    }),
  });
}

/** Email sent when the estimate run finishes and the Menu Card is generated. */
export function sendRunCompleteEmail(n: EstimateNotice): Promise<{ sent: boolean }> {
  const url = estimateUrl(n.estimateId);
  return sendEmail({
    to: n.to,
    subject: `Your estimate is ready — "${n.title}"`,
    html: renderEmail({
      greeting: greet(n.name),
      lead: `Your estimate for <strong>${escapeHtml(n.title)}</strong> has finished running. The Menu Card, narrative and assumptions are ready for review.`,
      cta: { label: 'Review estimate', url },
      url,
    }),
  });
}

// ─── templating helpers ───────────────────────────────────────────────────────

function greet(name?: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first ? `Hi ${escapeHtml(first)},` : 'Hi,';
}

function renderEmail(opts: {
  greeting: string;
  lead: string;
  cta: { label: string; url: string };
  url: string;
  credentials?: { email: string; password: string };
}): string {
  const credentialsRow = opts.credentials
    ? `<tr>
              <td style="padding:0 32px 20px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
                  <tr><td style="padding:12px 16px 4px;font-size:12px;color:#6b7280;">Email</td></tr>
                  <tr><td style="padding:0 16px 10px;font-size:14px;color:#111827;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(opts.credentials.email)}</td></tr>
                  <tr><td style="padding:0 16px 4px;font-size:12px;color:#6b7280;">Temporary password</td></tr>
                  <tr><td style="padding:0 16px 12px;font-size:14px;color:#111827;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(opts.credentials.password)}</td></tr>
                </table>
              </td>
            </tr>`
    : '';
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 8px;">
                <div style="font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6366f1;">AI Estimation</div>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 4px;font-size:15px;color:#111827;">${opts.greeting}</td>
            </tr>
            <tr>
              <td style="padding:8px 32px 20px;font-size:15px;line-height:1.55;color:#374151;">${opts.lead}</td>
            </tr>
            ${credentialsRow}
            <tr>
              <td style="padding:0 32px 28px;">
                <a href="${opts.cta.url}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:8px;">${escapeHtml(opts.cta.label)}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px;font-size:12px;color:#9ca3af;">
                Or paste this link into your browser:<br />
                <a href="${opts.url}" style="color:#6b7280;">${opts.url}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
