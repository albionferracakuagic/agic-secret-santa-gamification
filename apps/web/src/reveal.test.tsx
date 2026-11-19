import { act, fireEvent, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneSchema } from '@santa/contracts';
import i18n from './i18n';
import { usePrefs } from './prefs/store';
import { ME, setup } from './test-utils';

const person = (id: string, name: string) => ({
  participantId: id,
  displayName: name,
  avatar: 'elf',
});
const core = (id: string, recipient: ReturnType<typeof person> | null) => ({
  giftId: id,
  alias: `Gift ${id}`,
  giftName: `Item ${id}`,
  photoUrl: null,
  recipient,
});
const pair = (id: string, giver: string, recipient: string) => ({
  ...core(id, person(`r${id}`, recipient)),
  giver: person(`g${id}`, giver),
});
const revealScene = (over: Record<string, unknown>) =>
  SceneSchema.parse({
    scene: 'reveal',
    reveal: {
      current: null,
      countdownEndsAt: null,
      revealedCount: 0,
      total: 3,
      revealed: [],
      ...over,
    },
  });
const drumroll = (recipient = person('rA', 'Ada')) => ({
  current: { ...core('1', recipient), stage: 'drumroll', giver: null },
  countdownEndsAt: new Date(Date.now() + 8000).toISOString(),
});
const revealedNow = (recipient = person('rA', 'Ada')) => ({
  current: { ...core('1', recipient), stage: 'revealed', giver: person('gX', 'Zed') },
  countdownEndsAt: null,
  revealedCount: 1,
});
const ds = {
  role: 'display',
  eventId: 'e1',
  name: 'Office Party',
  description: null,
  theme: 'xmas',
  startsAt: '2026-12-20T18:00:00Z',
  timezone: 'UTC',
  phase: 'reveal',
  paused: false,
  votingEndsAt: null,
  counts: { participants: 3, giftsRegistered: 3 },
};
const pes = { ...ds, role: 'participant', me: ME };

beforeEach(async () => {
  sessionStorage.clear();
  await i18n.changeLanguage('en');
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' });
});
afterEach(() => vi.useRealTimers());

describe('display RevealStage', () => {
  it('drumroll: countdown + recipient, never any giver text', async () => {
    const t = setup('/d');
    t.snapshot('pub', { eventState: ds, scene: revealScene(drumroll()) });
    expect(await screen.findByTestId('reveal-drumroll')).toBeTruthy();
    expect(screen.getByTestId('reveal-countdown').textContent).toMatch(/^[5-8]$/);
    expect(screen.getByText('Gift for Ada')).toBeTruthy();
    expect(screen.getByTestId('reveal-live').textContent).toBe("Drumroll for Ada's gift");
    expect(screen.queryByText(/Secret Santa:/)).toBeNull();
    expect(screen.getByTestId('reveal-stage').textContent).not.toContain('Zed');
  });

  it('revealed: shows giver, announces, animates by default', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds,
      scene: revealScene({
        ...revealedNow(),
        current: {
          ...revealedNow().current,
          photoUrl: '/media/gifts/e1/item.jpg?exp=10&sig=test',
        },
        revealed: [pair('1', 'Zed', 'Ada')],
      }),
    });
    expect((await screen.findByTestId('reveal-giver')).textContent).toContain('Secret Santa: Zed');
    expect(screen.getByTestId('reveal-live').textContent).toBe(
      'Revealed: Zed was Secret Santa of Ada',
    );
    expect(screen.getByTestId('reveal-progress').getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByTestId('reveal-strip').textContent).toContain('Zed → Ada');
    expect(document.querySelector('.reveal-flip')).toBeTruthy();
    expect(screen.getByTestId('reveal-gift-photo').getAttribute('src')).toBe(
      new URL('/media/gifts/e1/item.jpg?exp=10&sig=test', window.location.origin).href,
    );
  });

  it('reduced motion: same content, no animation classes', async () => {
    usePrefs.setState({ reducedMotion: 'on' });
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds,
      scene: revealScene({ ...revealedNow(), revealed: [pair('1', 'Zed', 'Ada')] }),
    });
    expect((await screen.findByTestId('reveal-giver')).textContent).toContain('Zed');
    expect(document.querySelector('.reveal-flip, .reveal-zoom, .reveal-pulse')).toBeNull();
  });

  it('finale: grid of all pairs + recap hint, no current gift', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds,
      scene: revealScene({
        revealedCount: 3,
        revealed: [pair('1', 'Zed', 'Ada'), pair('2', 'Yan', 'Bo'), pair('3', 'Xia', 'Cy')],
      }),
    });
    const grid = await screen.findByTestId('reveal-finale-grid');
    expect(grid.querySelectorAll('li')).toHaveLength(3);
    expect(grid.textContent).toContain('Yan → Bo');
    expect(screen.getByTestId('reveal-recap-hint').textContent).toContain('Recap on your phone');
    expect(screen.getByTestId('reveal-recap-hint').textContent).toContain('/e/recap');
  });

  it('is axe clean', async () => {
    const t = setup('/d');
    t.snapshot('pub', { eventState: ds, scene: revealScene(drumroll()) });
    await screen.findByTestId('reveal-drumroll');
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations).toEqual([]);
  });
});

describe('participant personal reveal', () => {
  it('my gift drumroll: banner only, no overlay, no giver', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: pes });
    t.snapshot('pub', { scene: revealScene(drumroll(person('p1', 'Anna'))) });
    expect((await screen.findByTestId('my-drumroll')).textContent).toContain(
      'your Secret Santa is about to be revealed',
    );
    expect(screen.queryByTestId('reveal-overlay')).toBeNull();
    expect(screen.queryByText(/Zed/)).toBeNull();
  });

  it('my gift revealed: overlay after suspense, dismiss persists per gift', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: pes });
    t.snapshot('pub', { scene: revealScene(revealedNow(person('p1', 'Anna'))) });
    const dlg = await screen.findByTestId('reveal-overlay');
    expect(dlg.textContent).toContain('Your Secret Santa was…');
    expect(await screen.findByTestId('reveal-overlay-giver', {}, { timeout: 3000 })).toBeTruthy();
    expect(dlg.textContent).toContain('Zed');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByTestId('reveal-overlay')).toBeNull();
    expect(sessionStorage.getItem('reveal-dismissed:1')).toBe('1');
  });

  it('reduced motion: no suspense beat', async () => {
    usePrefs.setState({ reducedMotion: 'on' });
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: pes });
    t.snapshot('pub', { scene: revealScene(revealedNow(person('p1', 'Anna'))) });
    expect(await screen.findByTestId('reveal-overlay-giver')).toBeTruthy();
  });

  it('already dismissed gift: no overlay', async () => {
    sessionStorage.setItem('reveal-dismissed:1', '1');
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: pes });
    t.snapshot('pub', { scene: revealScene(revealedNow(person('p1', 'Anna'))) });
    await act(async () => undefined);
    expect(screen.queryByTestId('reveal-overlay')).toBeNull();
  });

  it("someone else's reveal: toast only, no overlay", async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: pes });
    t.snapshot('pub', { scene: revealScene(revealedNow(person('p7', 'Bea'))) });
    expect((await screen.findByTestId('reveal-toast')).textContent).toBe(
      "Bea's Secret Santa was Zed",
    );
    expect(screen.queryByTestId('reveal-overlay')).toBeNull();
  });

  it('finale: recap link', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: pes });
    t.snapshot('pub', {
      scene: revealScene({ revealedCount: 3, revealed: [pair('1', 'Zed', 'Ada')] }),
    });
    const link = await screen.findByTestId('reveal-recap-link');
    expect(link.getAttribute('href')).toBe('/e/recap');
  });

  it('overlay is axe clean', async () => {
    usePrefs.setState({ reducedMotion: 'on' });
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: pes });
    t.snapshot('pub', { scene: revealScene(revealedNow(person('p1', 'Anna'))) });
    await screen.findByTestId('reveal-overlay-giver');
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations).toEqual([]);
  });
});
