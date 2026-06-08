import { test, expect } from '@playwright/test';

test.describe('WS28-03: health check', () => {
  test('GET /api/health is public and reports DB + env status', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('up');
    expect(body.env.ok).toBe(true);
  });
});
