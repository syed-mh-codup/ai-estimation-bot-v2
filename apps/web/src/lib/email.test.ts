import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { emailConfigured, sendEmail, appBaseUrl, estimateUrl } from './email';

const KEYS = ['SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_FROM', 'SMTP_HOST', 'SMTP_PORT', 'APP_URL', 'AUTH_URL'];

describe('email (SMTP integration is optional + best-effort)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reports not configured when SMTP creds are absent', () => {
    expect(emailConfigured()).toBe(false);
  });

  it('reports configured only when user + password + from are all present', () => {
    process.env['SMTP_USER'] = 'resend';
    process.env['SMTP_PASSWORD'] = 're_test';
    expect(emailConfigured()).toBe(false); // still missing EMAIL_FROM
    process.env['EMAIL_FROM'] = 'AI Estimation <a@b.com>';
    expect(emailConfigured()).toBe(true);
  });

  it('sendEmail is a no-op (never throws) when unconfigured', async () => {
    const res = await sendEmail({ to: 'owner@example.com', subject: 'Ready', html: '<p>hi</p>' });
    expect(res).toEqual({ sent: false });
  });

  it('appBaseUrl defaults to localhost and strips trailing slashes', () => {
    expect(appBaseUrl()).toBe('http://localhost:3000');
    process.env['APP_URL'] = 'https://estimates.codup.co/';
    expect(appBaseUrl()).toBe('https://estimates.codup.co');
  });

  it('estimateUrl builds an absolute link to the estimate', () => {
    process.env['APP_URL'] = 'https://estimates.codup.co';
    expect(estimateUrl('abc123')).toBe('https://estimates.codup.co/estimates/abc123');
  });
});
