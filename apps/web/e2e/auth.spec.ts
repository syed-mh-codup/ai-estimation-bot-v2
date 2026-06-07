import { test, expect } from '@playwright/test';

test.describe('WS2-03: Auth flow', () => {
  test('protected page redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('login page is accessible', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('h1')).toHaveText('AI Estimation');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.locator('input#email')).toBeVisible();
    await expect(page.locator('input#password')).toBeVisible();
  });

  test('bad credentials show error', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#email', 'bad@example.com');
    await page.fill('#password', 'wrongpassword');
    await page.click('button[type="submit"]');
    await expect(page.locator('[role="alert"]')).toBeVisible({ timeout: 5000 });
  });
});
