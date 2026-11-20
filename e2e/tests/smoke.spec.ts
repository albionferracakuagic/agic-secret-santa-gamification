import { expect, test } from '@playwright/test';

test('home offers create and join, and the Join link navigates with the keyboard', async ({
  page,
}) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main').getByRole('link', { name: 'Create event' })).toHaveAttribute(
    'href',
    '/create',
  );
  await expect(page.getByRole('main').getByRole('link', { name: 'Join event' })).toBeVisible();
  const join = nav.getByRole('link', { name: 'Join event' });
  await nav.getByRole('link', { name: 'Home' }).focus();
  await page.keyboard.press('Tab');
  await expect(join).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/j$/);
  await expect(page.getByRole('heading', { name: 'Join event' })).toBeVisible();
  await expect(join).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main')).toBeFocused();
});
