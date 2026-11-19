import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACHIEVEMENT_CATALOG,
  AnnouncementSchema,
  ParticipantAnnouncementSchema,
  PublicAnnouncementSchema,
  SceneSchema,
} from '@santa/contracts';
import i18n from './i18n';
import { usePrefs } from './prefs/store';
import type { Phase2Api } from './api/phase2';
import { ME, mountConsole, setup } from './test-utils';

const es = (phase: string, role: 'participant' | 'display' = 'participant') => ({
  role,
  eventId: 'e1',
  name: 'Office Party',
  description: null,
  theme: 'xmas',
  startsAt: '2026-12-20T18:00:00Z',
  timezone: 'UTC',
  phase,
  paused: false,
  votingEndsAt: null,
  counts: { participants: 7, giftsRegistered: 4 },
  ...(role === 'participant' ? { me: ME } : {}),
});
const person = (id: string, name: string) => ({
  participantId: id,
  displayName: name,
  avatar: 'elf',
});
const scene = (s: unknown) => SceneSchema.parse(s);
const lobby = { scene: 'lobby', participants: 1, joinUrl: null, shortCode: null };
const AT = '2026-12-20T18:30:00Z';
const later = (s: number) => new Date(Date.now() + s * 1000).toISOString();

beforeEach(async () => {
  await i18n.changeLanguage('en');
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' });
});
afterEach(() => vi.unstubAllGlobals());

const guessState = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  suspects: [person('p3', 'Zoe'), person('p1', 'Anna'), person('p2', 'Bruno')],
  gifts: [
    {
      giftId: 'g1',
      alias: 'Gift 1',
      state: 'guessable' as const,
      myGuess: null,
      result: null,
      clues: [],
    },
    {
      giftId: 'g2',
      alias: 'Gift 2',
      state: 'own' as const,
      myGuess: null,
      result: null,
      clues: [],
    },
  ],
  ...over,
});

describe('guess your secret santa (participant)', () => {
  it('lists suspects alphabetically without the caller and saves one guess per gift', async () => {
    const setGuess = vi.fn<Phase2Api['setGuess']>(async () => undefined);
    const t = setup('/e', {}, {}, { guessState: async () => guessState(), setGuess });
    t.snapshot('p:p1', { eventState: es('gift_opening') });
    const select = (await screen.findByLabelText('Your guess for Gift 1')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['Choose a person', 'Bruno', 'Zoe']);
    expect(screen.getByText('This is your own gift: no guess needed.')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'p2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save guess' }));
    await waitFor(() => expect(setGuess).toHaveBeenCalledWith('g1', 'p2'));
    expect(await screen.findByText('Guess saved')).toBeTruthy();
  });

  it('renders nothing while the feature flag is off', async () => {
    const t = setup('/e', {}, {}, { guessState: async () => guessState({ enabled: false }) });
    t.snapshot('p:p1', { eventState: es('gift_opening') });
    await screen.findByText('Office Party');
    expect(screen.queryByTestId('guess-panel')).toBeNull();
  });

  it('after the reveal: guesses closed, positive feedback only (confetti or wink, no penalty)', async () => {
    const t = setup(
      '/e',
      {},
      {},
      {
        guessState: async () =>
          guessState({
            gifts: [
              {
                giftId: 'g1',
                alias: 'Gift 1',
                state: 'revealed' as const,
                myGuess: 'p2',
                result: { outcome: 'incorrect', cue: 'wink', xp: 0 },
                clues: [{ clueId: 'c1', text: 'Likes tea' }],
              },
              {
                giftId: 'g3',
                alias: 'Gift 3',
                state: 'revealed' as const,
                myGuess: 'p3',
                result: { outcome: 'correct', cue: 'confetti', xp: 25 },
                clues: [],
              },
            ],
          }),
      },
    );
    t.snapshot('p:p1', { eventState: es('reveal') });
    const results = await screen.findAllByTestId('guess-result');
    expect(results.map((r) => r.dataset.cue)).toEqual(['wink', 'confetti']);
    expect(results[0]!.textContent).toMatch(/no penalty/);
    expect(results[1]!.textContent).toMatch(/\+25 XP/);
    expect(screen.queryByLabelText('Your guess for Gift 1')).toBeNull();
    expect(screen.getByText('💡 Likes tea')).toBeTruthy();
  });

  it('giver submits a clue (5–140 chars) and sees its moderation status', async () => {
    const submitClue = vi.fn<Phase2Api['submitClue']>(async () => undefined);
    const t = setup(
      '/e',
      {},
      {},
      {
        guessState: async () => guessState(),
        submitClue,
        myClues: async () => ({
          clues: [{ clueId: 'c9', text: 'Loves snow', status: 'pending' as const }],
        }),
      },
    );
    t.snapshot('p:p1', { eventState: es('gift_opening') });
    const box = await screen.findByLabelText(/Give a clue about your gift/);
    const send = screen.getByRole('button', { name: 'Send clue' }) as HTMLButtonElement;
    fireEvent.change(box, { target: { value: 'hi' } });
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: ' Likes quiet mornings ' } });
    fireEvent.click(send);
    await waitFor(() => expect(submitClue).toHaveBeenCalledWith('Likes quiet mornings'));
    expect(await screen.findByText('Clue sent: the organizer will review it.')).toBeTruthy();
    expect(screen.getByTestId('my-clues').textContent).toMatch(/Loves snow — Waiting for approval/);
  });

  it('participant stream: guess_result and clue announcements are shown; panel is axe clean', async () => {
    const t = setup('/e', {}, {}, { guessState: async () => guessState() });
    t.snapshot('p:p1', {
      eventState: es('gift_opening'),
      announcement: ParticipantAnnouncementSchema.parse({
        type: 'clue',
        giftId: 'g1',
        alias: 'Gift 1',
        text: 'Old clue',
        at: AT,
      }),
    });
    await screen.findByTestId('guess-panel');
    t.snapshot('p:p1', {
      eventState: es('gift_opening'),
      announcement: ParticipantAnnouncementSchema.parse({
        type: 'guess_result',
        giftId: 'g1',
        alias: 'Gift 1',
        outcome: 'incorrect',
        cue: 'wink',
        xp: 0,
        at: '2026-12-20T18:31:00Z',
      }),
    });
    expect((await screen.findByTestId('achievement-unlock')).textContent).toMatch(/Nice try/);
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

const mission = (over: Record<string, unknown> = {}) => ({
  assignmentId: 'a1',
  title: { en: 'Compliment a colleague', it: 'Fai un complimento' },
  description: { en: 'Say something kind.', it: 'Dì qualcosa di gentile.' },
  status: 'assigned',
  completed: false,
  swapsLeft: 1,
  ...over,
});

describe('secret missions (participant, private)', () => {
  it('lists my missions, submits completion and requests a reassignment', async () => {
    const submitMission = vi.fn<Phase2Api['submitMission']>(async () => undefined);
    const reassignMission = vi.fn<Phase2Api['reassignMission']>(async () => mission() as never);
    const t = setup(
      '/e',
      {},
      {},
      {
        myMissions: async () => ({
          enabled: true,
          optedOut: false,
          verification: 'organizer' as const,
          missions: [mission()] as never,
        }),
        submitMission,
        reassignMission,
      },
    );
    t.snapshot('p:p1', { eventState: es('gift_opening') });
    expect(await screen.findByText(/Compliment a colleague/)).toBeTruthy();
    expect(screen.getByText('Only you can see your missions.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Note for the organizer (optional)'), {
      target: { value: 'Done at lunch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'I did it!' }));
    await waitFor(() => expect(submitMission).toHaveBeenCalledWith('a1', 'Done at lunch'));
    fireEvent.click(screen.getByRole('button', { name: 'Swap mission (1 left)' }));
    await waitFor(() => expect(reassignMission).toHaveBeenCalledWith('a1'));
  });

  it('opt-out toggles and hides the list; flag off hides everything; Italian text follows the locale', async () => {
    const setMissionOptOut = vi.fn<Phase2Api['setMissionOptOut']>(async () => undefined);
    await i18n.changeLanguage('it');
    const t = setup(
      '/e',
      {},
      {},
      {
        myMissions: async () => ({
          enabled: true,
          optedOut: false,
          verification: 'none' as const,
          missions: [mission()] as never,
        }),
        setMissionOptOut,
      },
    );
    t.snapshot('p:p1', { eventState: es('gift_opening') });
    expect(await screen.findByText(/Fai un complimento/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Salta le missioni segrete'));
    await waitFor(() => expect(setMissionOptOut).toHaveBeenCalledWith(true));
  });

  it('feature flag off: no missions UI', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: es('gift_opening') });
    await screen.findByText('Office Party');
    expect(screen.queryByTestId('missions-panel')).toBeNull();
  });
});

const round = (over: Record<string, unknown> = {}) => ({
  index: 0,
  total: 3,
  prompt: { en: 'Which reindeer has a red nose?', it: 'Quale renna ha il naso rosso?' },
  options: [
    { id: '0', label: { en: 'Rudolph' } },
    { id: '1', label: { en: 'Dasher' } },
  ],
  opensAt: null,
  endsAt: later(30),
  submissionCount: 2,
  correctOptionIds: null,
  ...over,
});
const gameView = (kind: string, status: string, over: Record<string, unknown> = {}) => ({
  gameId: 'game1',
  kind,
  title: { en: 'Trivia night' },
  rules: { en: 'Answer fast.' },
  status,
  stepEndsAt: later(5),
  round: round(),
  results: null,
  ...over,
});
const myGame = (game: unknown, me: Record<string, unknown> | null = {}) => ({
  game,
  me: me && { submitted: false, answerId: null, score: 0, lastRound: null, card: null, ...me },
});

describe('mini-games (participant)', () => {
  it('trivia: answer once, locked after submission, own points shown', async () => {
    const submitAnswer = vi.fn<Phase2Api['submitAnswer']>(async () => undefined);
    let submitted = false;
    const t = setup(
      '/e',
      {},
      {},
      {
        myGame: async () =>
          myGame(gameView('trivia', 'round_open'), {
            submitted,
            answerId: submitted ? '0' : null,
            score: 120,
          }) as never,
        submitAnswer: async (id) => {
          submitted = true;
          await submitAnswer(id);
        },
      },
    );
    t.snapshot('p:p1', { eventState: es('games') });
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: scene({ scene: 'game', game: gameView('trivia', 'round_open') }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Rudolph' }));
    await waitFor(() => expect(submitAnswer).toHaveBeenCalledWith('0'));
    await screen.findByText('Answer sent: well done!');
    expect((screen.getByRole('button', { name: 'Dasher' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('Your points: 120')).toBeTruthy();
    expect(screen.getAllByRole('timer').length).toBeGreaterThan(0);
  });

  it('speed: "get ready" until the server opensAt, then the tap button is enabled', async () => {
    const submitAnswer = vi.fn<Phase2Api['submitAnswer']>(async () => undefined);
    const game = gameView('speed', 'round_open', {
      round: round({ options: [], opensAt: later(-1) }),
    });
    const t = setup('/e', {}, {}, { myGame: async () => myGame(game) as never, submitAnswer });
    t.snapshot('p:p1', { eventState: es('games') });
    const tap = (await screen.findByRole('button', { name: /Tap now!/ })) as HTMLButtonElement;
    expect(tap.disabled).toBe(false);
    fireEvent.click(tap);
    await waitFor(() => expect(submitAnswer).toHaveBeenCalledWith('tap'));
  });

  it('speed before GO shows get ready and a disabled button', async () => {
    const game = gameView('speed', 'round_open', {
      round: round({ options: [], opensAt: later(60) }),
    });
    const t = setup('/e', {}, {}, { myGame: async () => myGame(game) as never });
    t.snapshot('p:p1', { eventState: es('games') });
    const b = (await screen.findByRole('button', { name: 'Get ready…' })) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
  });

  it('bingo: card with marks (pending/confirmed), marking sends the cell; free cell is not markable', async () => {
    const markBingo = vi.fn<Phase2Api['markBingo']>(async () => undefined);
    const cells = Array.from({ length: 25 }, (_, i) => ({
      cell: i,
      label: { en: `Square ${i}` },
      free: i === 12,
      mark: i === 3 ? 'pending' : i === 4 ? 'confirmed' : 'none',
    }));
    const game = gameView('bingo', 'round_open', { round: round({ options: [] }) });
    const t = setup(
      '/e',
      {},
      {},
      {
        myGame: async () => myGame(game, { card: { cells, lines: 1 } }) as never,
        markBingo,
      },
    );
    t.snapshot('p:p1', { eventState: es('games') });
    const card = await screen.findByTestId('bingo-card');
    expect(within(card).getAllByRole('button')).toHaveLength(25);
    fireEvent.click(within(card).getByRole('button', { name: /Mark Square 7/ }));
    await waitFor(() => expect(markBingo).toHaveBeenCalledWith(7));
    expect(
      (within(card).getByRole('button', { name: /Square 3.*Waiting/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((within(card).getByRole('button', { name: /Free/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('Lines: 1')).toBeTruthy();
  });

  it('round feedback is positive only: wrong answers get an encouraging message', async () => {
    const game = gameView('trivia', 'round_closed', {
      round: round({ correctOptionIds: ['0'] }),
    });
    const t = setup(
      '/e',
      {},
      {},
      {
        myGame: async () =>
          myGame(game, {
            submitted: true,
            answerId: '1',
            lastRound: { outcome: 'incorrect', cue: 'wink', points: 0 },
          }) as never,
      },
    );
    t.snapshot('p:p1', { eventState: es('games') });
    expect((await screen.findByTestId('round-feedback')).textContent).toMatch(/Nice try/);
  });
});

describe('certificates', () => {
  const certs = {
    certificates: [
      {
        key: 'game_night',
        title: { en: 'Game Night', it: 'Serata di Giochi' },
        url: '/api/me/certificates/game_night',
      },
    ],
  };
  it('downloads the PNG for the UI locale (fallback without Web Share)', async () => {
    await i18n.changeLanguage('it');
    const fetchCertificate = vi.fn<Phase2Api['fetchCertificate']>(
      async () => new Blob(['x'], { type: 'image/png' }),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const t = setup('/e', {}, {}, { myCertificates: async () => certs, fetchCertificate });
    t.snapshot('p:p1', { eventState: es('awards') });
    fireEvent.click(await screen.findByRole('button', { name: 'Scarica Serata di Giochi' }));
    await waitFor(() =>
      expect(fetchCertificate).toHaveBeenCalledWith('/api/me/certificates/game_night', 'it'),
    );
    await waitFor(() => expect(click).toHaveBeenCalled());
    click.mockRestore();
  });

  it('shares via the Web Share API when files can be shared', async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, share, canShare: () => true });
    const t = setup(
      '/e',
      {},
      {},
      {
        myCertificates: async () => certs,
        fetchCertificate: async () => new Blob(['x'], { type: 'image/png' }),
      },
    );
    t.snapshot('p:p1', { eventState: es('awards') });
    fireEvent.click(await screen.findByRole('button', { name: 'Share Game Night' }));
    await waitFor(() => expect(share).toHaveBeenCalled());
  });
});

describe('display: phase 2 scenes and announcements', () => {
  it('game scenes: intro, open round with submission counter, closed answer, winners (top-N, no scores)', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: scene({ scene: 'game', game: gameView('trivia', 'intro', { round: null }) }),
    });
    expect(await screen.findByText('Game time!')).toBeTruthy();
    expect(screen.getByText('Answer fast.')).toBeTruthy();
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: scene({ scene: 'game', game: gameView('trivia', 'round_open') }),
    });
    expect(await screen.findByText('Which reindeer has a red nose?')).toBeTruthy();
    expect(screen.getByTestId('submission-count').textContent).toBe('2 answered');
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: scene({
        scene: 'game',
        game: gameView('trivia', 'round_closed', { round: round({ correctOptionIds: ['0'] }) }),
      }),
    });
    expect((await screen.findByText(/Rudolph/)).textContent).toContain('✅');
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: scene({
        scene: 'game',
        game: gameView('trivia', 'results', {
          round: null,
          results: {
            message: null,
            entries: [{ person: person('p2', 'Bruno'), rank: 1, tied: false }],
          },
        }),
      }),
    });
    const winners = await screen.findByTestId('game-winners');
    expect(winners.textContent).toContain('Bruno');
    expect(winners.textContent).not.toMatch(/\d{2,}/);
  });

  it('unsafe results show the neutral Christmas magic message', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: scene({
        scene: 'game',
        game: gameView('trivia', 'results', {
          round: null,
          results: { message: 'christmas_magic', entries: [] },
        }),
      }),
    });
    expect(await screen.findByText(/Christmas magic!/)).toBeTruthy();
  });

  it('spotlight scene (Santa Detective) shows only the published entries', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: es('reveal', 'display'),
      scene: scene({
        scene: 'spotlight',
        spotlight: {
          kind: 'santa_detective',
          at: AT,
          message: null,
          entries: [{ person: person('p4', 'Dana'), rank: 1, tied: false }],
        },
      }),
    });
    const s = await screen.findByTestId('spotlight-scene');
    expect(s.textContent).toContain('Dana');
    expect(screen.getByRole('region', { name: 'Santa Detective' })).toBeTruthy();
  });

  it('announcements switch on type: mission is generic, clue shows alias+text, guess_result never renders', async () => {
    const t = setup('/d');
    const ann = (a: unknown) => PublicAnnouncementSchema.parse(a);
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: lobby,
      announcement: ann({ type: 'mission_completed', at: AT }),
    });
    await screen.findByTestId('display-stage');
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: lobby,
      announcement: ann({ type: 'mission_completed', at: '2026-12-20T18:31:00Z' }),
    });
    expect((await screen.findByTestId('announcement')).textContent).toBe(
      '🧝A secret mission was completed!',
    );
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: lobby,
      announcement: ann({
        type: 'clue',
        giftId: 'g1',
        alias: 'Gift 1',
        text: 'Likes tea',
        at: '2026-12-20T18:32:00Z',
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId('announcement').textContent).toContain(
        'New clue for Gift 1: “Likes tea”',
      ),
    );
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: lobby,
      announcement: {
        type: 'guess_result',
        giftId: 'g1',
        alias: 'Gift 1',
        outcome: 'correct',
        cue: 'confetti',
        xp: 5,
        at: '2026-12-20T18:33:00Z',
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('announcement').textContent).toContain('Likes tea'); // unchanged: never rendered
  });

  it('achievement announcement still names the person', async () => {
    const t = setup('/d');
    const a = (at: string) =>
      AnnouncementSchema.parse({
        type: 'achievement',
        key: 'game_champion',
        person: person('p2', 'Bruno'),
        at,
      });
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: lobby,
      announcement: a(AT),
    });
    await screen.findByTestId('display-stage');
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: lobby,
      announcement: a('2026-12-20T18:31:00Z'),
    });
    expect((await screen.findByTestId('announcement')).textContent).toContain(
      'Bruno earned Game Champion!',
    );
  });
});

describe('organizer phase 2 console', () => {
  it('clue moderation: approve and reject, masked (alias + text only)', async () => {
    const decideClue = vi.fn<Phase2Api['decideClue']>(async () => undefined);
    mountConsole({
      tab: 'show',
      phase: 'gift_opening',
      features: { guessSanta: true },
      p2: {
        clueQueue: async () => ({
          enabled: true,
          clues: [
            {
              clueId: 'c1',
              giftId: 'g1',
              alias: 'Gift 1',
              text: 'Likes tea',
              status: 'pending' as const,
            },
          ],
        }),
        decideClue,
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Gift 1' }));
    await waitFor(() => expect(decideClue).toHaveBeenCalledWith('e1', 'c1', 'approve'));
    fireEvent.click(screen.getByRole('button', { name: 'Reject Gift 1' }));
    await waitFor(() => expect(decideClue).toHaveBeenCalledWith('e1', 'c1', 'reject'));
  });

  it('presentations: shows the board; when not publishable the organizer sees the reason', async () => {
    const present = vi.fn<Phase2Api['present']>(async (_e, kind) => ({
      kind,
      published: false,
      reason: 'insufficient_votes' as const,
      achievementsUnlocked: 0,
    }));
    mountConsole({
      tab: 'show',
      phase: 'gift_opening',
      features: { guessSanta: true },
      p2: { present },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Show on display: Santa Detective' }),
    );
    await waitFor(() => expect(present).toHaveBeenCalledWith('e1', 'santa_detective'));
    expect(await screen.findByText(/Reason: not enough guesses/)).toBeTruthy();
  });

  it('missions: assign, verify/reject/reassign pending submissions', async () => {
    const assignMissions = vi.fn<Phase2Api['assignMissions']>(async () => ({ assigned: 3 }));
    const verifyMission = vi.fn<Phase2Api['verifyMission']>(async () => undefined);
    mountConsole({
      tab: 'show',
      phase: 'gift_opening',
      features: { missions: true },
      p2: {
        organizerMissions: async () => ({
          enabled: true,
          verification: 'organizer' as const,
          counts: { assigned: 3, submitted: 1, verified: 0 },
          pending: [
            {
              assignmentId: 'a1',
              displayName: 'Anna',
              title: { en: 'Be kind' },
              note: null,
              submittedAt: AT,
            },
          ],
        }),
        assignMissions,
        verifyMission,
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Assign missions' }));
    await waitFor(() => expect(assignMissions).toHaveBeenCalledWith('e1'));
    fireEvent.click(screen.getByRole('button', { name: 'Verify Anna' }));
    await waitFor(() => expect(verifyMission).toHaveBeenCalledWith('e1', 'a1', 'verify'));
    fireEvent.click(screen.getByRole('button', { name: 'Give another mission Anna' }));
    await waitFor(() => expect(verifyMission).toHaveBeenCalledWith('e1', 'a1', 'reassign'));
  });

  it('games console: create, drive actions by status, confirm bingo marks', async () => {
    const createGame = vi.fn<Phase2Api['createGame']>(async () => undefined);
    const gameAction = vi.fn<Phase2Api['gameAction']>(async () => undefined);
    const decideBingo = vi.fn<Phase2Api['decideBingo']>(async () => undefined);
    mountConsole({
      tab: 'show',
      phase: 'games',
      p2: {
        organizerGames: async () => ({
          enabled: true,
          canCreate: true,
          catalog: { triviaQuestions: 40, bingoSquares: 30 },
          games: [
            {
              gameId: 'g1',
              kind: 'trivia' as const,
              status: 'draft' as const,
              title: { en: 'Quiz' },
              roundIndex: -1,
              totalRounds: 5,
              config: { introSeconds: 5, roundSeconds: 20, revealSeconds: 6 },
            },
            {
              gameId: 'g2',
              kind: 'bingo' as const,
              status: 'round_open' as const,
              title: { en: 'Bingo' },
              roundIndex: 0,
              totalRounds: 1,
              config: { introSeconds: 5, roundSeconds: 20, revealSeconds: 6 },
            },
          ],
        }),
        bingoPending: async () => ({
          marks: [{ markId: 'm1', displayName: 'Anna', cell: 3, label: { en: 'Sneezes' } }],
        }),
        createGame,
        gameAction,
        decideBingo,
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Create game' }));
    await waitFor(() =>
      expect(createGame).toHaveBeenCalledWith('e1', {
        kind: 'trivia',
        config: { rounds: 5, roundSeconds: 20, revealSeconds: 6, introSeconds: 5 },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Start: Quiz' }));
    await waitFor(() => expect(gameAction).toHaveBeenCalledWith('e1', 'g1', 'start'));
    for (const [label, action] of [
      ['Next round', 'next'],
      ['Show results', 'show_results'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: `${label}: Bingo` }));
      await waitFor(() => expect(gameAction).toHaveBeenCalledWith('e1', 'g2', action));
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Anna: Sneezes' }));
    await waitFor(() => expect(decideBingo).toHaveBeenCalledWith('e1', 'g2', 'm1', 'confirm'));
  });
});

describe('phase 2 achievements catalog labels', () => {
  const NEW = [
    'santa_detective',
    'invisible_santa',
    'mission_master',
    'game_champion',
    'game_night',
    'game_marathon',
  ];
  it('every new achievement has non-empty EN and IT name and description', () => {
    for (const key of NEW) {
      const def = ACHIEVEMENT_CATALOG.find((a) => a.key === key);
      expect(def, key).toBeTruthy();
      for (const l of ['en', 'it'] as const) {
        expect(def!.name[l].length, `${key} name ${l}`).toBeGreaterThan(0);
        expect(def!.description[l].length, `${key} desc ${l}`).toBeGreaterThan(0);
      }
      expect(def!.name.it).not.toBe(def!.name.en);
    }
  });
});
