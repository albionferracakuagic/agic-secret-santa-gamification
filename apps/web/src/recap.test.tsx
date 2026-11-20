import { screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from './i18n';
import { usePrefs } from './prefs/store';
import { ME, setup } from './test-utils';
import { RECAP_PATH } from './routes/recap';

const es = (phase: string, over: Record<string, unknown> = {}) => ({
  role: 'participant',
  eventId: 'e1',
  name: 'Office Party',
  description: null,
  theme: 'xmas',
  startsAt: '2026-12-20T18:00:00Z',
  timezone: 'UTC',
  phase,
  paused: false,
  votingEndsAt: null,
  counts: { participants: 7, giftsRegistered: 6 },
  me: ME,
  ...over,
});
const person = (id: string, name: string) => ({
  participantId: id,
  displayName: name,
  avatar: 'elf',
});
const gift = (id: string, name: string) => ({
  giftId: id,
  alias: `Gift ${id}`,
  name,
  description: null,
  photoUrl: null,
});
const gallery = {
  mode: 'gallery',
  currentGiftId: null,
  gifts: [
    { ...gift('g1', 'Warm scarf'), status: 'revealed', giver: person('p2', 'Bruno') },
    { ...gift('g2', 'Tea set'), status: 'opened' },
  ],
};
const board = (key: string, name: string, entryId: string) => ({
  boardKey: key,
  name: { en: name, it: name },
  state: 'live',
  message: null,
  entries: [{ entryId, label: `Gift ${entryId}`, rank: 1, tied: false }],
});
const boards = {
  boards: [board('funniest', 'Funniest', 'g1'), board('cosiest', 'Cosiest', 'g2')],
};

beforeEach(async () => {
  await i18n.changeLanguage('en');
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' });
});

describe('recap page', () => {
  it('stays locked with a friendly message before the awards', async () => {
    const t = setup(RECAP_PATH);
    t.snapshot('p:p1', { eventState: es('voting') });
    expect((await screen.findByTestId('recap-locked')).textContent).toContain(
      'The recap is available after the show.',
    );
    expect(screen.queryByTestId('recap-winners')).toBeNull();
    expect(screen.queryByTestId('recap-stats')).toBeNull();
  });

  it('shows published winners, revealed givers only, achievements and counts during the awards', async () => {
    const t = setup(
      RECAP_PATH,
      {},
      {
        myAchievements: async () => ({
          achievements: [{ key: 'early_elf', unlockedAt: '2026-12-20T19:00:00Z' }],
        }),
      },
    );
    t.snapshot('p:p1', { eventState: es('awards', { votedCount: 5 }) });
    t.snapshot('pub', { giftList: gallery, leaderboards: boards });
    const winners = await screen.findByTestId('recap-winners');
    const items = within(winners).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Funniest');
    expect(items[0]?.textContent).toContain('Warm scarf');
    expect(items[0]?.textContent).toContain('Bruno');
    // FR-046 / ADR-0003: the opened-but-unrevealed winner never shows a giver.
    expect(items[1]?.textContent).toContain('Tea set');
    expect(items[1]?.textContent).not.toContain('From');
    const stats = screen.getByTestId('recap-stats');
    expect(stats.textContent).toContain('Players7');
    expect(stats.textContent).toContain('Voted5');
    expect(await screen.findByTestId('recap-achievements')).toBeTruthy();
    expect(within(screen.getByTestId('recap-gallery')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('omits counters the server did not send', async () => {
    const t = setup(RECAP_PATH);
    t.snapshot('p:p1', { eventState: es('awards') });
    t.snapshot('pub', { giftList: { mode: 'count_only', count: 6 } });
    const stats = await screen.findByTestId('recap-stats');
    expect(stats.textContent).not.toContain('Voted');
    expect(screen.queryByTestId('recap-gallery')).toBeNull();
  });

  it('never names my Secret Santa while my gift is still in the drumroll', async () => {
    const t = setup(RECAP_PATH);
    t.snapshot('p:p1', { eventState: es('awards') });
    t.snapshot('pub', {
      scene: {
        scene: 'reveal',
        reveal: {
          current: {
            giftId: 'g9',
            alias: 'Gift 9',
            giftName: 'Socks',
            photoUrl: null,
            recipient: person('p1', 'Anna'),
            stage: 'drumroll',
            giver: null,
          },
          countdownEndsAt: null,
          revealedCount: 0,
          total: 6,
          revealed: [],
        },
      },
    });
    await screen.findByTestId('recap-mine');
    expect(screen.queryByTestId('recap-my-santa')).toBeNull();
  });

  it('names my Secret Santa once the pair is revealed', async () => {
    const t = setup(RECAP_PATH);
    t.snapshot('p:p1', { eventState: es('awards') });
    t.snapshot('pub', {
      scene: {
        scene: 'reveal',
        reveal: {
          current: null,
          countdownEndsAt: null,
          revealedCount: 1,
          total: 6,
          revealed: [
            {
              giftId: 'g9',
              alias: 'Gift 9',
              giftName: 'Socks',
              photoUrl: null,
              recipient: person('p1', 'Anna'),
              giver: person('p3', 'Carla'),
            },
          ],
        },
      },
    });
    expect((await screen.findByTestId('recap-my-santa')).textContent).toContain('Carla');
  });

  it('uses the completed-event archive for winners and the champion', async () => {
    const t = setup(
      RECAP_PATH,
      {},
      {},
      {},
      {
        myHistory: async () => ({
          enabled: true,
          archive: {
            eventId: 'e1',
            name: 'Office Party',
            year: 2026,
            completedAt: '2026-12-21T00:00:00Z',
            participants: [],
            winners: [
              {
                boardKey: 'grand',
                name: { en: 'Best gift', it: 'Miglior regalo' },
                grand: true,
                giftLabel: 'Gift 4',
                giftName: 'Board game',
                photoUrl: null,
                giver: person('p4', 'Dario'),
              },
            ],
            achievements: [],
            games: [],
            champion: person('p5', 'Elena'),
            expiresAt: '2028-12-21T00:00:00Z',
          },
        }),
      },
    );
    t.snapshot('p:p1', { eventState: es('completed') });
    expect((await screen.findByTestId('recap-champion')).textContent).toContain('Elena');
    const winners = await screen.findByTestId('recap-winners');
    expect(winners.textContent).toContain('Best gift');
    expect(winners.textContent).toContain('Dario');
  });

  it('a11y: recap has no axe violations', async () => {
    const t = setup(RECAP_PATH);
    t.snapshot('p:p1', { eventState: es('awards', { votedCount: 5 }) });
    t.snapshot('pub', { giftList: gallery, leaderboards: boards });
    await screen.findByTestId('recap-winners');
    const res = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  it('keeps the assigned recipient out of the recap DOM until revealed', async () => {
    const t = setup(
      RECAP_PATH,
      {},
      {
        assignment: async () => ({
          recipient: person('p7', 'Giulia'),
        }),
      },
    );
    t.snapshot('p:p1', { eventState: es('awards') });
    expect(await screen.findByRole('button', { name: 'Reveal recipient' })).toBeTruthy();
    expect(screen.queryByText('Giulia')).toBeNull();
  });
});

describe('participant recap entry point', () => {
  it('links to the recap only from the awards on', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: es('reveal') });
    await screen.findByText('Office Party');
    expect(screen.queryByTestId('recap-link')).toBeNull();
    t.snapshot('p:p1', { eventState: es('awards') });
    expect((await screen.findByTestId('recap-link')).getAttribute('href')).toBe(RECAP_PATH);
  });
});
