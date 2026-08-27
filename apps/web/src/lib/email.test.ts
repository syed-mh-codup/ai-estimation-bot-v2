import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sendEmail, appBaseUrl, estimateUrl } from './email';

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

  // `emailConfigured()` used to be asserted here directly. It was exported for
  // no caller, and it disagreed with the gate that actually runs: it required
  // EMAIL_FROM, while getTransport() checks only user + password. The behaviour
  // worth pinning is the one below — unconfigured must degrade, never throw.
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
