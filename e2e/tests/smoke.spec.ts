import { expect, test } from '@playwright/test';

test('web loads and shows join placeholder', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/j$/);
  await expect(page.getByRole('heading', { name: 'Join event' })).toBeVisible();
});
