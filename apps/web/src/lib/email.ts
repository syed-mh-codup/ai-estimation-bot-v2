/**
 * Transactional email over SMTP (configured for Resend's SMTP endpoint by
 * default, but any SMTP host works). Email is an OPTIONAL integration: when the
 * SMTP credentials aren't present the sender is a no-op that logs and returns
 * `{ sent: false }` — the same graceful-stub pattern the Sheets export uses — so
 * local/dev runs and the background jobs never fail on missing secrets.
 *
 * ── Design ──────────────────────────────────────────────────────────────────
 * These are Warm Ledger surfaces, not generic transactional mail. They used to
 * be stock Tailwind grey on indigo, which belonged to no product in particular;
 * an estimate is a document, and mail about it should look like it came off the
 * same press. The palette below is lifted from `app/globals.css` — putty
 * ground, paper card, warm ink, one accounting-green accent — and it keeps that
 * file's three-job colour rule: green settles, bronze is in flight, brick is a
 * problem.
 *
 * Email is not the browser, so three concessions are deliberate:
 *   - Tables and inline styles only. No classes, no custom properties, no grid.
 *   - No web fonts. Newsreader / Hanken / Plex Mono cannot load in Gmail, so
 *     each stack falls through to the same fallback the app itself declares
 *     (Georgia for the serif, system sans, system mono), which keeps the shapes
 *     close rather than pretending.
 *   - A fixed 520px card. Every client honours it; a fluid one is a lottery.
 */
import nodemailer from 'nodemailer';
import type { ReminderKind } from '@repo/db';
import { dueLabel, formatDueDate } from './due-date';

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
      headline: 'The documents are read',
      pill: { tone: 'green', label: 'Ready to run' },
      lead: `We've finished reading the uploaded material for ${strong(n.title)}. The statement of work is assembled, so the crew can start estimating whenever you are.`,
      rows: [{ k: 'Estimate', v: escapeHtml(n.title) }],
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
      headline: 'Your account is ready',
      lead: `You have an account on AI Estimation with the ${strong(n.role)} role. Sign in with the temporary password below, then change it from your profile.`,
      rows: [
        { k: 'Email', v: escapeHtml(n.to), mono: true },
        { k: 'Temporary password', v: escapeHtml(n.tempPassword), mono: true },
      ],
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
      headline: 'Your estimate is ready',
      pill: { tone: 'green', label: 'Run complete' },
      lead: `The crew has finished with ${strong(n.title)}. The Menu Card, the narrative and the assumptions are all waiting for review.`,
      rows: [{ k: 'Estimate', v: escapeHtml(n.title) }],
      cta: { label: 'Review estimate', url },
      url,
    }),
  });
}

/**
 * How each reminder beat presents. Mirrors the dashboard deliberately: only the
 * states you have to do something about today carry colour, and every one of
 * them carries a word as well.
 */
const REMINDER_PILL: Record<ReminderKind, { tone: PillTone; label: string }> = {
  DUE_SOON: { tone: 'neutral', label: 'Due soon' },
  DUE_TODAY: { tone: 'bronze', label: 'Due today' },
  OVERDUE: { tone: 'brick', label: 'Overdue' },
};

/**
 * A deadline nudge, sent by the daily sweep (lib/reminders.ts).
 *
 * `recipient` says which branch the sweep took, and it earns its place: with no
 * custodian set the mail goes to the owner instead, and telling them they are
 * "down as its custodian" would be a plain lie — a confusing one, since the fix
 * is for somebody to actually take custody.
 */
export function sendDueReminderEmail(n: {
  to: string;
  name?: string | null;
  title: string;
  estimateId: string;
  kind: ReminderKind;
  dueAt: Date;
  now: Date;
  recipient: 'custodian' | 'owner';
}): Promise<{ sent: boolean }> {
  const url = estimateUrl(n.estimateId);
  const date = formatDueDate(n.dueAt);
  const relative = dueLabel(n.dueAt, n.now);

  const subject =
    n.kind === 'OVERDUE'
      ? `Overdue — "${n.title}" was due ${date}`
      : n.kind === 'DUE_TODAY'
        ? `Due today — "${n.title}"`
        : `Due ${date} — "${n.title}"`;

  const headline =
    n.kind === 'OVERDUE'
      ? 'This one has slipped'
      : n.kind === 'DUE_TODAY'
        ? 'Due today'
        : `Due ${date}`;

  const body =
    n.kind === 'OVERDUE'
      ? `${strong(n.title)} was due on ${date} and is now ${relative}. If the date has moved, change it on the estimate and the reminders will follow it.`
      : n.kind === 'DUE_TODAY'
        ? `${strong(n.title)} is due today, ${date}.`
        : `${strong(n.title)} is ${relative}, on ${date}.`;

  // Who you are to this estimate — and, for an owner getting it by default,
  // what to do so the next one goes to the right person.
  const standing =
    n.recipient === 'custodian'
      ? ' You are its custodian.'
      : ' You own it, and nobody has taken custody of it yet — name a custodian on the estimate and these reminders will go to them instead.';

  return sendEmail({
    to: n.to,
    subject,
    html: renderEmail({
      greeting: greet(n.name),
      headline,
      pill: REMINDER_PILL[n.kind],
      lead: body + standing,
      rows: [
        { k: 'Estimate', v: escapeHtml(n.title) },
        { k: 'Due', v: escapeHtml(date), mono: true },
      ],
      cta: { label: 'Open estimate', url },
      url,
    }),
  });
}

/**
 * Somebody has handed you an estimate.
 *
 * Custody can be assigned by any signed-in user, so without this the first you
 * would hear of it is a deadline reminder for work you did not know was yours.
 * Being made accountable for something deserves a knock on the door.
 */
export function sendCustodyAssignedEmail(n: {
  to: string;
  name?: string | null;
  title: string;
  estimateId: string;
  dueAt: Date | null;
  now: Date;
  assignedBy: string;
}): Promise<{ sent: boolean }> {
  const url = estimateUrl(n.estimateId);
  const deadline = n.dueAt
    ? `It is due ${formatDueDate(n.dueAt)}, ${dueLabel(n.dueAt, n.now)} — you'll get a nudge as that approaches.`
    : 'It has no deadline yet. Set one on the estimate if it needs one, and the reminders will follow it.';

  return sendEmail({
    to: n.to,
    subject: `You're now the custodian of "${n.title}"`,
    html: renderEmail({
      greeting: greet(n.name),
      headline: 'This one is yours now',
      pill: { tone: 'green', label: 'Custodian' },
      lead: `${escapeHtml(n.assignedBy)} has made you the custodian of ${strong(n.title)}. ${deadline}`,
      rows: [
        { k: 'Estimate', v: escapeHtml(n.title) },
        {
          k: 'Due',
          v: n.dueAt ? escapeHtml(formatDueDate(n.dueAt)) : 'Not set',
          mono: n.dueAt !== null,
        },
        { k: 'Handed over by', v: escapeHtml(n.assignedBy) },
      ],
      cta: { label: 'Open estimate', url },
      url,
    }),
  });
}

// ─── the Warm Ledger email surface ────────────────────────────────────────────

/* Lifted from app/globals.css. Literals rather than tokens because email has no
   custom properties — if the app's palette moves, these move with it by hand. */
const CANVAS = '#ebe7dc'; // putty ground
const SURFACE = '#fbfaf6'; // the paper
const SURFACE_2 = '#f4f2ea'; // sunken well
const LINE = '#d6d1c1';
const LINE_SOFT = '#e4e0d3';
const INK = '#23211b';
const INK_2 = '#555146';
const INK_3 = '#615d51';
const INK_4 = '#948f81';
const GREEN = '#2f6b4c';

/* The same three jobs as the app's Pill: green settles, bronze is in flight,
   brick is a problem, neutral is inert. */
type PillTone = 'neutral' | 'green' | 'bronze' | 'brick';
const PILL: Record<PillTone, { bg: string; border: string; fg: string }> = {
  neutral: { bg: SURFACE_2, border: LINE, fg: INK_3 },
  green: { bg: '#e0e8dd', border: '#b9cbb8', fg: GREEN },
  bronze: { bg: '#f2e7ce', border: '#dcc38a', fg: '#8a5f16' },
  brick: { bg: '#f3dfd9', border: '#e0b8ac', fg: '#a93f2e' },
};

const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
/* The app's --font-serif falls back to Georgia, so matching it keeps the
   headline voice recognisable even though Newsreader can't load here. */
const SERIF = `Georgia,'Times New Roman',serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

type MetaRow = { k: string; v: string; mono?: boolean };

/** Emphasis inside a lead paragraph, at the weight the app uses for it. */
function strong(text: string): string {
  return `<strong style="font-weight:600;color:${INK};">${escapeHtml(text)}</strong>`;
}

function renderPill(pill: { tone: PillTone; label: string }): string {
  const c = PILL[pill.tone];
  return `<tr>
              <td style="padding:12px 32px 0;">
                <span style="display:inline-block;background:${c.bg};border:1px solid ${c.border};color:${c.fg};border-radius:999px;padding:4px 11px;font-family:${SANS};font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(pill.label)}</span>
              </td>
            </tr>`;
}

/**
 * The details well — the email's answer to the estimate rail's Details card: a
 * muted structural label, the value under it, hairlines between. It is what
 * makes the mail read like a statement rather than a notification.
 */
function renderRows(rows: MetaRow[]): string {
  const cells = rows
    .map(
      (r, i) => `<tr>
                    <td style="padding:${i === 0 ? '11px' : '10px'} 14px 3px;font-family:${SANS};font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${INK_3};${i === 0 ? '' : `border-top:1px solid ${LINE_SOFT};`}">${escapeHtml(r.k)}</td>
                  </tr>
                  <tr>
                    <td style="padding:0 14px ${i === rows.length - 1 ? '12px' : '4px'};font-family:${r.mono ? MONO : SANS};font-size:14px;color:${INK};">${r.v}</td>
                  </tr>`,
    )
    .join('');
  return `<tr>
              <td style="padding:0 32px 22px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE_2};border:1px solid ${LINE};border-radius:8px;">
                  ${cells}
                </table>
              </td>
            </tr>`;
}

function renderEmail(opts: {
  greeting: string;
  headline: string;
  lead: string;
  cta: { label: string; url: string };
  url: string;
  pill?: { tone: PillTone; label: string };
  rows?: MetaRow[];
}): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light only" />
  </head>
  <body style="margin:0;padding:0;background:${CANVAS};font-family:${SANS};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:${SURFACE};border:1px solid ${LINE};border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0;font-family:${SANS};font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${INK_3};">
                AI Estimation
              </td>
            </tr>
            <tr>
              <td style="padding:10px 32px 0;font-family:${SERIF};font-size:26px;line-height:1.2;color:${INK};">
                ${escapeHtml(opts.headline)}
              </td>
            </tr>
            ${opts.pill ? renderPill(opts.pill) : ''}
            <tr>
              <td style="padding:${opts.pill ? '15px' : '16px'} 32px 0;font-family:${SANS};font-size:14px;color:${INK_2};">${opts.greeting}</td>
            </tr>
            <tr>
              <td style="padding:8px 32px 20px;font-family:${SANS};font-size:14.5px;line-height:1.6;color:${INK_2};">${opts.lead}</td>
            </tr>
            ${opts.rows?.length ? renderRows(opts.rows) : ''}
            <tr>
              <td style="padding:0 32px 26px;">
                <a href="${opts.cta.url}" style="display:inline-block;background:${GREEN};color:${SURFACE};text-decoration:none;font-family:${SANS};font-size:13px;font-weight:600;padding:11px 22px;border-radius:6px;">${escapeHtml(opts.cta.label)}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 26px;">
                <div style="border-top:1px solid ${LINE_SOFT};padding-top:16px;font-family:${SANS};font-size:11.5px;line-height:1.5;color:${INK_4};">
                  Or paste this link into your browser:<br />
                  <a href="${opts.url}" style="color:${INK_3};">${opts.url}</a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ─── templating helpers ───────────────────────────────────────────────────────

function greet(name?: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first ? `Hi ${escapeHtml(first)},` : 'Hi,';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Plain-text fallback, generated rather than written twice — two copies of the
 * same sentence is two places for it to go stale.
 *
 * Block boundaries become newlines before the tags are stripped. Without that
 * step the details well collapses into one run-on line ("Estimate Acme portal
 * Due 12 Sept 2026"), which is precisely the part a text-only reader needs to
 * be able to scan.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(tr|p|div|h[1-6]|td)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    // An inline tag between a word and its full stop leaves a space behind
    // ("the portal ."), which reads like a typo in the text-only version.
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}
