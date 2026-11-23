import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
} as const;
const pes = { ...ds, role: 'participant', me: ME } as const;

beforeEach(async () => {
  sessionStorage.clear();
  await i18n.changeLanguage('en');
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('display RevealStage', () => {
  it('drumroll: countdown without either name in the DOM or live text', async () => {
    const t = setup('/d');
    t.snapshot('pub', { eventState: ds, scene: revealScene(drumroll()) });
    expect(await screen.findByTestId('reveal-drumroll')).toBeTruthy();
    expect(screen.getByTestId('reveal-countdown').textContent).toMatch(/^[5-8]$/);
    expect(screen.getByText('A gift is about to be revealed')).toBeTruthy();
    expect(screen.getByTestId('reveal-live').textContent).toBe('Drumroll for the next gift');
    expect(screen.getByTestId('reveal-stage').textContent).not.toContain('Ada');
    expect(screen.queryByText(/Secret Santa:/)).toBeNull();
    expect(screen.getByTestId('reveal-stage').textContent).not.toContain('Zed');
  });

  describe('reveal show pilot', () => {
    const round = (n: number) => ({
      status: 'open',
      round: n,
      endsAt: new Date(Date.now() + 10_000).toISOString(),
      result: null,
    });
    const response = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    const count = () => screen.getByTestId('reveal-tree-count');

    it('lights only the cumulative display total and plays the live winner once, not on snapshot', async () => {
      const t = setup('/d');
      const first = round(1);
      const choice = (r: ReturnType<typeof round>, result: string) => ({
        ...r,
        status: 'closed',
        result,
      });
      const frame = (lights: number, publicChoice: unknown) =>
        revealScene({ ...revealedNow(), lights, choice: publicChoice });
      const delta = (cursor: number, scene: ReturnType<typeof revealScene>) =>
        act(() =>
          t.sock.fire('delta', { stream: 'pub', cursor, surface: 'scene', payload: scene }),
        );
      const flakes = () =>
        [...document.querySelectorAll('.fx-float')].filter((el) => el.textContent === '❄️');

      t.snapshot('pub', { eventState: ds, scene: frame(6, first) });
      await screen.findByTestId('reveal-choice-countdown');
      expect(count().textContent).toBe('6 lights lit');
      expect(document.querySelectorAll('.reveal-ornament-on')).toHaveLength(0);
      expect(screen.queryByTestId('reveal-choice-result')).toBeNull();
      delta(2, frame(8, first));
      expect(count().textContent).toBe('8 lights lit');
      expect(document.querySelectorAll('.reveal-ornament-on')).toHaveLength(2);
      delta(3, frame(8, choice(first, 'snowstorm')));
      expect(screen.getByTestId('reveal-choice-result').textContent).toBe('Snowstorm wins!');
      const played = flakes().length;
      expect(played).toBeGreaterThan(0);
      delta(4, frame(9, choice(first, 'snowstorm')));
      expect(flakes()).toHaveLength(played);
      const second = round(2);
      delta(5, frame(9, second));
      act(() => {
        t.sock.fire('disconnect');
        t.sock.fire('connect');
        t.sock.fire('snapshot', {
          stream: 'pub',
          cursor: 9,
          data: { eventState: ds, scene: frame(11, choice(second, 'snowstorm')) },
        });
      });
      expect(screen.getByTestId('reveal-choice-result').textContent).toBe('Snowstorm wins!');
      expect(flakes()).toHaveLength(played);
      expect(document.querySelectorAll('.reveal-ornament-on')).toHaveLength(0);
    });

    it('hydrates private selections, confirms one light per gift and submits one final effect choice', async () => {
      const open = round(1);
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/me/reveal/show')
          return response({ litGiftIds: [], choice: { round: 1, myChoice: null } });
        if (url.endsWith('/light')) return response({ giftId: '1', lit: true, lights: 13 });
        if (url === '/api/me/reveal/choice') return response(JSON.parse(String(init?.body)));
        return response({}, 404);
      });
      vi.stubGlobal('fetch', fetch);
      const t = setup('/e', { state: async () => pes });
      t.snapshot('pub', { scene: revealScene({ ...revealedNow(), lights: 12, choice: open }) });
      const light = await screen.findByRole('button', { name: 'Light the tree' });
      act(() => {
        fireEvent.click(light);
        fireEvent.click(light);
      });
      expect(await screen.findByText('Your light is on the tree!')).toBeTruthy();
      expect(fetch.mock.calls.filter(([url]) => url.endsWith('/light'))).toHaveLength(1);
      expect(screen.queryByTestId('reveal-tree-count')).toBeNull(); // response total is not rendered on the phone

      const snow = screen.getByRole('button', { name: 'Snowstorm' });
      const bells = screen.getByRole('button', { name: 'Sleigh Bells' });
      act(() => {
        fireEvent.click(snow);
        fireEvent.click(bells);
      });
      expect(await screen.findByText('Vote recorded!')).toBeTruthy();
      expect(snow.getAttribute('aria-pressed')).toBe('true');
      expect(bells.getAttribute('aria-disabled')).toBe('true');
      const posts = fetch.mock.calls.filter(([url]) => url === '/api/me/reveal/choice');
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({ round: 1, choice: 'snowstorm' });
      expect(screen.queryByTestId('reveal-choice-result')).toBeNull();
    });

    it('uses the server clock, keeps controls out of the drumroll, and leaves the reduced-motion outcome visible', async () => {
      usePrefs.setState({ reducedMotion: 'on', sound: true });
      const open = round(1);
      const fetch = vi.fn(async (url: string) =>
        url === '/api/me/reveal/show'
          ? response({ litGiftIds: [], choice: { round: 1, myChoice: null } })
          : response({ error: { code: 'round_not_open' } }, 409),
      );
      vi.stubGlobal('fetch', fetch);
      const t = setup('/e');
      t.snapshot('p:p1', { eventState: pes });
      const frame = (choice: unknown) => revealScene({ ...drumroll(), lights: 17, choice });
      t.snapshot('pub', { scene: frame(open) });
      const snow = await screen.findByRole('button', { name: 'Snowstorm' });
      expect(screen.queryByTestId('reveal-light')).toBeNull();
      fireEvent.click(snow);
      expect(await screen.findByText('This round is no longer accepting votes.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Snowstorm' })).toBeNull();
      act(() => t.sock.fire('time.sync', { serverTime: Date.now() + 12_000 }));
      expect(await screen.findByText('Voting time is up. Waiting for the result…')).toBeTruthy();
      expect(screen.queryByTestId('reveal-choice-result')).toBeNull();
      act(() =>
        t.sock.fire('delta', {
          stream: 'pub',
          cursor: 2,
          surface: 'scene',
          payload: frame({ ...open, status: 'closed', result: 'sleigh_bells' }),
        }),
      );
      expect(screen.getByTestId('reveal-choice-result').textContent).toBe('Sleigh Bells wins!');
      expect(document.querySelector('.fx-float')).toBeNull();
      expect(fetch.mock.calls.filter(([url]) => url === '/api/me/reveal/choice')).toHaveLength(1);
    });

    it('restores a previously lit gift inside the personal dialog with existing reactions', async () => {
      usePrefs.setState({ reducedMotion: 'on' });
      const fetch = vi.fn(async () => response({ litGiftIds: ['1'], choice: null }));
      vi.stubGlobal('fetch', fetch);
      const t = setup('/e');
      t.snapshot('p:p1', { eventState: pes });
      t.snapshot('pub', {
        scene: revealScene({ ...revealedNow(person('p1', 'Anna')), lights: 1, choice: null }),
      });
      const dialog = within(await screen.findByRole('dialog'));
      const light = await dialog.findByRole('button', { name: 'Light the tree' });
      expect(light.getAttribute('aria-disabled')).toBe('true');
      expect(dialog.getByTestId('reveal-react-love')).toBeTruthy();
      fireEvent.click(light);
      await waitFor(() => expect(fetch.mock.calls).toHaveLength(1));
      const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
      expect(r.violations).toEqual([]);
    });
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
    expect((await screen.findByTestId('reveal-giver')).textContent).toContain('Zed → Ada');
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

  it('gives a neutral giver-only reveal if the projection omits the recipient', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds,
      scene: revealScene({
        ...revealedNow(),
        current: { ...revealedNow().current, recipient: null },
        revealed: [{ ...pair('1', 'Zed', 'Ada'), recipient: null }],
      }),
    });
    expect((await screen.findByTestId('reveal-giver')).textContent).toContain('Secret Santa: Zed');
    expect(screen.getByTestId('reveal-giver').textContent).not.toContain('→');
    expect(screen.getByTestId('reveal-strip').textContent).toContain('Secret Santa: Zed');
    expect(screen.getByTestId('reveal-strip').textContent).not.toContain('→');
    expect(screen.getByTestId('reveal-live').textContent).toBe(
      'Revealed: Zed was the Secret Santa of Gift 1',
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
    expect(screen.getByTestId('reveal-personal').textContent).not.toContain('Anna');
  });

  it('my gift revealed: overlay after suspense, dismiss persists per gift', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: pes });
    t.snapshot('pub', { scene: revealScene(revealedNow(person('p1', 'Anna'))) });
    const dlg = await screen.findByTestId('reveal-overlay');
    expect(dlg.textContent).toContain('Your Secret Santa was…');
    expect(dlg.textContent).not.toContain('Anna');
    expect(dlg.textContent).not.toContain('Zed');
    expect(await screen.findByTestId('reveal-overlay-giver', {}, { timeout: 3000 })).toBeTruthy();
    expect(dlg.textContent).toContain('Zed → Anna');
    expect(dlg.textContent).toContain('Revealed: Zed was Secret Santa of Anna');
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

  it('keeps keyboard focus in the reveal and restores it on Escape', async () => {
    usePrefs.setState({ reducedMotion: 'on' });
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: pes });
    await screen.findByRole('heading', { name: 'Participant app' });
    const home = screen.getByRole('link', { name: 'Home' });
    home.focus();
    t.snapshot('pub', { scene: revealScene(revealedNow(person('p1', 'Anna'))) });
    const end = await screen.findByRole('button', { name: 'Continue' });
    expect(document.activeElement).toBe(end);
    fireEvent.keyDown(end, { key: 'Tab' });
    const first = screen.getByTestId('reveal-overlay-giver').querySelector('button')!;
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(end);
    fireEvent.keyDown(end, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(home);
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
    const toast = await screen.findByTestId('reveal-toast');
    expect(toast.textContent).toContain('Zed → Bea');
    expect(toast.textContent).toContain('Revealed: Zed was Secret Santa of Bea');
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
