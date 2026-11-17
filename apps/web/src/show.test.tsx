import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncementSchema, CeremonyViewSchema, SceneSchema } from '@santa/contracts';
import i18n from './i18n';
import { usePrefs } from './prefs/store';
import { emitFx } from './fx/bus';
import { ME, mountConsole, setup } from './test-utils';

vi.mock('./fx/bus', () => ({ emitFx: vi.fn(), setAmbient: vi.fn(), setFxEngine: vi.fn() }));

const person = (id: string, name: string) => ({
  participantId: id,
  displayName: name,
  avatar: 'elf',
});
const NAME = { en: 'Funniest gift', it: 'Regalo più divertente' };
const view = (index: number, step: unknown, status = 'running', endsAt: string | null = null) =>
  CeremonyViewSchema.parse({ status, index, total: 9, endsAt, step });
const ceremony = (v: unknown) => SceneSchema.parse({ scene: 'ceremony', ceremony: v });
const ds = {
  role: 'display',
  eventId: 'e1',
  name: 'Office Party',
  description: null,
  theme: 'xmas',
  startsAt: '2026-12-20T18:00:00Z',
  timezone: 'UTC',
  phase: 'awards',
  paused: false,
  votingEndsAt: null,
  counts: { participants: 12, giftsRegistered: 9 },
};

beforeEach(async () => {
  vi.mocked(emitFx).mockClear();
  await i18n.changeLanguage('en');
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' });
});

const push = (t: ReturnType<typeof setup>, scene: unknown, cursor: number) =>
  act(() => {
    t.sock.fire('delta', { stream: 'pub', cursor, surface: 'scene', payload: scene });
  });

describe('ceremony on the display', () => {
  it('renders each step type; unsafe categories get a neutral skip with no promise of a reveal', async () => {
    const t = setup('/d');
    t.snapshot('pub', { eventState: ds, scene: ceremony(view(0, { type: 'intro' })) });
    expect(await screen.findByText('The awards ceremony begins!')).toBeTruthy();

    push(
      t,
      ceremony(view(1, { type: 'category', boardKey: 'funniest', name: NAME, grand: false })),
      2,
    );
    expect(await screen.findByText('Funniest gift')).toBeTruthy();

    push(t, ceremony(view(2, { type: 'category_skipped', boardKey: 'cosy', name: NAME })), 3);
    expect(await screen.findByText(/Christmas magic is in the air/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/winner|later|soon|score/i);

    push(
      t,
      ceremony(
        view(3, {
          type: 'nominees',
          boardKey: 'funniest',
          entries: [
            { entryId: 'g1', label: 'Gift 7' },
            { entryId: 'g2', label: 'Gift 3' },
          ],
        }),
      ),
      4,
    );
    expect(
      (await screen.findByText('The nominees are…')).closest('section')!.textContent,
    ).toContain('Gift 7');

    push(
      t,
      ceremony(
        view(
          4,
          { type: 'countdown', seconds: 5 },
          'running',
          new Date(Date.now() + 5000).toISOString(),
        ),
      ),
      5,
    );
    expect((await screen.findByRole('timer')).textContent).toMatch(/^00:0[3-5]$/);

    push(
      t,
      ceremony(
        view(5, {
          type: 'winner',
          boardKey: 'funniest',
          name: NAME,
          grand: false,
          tied: false,
          winners: [{ entryId: 'g1', label: 'Gift 7', giver: person('p3', 'Marta') }],
        }),
      ),
      6,
    );
    const winners = await screen.findByTestId('ceremony-winners');
    expect(winners.textContent).toContain('Gift 7');
    expect(winners.textContent).toContain('Marta');
    expect(emitFx).toHaveBeenCalledWith('correct_guess');

    push(
      t,
      ceremony(
        view(6, {
          type: 'achievement',
          achievementKey: 'comedy_santa',
          recipients: [person('p3', 'Marta')],
        }),
      ),
      7,
    );
    expect(await screen.findByText('Comedy Santa')).toBeTruthy();
    expect(emitFx).toHaveBeenCalledWith('achievement_earned');

    push(t, ceremony(view(7, { type: 'spirit', recipientCount: 4 })), 8);
    expect(await screen.findByText('4 people joined in on every activity!')).toBeTruthy();
  });

  it('Grand Champion: golden fireworks cue, champion shown; paused banner; Italian text', async () => {
    const t = setup('/d');
    t.snapshot('pub', { eventState: ds, scene: ceremony(view(0, { type: 'outro' })) });
    await screen.findByText('Thank you all, merry Christmas!');
    push(t, ceremony(view(1, { type: 'champion', person: person('p9', 'Elena') })), 2);
    expect(await screen.findByText('Christmas Champion')).toBeTruthy();
    expect(screen.getByText('Elena')).toBeTruthy();
    expect(emitFx).toHaveBeenCalledWith('grand_winner');

    push(
      t,
      ceremony(
        view(2, {
          type: 'winner',
          boardKey: 'best_overall',
          name: NAME,
          grand: true,
          tied: true,
          winners: [{ entryId: 'g1', label: 'Gift 7', giver: person('p3', 'Marta') }],
        }),
      ),
      3,
    );
    expect(await screen.findByText('Grand Champion: Funniest gift')).toBeTruthy();
    expect(screen.getByText('A shared win!')).toBeTruthy();
    expect(emitFx).toHaveBeenCalledWith('grand_winner');

    push(t, ceremony(view(3, { type: 'intro' }, 'paused')), 4);
    expect(await screen.findByText('The ceremony is paused for a moment.')).toBeTruthy();

    await i18n.changeLanguage('it');
    push(
      t,
      ceremony(view(4, { type: 'category', boardKey: 'funniest', name: NAME, grand: false })),
      5,
    );
    expect(await screen.findByText('Regalo più divertente')).toBeTruthy();
  });

  it('a11y: ceremony scene has no axe violations; reduced motion keeps the text', async () => {
    usePrefs.setState({ reducedMotion: 'on' });
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds,
      scene: ceremony(
        view(1, { type: 'category', boardKey: 'funniest', name: NAME, grand: false }),
      ),
    });
    await screen.findByText('Funniest gift');
    const res = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('ceremony on the participant app', () => {
  it('shows the same show in a compact view', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', {
      eventState: { ...ds, role: 'participant', me: ME },
    });
    t.snapshot('pub', {
      scene: ceremony(
        view(1, { type: 'category', boardKey: 'funniest', name: NAME, grand: false }),
      ),
    });
    expect(await screen.findByTestId('ceremony-scene')).toBeTruthy();
    expect(screen.getByText('Funniest gift')).toBeTruthy();
  });
});

describe('organizer ceremony controls', () => {
  const state = (over: Record<string, unknown>) => ({
    status: 'idle',
    index: 0,
    total: 9,
    canStart: true,
    blockers: [],
    outline: ['intro', 'category', 'winner'],
    pendingDecisions: [],
    ...over,
  });

  it('start -> next uses fromIndex -> pause/resume -> cancel -> restart', async () => {
    let cur = state({});
    const ceremonyAct = vi.fn(async (_e: string, a: string) => {
      cur = state({
        status: a === 'pause' ? 'paused' : a === 'cancel' ? 'cancelled' : 'running',
        index: 1,
      });
      return cur as never;
    });
    const ceremonyNext = vi.fn(
      async (_e: string, i: number) => (cur = state({ status: 'running', index: i + 1 })) as never,
    );
    mountConsole({
      phase: 'awards',
      admin: { ceremony: async () => cur as never, ceremonyAct, ceremonyNext },
    });
    expect(await screen.findByTestId('ceremony-outline')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start ceremony' }));
    await waitFor(() => expect(ceremonyAct).toHaveBeenCalledWith('e1', 'start'));
    fireEvent.click(await screen.findByRole('button', { name: 'Next step' }));
    await waitFor(() => expect(ceremonyNext).toHaveBeenCalledWith('e1', 1));
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(ceremonyAct).toHaveBeenCalledWith('e1', 'pause'));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(ceremonyAct).toHaveBeenCalledWith('e1', 'resume'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel ceremony' }));
    await waitFor(() => expect(ceremonyAct).toHaveBeenCalledWith('e1', 'cancel'));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart ceremony' }));
    await waitFor(() => expect(ceremonyAct).toHaveBeenCalledWith('e1', 'restart'));
  });

  it('blockers disable start; ties are decided by alias only', async () => {
    const decideAward = vi.fn(async () => undefined);
    mountConsole({
      phase: 'awards',
      admin: {
        ceremony: async () =>
          state({
            canStart: false,
            blockers: ['decisions_pending'],
            pendingDecisions: [
              {
                boardKey: 'funniest',
                candidates: [
                  { giftId: 'g1', label: 'Gift 7' },
                  { giftId: 'g2', label: 'Gift 3' },
                ],
              },
            ],
          }) as never,
        decideAward,
      },
    });
    expect(await screen.findByText('Decide the tied awards below first.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Start ceremony' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const confirm = screen.getByRole('button', { name: 'Confirm winner' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Gift 3'));
    fireEvent.click(confirm);
    await waitFor(() => expect(decideAward).toHaveBeenCalledWith('e1', 'funniest', 'g2'));
  });
});

describe('leaderboards surface', () => {
  const board = (key: string, state: string, message: string | null, entries: unknown[]) => ({
    boardKey: key,
    state,
    message,
    entries,
  });

  it('display: each live board gets a podium; unsafe boards show the neutral message; hidden boards are omitted', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: { ...ds, phase: 'awards' },
      scene: SceneSchema.parse({ scene: 'phase', phase: 'awards' }),
      leaderboards: {
        boards: [
          board('funniest', 'live', null, [
            { entryId: 'g1', label: 'Gift 7', rank: 1, tied: false },
          ]),
          board('most_creative', 'live', 'christmas_magic', []),
          board('xp', 'hidden', null, []),
        ],
      },
    });
    const boards = await screen.findByTestId('boards');
    expect(boards.querySelector('[data-board=funniest]')!.textContent).toContain('👑');
    expect(boards.querySelector('[data-board=most_creative]')!.textContent).toContain(
      'Christmas magic is in the air!',
    );
    expect(boards.querySelector('[data-board=xp]')).toBeNull();
    expect(boards.textContent).not.toMatch(/score|points|total/i);
  });

  it('participant: top-N only, neutral message for everyone else', async () => {
    const t = setup('/e', {}, { getGift: async () => ({ gift: null, editable: false }) });
    t.snapshot('p:p1', { eventState: { ...ds, role: 'participant', phase: 'awards', me: ME } });
    t.snapshot('pub', {
      leaderboards: { boards: [board('funniest', 'live', 'christmas_magic', [])] },
    });
    expect(await screen.findByText('Christmas magic is in the air!')).toBeTruthy();
    expect(screen.getByText(/Every gift made today brighter/)).toBeTruthy();
  });

  it('organizer boards console: small cohorts need the acknowledgement; pause/resume/hide/publish', async () => {
    const boardAction = vi.fn(async () => undefined);
    mountConsole({
      phase: 'voting',
      admin: {
        boards: async () => ({
          cadenceSeconds: 10,
          boards: [
            {
              boardKey: 'funniest',
              kind: 'category',
              label: { en: 'Funniest', it: 'Divertente' },
              state: 'hidden',
              forced: false,
              lastPublishedAt: null,
              liveAllowed: false,
              publishableNow: false,
            },
            {
              boardKey: 'most_creative',
              kind: 'category',
              label: { en: 'Creative' },
              state: 'live',
              forced: false,
              lastPublishedAt: null,
              liveAllowed: true,
              publishableNow: true,
            },
          ],
        }),
        boardAction,
      },
    });
    const enable = await screen.findByRole('button', { name: 'Turn on' });
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/with few voters a live board/));
    fireEvent.click(enable);
    await waitFor(() => expect(boardAction).toHaveBeenCalledWith('e1', 'funniest', 'enable', true));
    fireEvent.click(screen.getAllByRole('button', { name: 'Pause' })[0]!);
    await waitFor(() =>
      expect(boardAction).toHaveBeenCalledWith('e1', 'most_creative', 'pause', undefined),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Publish now' })[1]!);
    await waitFor(() =>
      expect(boardAction).toHaveBeenCalledWith('e1', 'most_creative', 'publish_now', undefined),
    );
  });
});

describe('achievements', () => {
  it('lists my achievements, announces an unlock live (FX + text), and shows another profile', async () => {
    const myAchievements = vi.fn(async () => ({
      achievements: [{ key: 'comedy_santa', unlockedAt: '2026-12-20T20:00:00Z' }],
    }));
    const t = setup(
      '/e',
      {},
      { myAchievements, getGift: async () => ({ gift: null, editable: false }) },
    );
    t.snapshot('p:p1', { eventState: { ...ds, role: 'participant', phase: 'awards', me: ME } });
    expect((await screen.findByTestId('my-achievements')).textContent).toContain('Comedy Santa');
    act(() => {
      t.sock.fire('delta', {
        stream: 'p:p1',
        cursor: 2,
        surface: 'announcement',
        payload: AnnouncementSchema.parse({
          type: 'achievement',
          key: 'christmas_spirit',
          person: person('p1', 'Anna'),
          at: '2026-12-20T20:05:00Z',
        }),
      });
    });
    expect((await screen.findByTestId('achievement-unlock')).textContent).toContain(
      'Achievement unlocked: Christmas Spirit!',
    );
    expect(emitFx).toHaveBeenCalledWith('achievement_earned');
  });

  it('profile page shows name, avatar and achievements of another participant', async () => {
    setup(
      '/e/profile/p8',
      {},
      {
        profile: async () => ({
          participantId: 'p8',
          displayName: 'Marta',
          avatar: 'elf',
          achievements: ['creative_elf'],
        }),
      },
    );
    expect(await screen.findByRole('heading', { name: /Marta/ })).toBeTruthy();
    expect(screen.getByTestId('profile-achievements').textContent).toContain('Creative Elf');
  });
});
