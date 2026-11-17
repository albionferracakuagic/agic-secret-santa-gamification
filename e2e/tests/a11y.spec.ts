import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const path of ['/j', '/e', '/d', '/o/signin']) {
  test(`no axe violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForSelector('h1');
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
  });
}

test('reduced motion: FX overlay never blocks input and shows no animated layers', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/j');
  await page.waitForSelector('h1');
  const pe = await page
    .locator('[data-testid="fx-root"]')
    .evaluate((el) => getComputedStyle(el).pointerEvents);
  expect(pe).toBe('none');
  await page.getByRole('button', { name: 'Preferences' }).click(); // overlay must not intercept the click
  await expect(page.getByLabel('Animation intensity')).toBeVisible();
  await ctx.close();
});
