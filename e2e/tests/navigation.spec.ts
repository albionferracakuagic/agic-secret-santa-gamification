import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { displayState, json, meOf, participantState } from './support/fixtures';

test('mobile navigation reflows and uses the selected language', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('**/api/organizer/me', (r) =>
    r.fulfill(json({ error: { code: 'unauthenticated' } }, 401)),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByLabel('Language').selectOption('it');
  const nav = page.getByRole('navigation', { name: 'Navigazione principale' });
  await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Crea evento' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
  await nav.getByRole('link', { name: "Unisciti all'evento" }).click();
  await expect(nav.getByRole('link', { name: "Unisciti all'evento" })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { name: "Unisciti all'evento" })).toBeVisible();
});

test('organizer destinations stay off guest routes, even in the same browser session', async ({
  page,
}) => {
  await page.route('**/api/organizer/me', (r) =>
    r.fulfill(json({ userId: 'u1', email: 'o@example.test', isPlatformAdmin: false })),
  );
  await page.route('**/api/events', (r) =>
    r.fulfill(json({ events: [{ id: 'e1', name: 'Office Party', phase: 'preparation' }] })),
  );
  await page.route('**/api/events/e1/organizer-state', (r) =>
    r.fulfill(
      json({
        role: 'organizer_masked',
        eventState: {
          ...displayState('preparation'),
          organizer: { roster: { unclaimed: 0, pending: 0, active: 0, removed: 0 }, warnings: [] },
        },
      }),
    ),
  );
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('link', { name: 'Dashboard' }).click();
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('link', { name: 'Open console' }).click();
  const details = page.getByRole('link', { name: 'Event details' });
  await expect(details).toHaveAttribute('aria-current', 'page');
  await expect(details).toHaveAttribute('href', '/o/events/e1');
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await nav.getByRole('link', { name: 'Join event' }).click();
  await expect(page.getByRole('heading', { name: 'Join event' })).toBeVisible();
  await expect(page.locator('a[href^="/o"]')).toHaveCount(0);
  await page.route('**/api/me/state', (r) =>
    r.fulfill(json(participantState('registration', meOf('p1', 'Anna')))),
  );
  await page.goto('/e');
  await expect(page.getByRole('heading', { name: 'Participant app' })).toBeVisible();
  await expect(page.locator('a[href^="/o"]')).toHaveCount(0);
  await page.goto('/d');
  await expect(page.getByRole('heading', { name: 'Public display' })).toBeVisible();
  await expect(nav).toHaveCount(0);
});
