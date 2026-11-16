import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .analyze()
    .then((r) => r.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`));

test.describe('mobile join', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('join code screen: axe clean, no horizontal scroll, touch-size button', async ({ page }) => {
    await page.goto('/j');
    await expect(page.getByLabel('Event code')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
    const box = await page.getByRole('button', { name: 'Continue' }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test('Italian join screen', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('sg.locale', 'it'));
    await page.goto('/j');
    await expect(page.getByLabel('Codice evento')).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('participant app waiting state is axe clean', async ({ page }) => {
    await page.goto('/e');
    await expect(page.getByRole('heading', { name: 'Participant app' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('public display 1080p', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('stage fills the screen, shows sound opt-in (sound off by default) and is axe clean', async ({
    page,
  }) => {
    await page.goto('/d');
    await expect(page.getByTestId('display-stage')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Sound' })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('sg.prefs') ?? '{"state":{"sound":false}}').state.sound,
      ),
    ).toBe(false);
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'Keep silent' }).click();
    await expect(page.getByRole('region', { name: 'Sound' })).toHaveCount(0);
  });

  test('reduced motion: display shows no animated layers and FX never block input', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      reducedMotion: 'reduce',
      viewport: { width: 1920, height: 1080 },
    });
    const page = await ctx.newPage();
    await page.goto('/d');
    await expect(page.getByTestId('display-stage')).toBeVisible();
    const pe = await page
      .getByTestId('fx-root')
      .evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(pe).toBe('none');
    await page.getByRole('button', { name: 'Keep silent' }).click(); // reachable through the overlay layer
    expect(await axe(page)).toEqual([]);
    await ctx.close();
  });
});
