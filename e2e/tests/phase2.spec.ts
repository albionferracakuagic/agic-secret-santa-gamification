import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockRealtime } from './support/mockRealtime';
import { displayState, json, newPage, participantState, meOf, person } from './support/fixtures';

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .analyze()
    .then((r) => r.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`));

const me = meOf('p1', 'Anna');
const later = (s: number) => new Date(Date.now() + s * 1000).toISOString();

const pStream = (phase: string) => ({
  stream: 'p:p1',
  data: { eventState: participantState(phase, me) },
});

test.describe('phase 2 participant flows (mocked API + realtime)', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('guess: alphabetical suspects without me, one editable guess, positive result, axe clean', async ({
    page,
  }) => {
    await mockRealtime(page, [pStream('gift_opening')]);
    let guess: unknown;
    await page.route('**/api/me/guess', (r) =>
      r.fulfill(
        json({
          enabled: true,
          suspects: [person('p3', 'Zoe'), person('p2', 'Bruno')],
          gifts: [
            {
              giftId: 'g1',
              alias: 'Gift 1',
              state: 'guessable',
              myGuess: null,
              result: null,
              clues: [{ clueId: 'c1', text: 'Likes tea' }],
            },
            {
              giftId: 'g2',
              alias: 'Gift 2',
              state: 'revealed',
              myGuess: 'p2',
              result: { outcome: 'incorrect', cue: 'wink', xp: 0 },
              clues: [],
            },
          ],
        }),
      ),
    );
    await page.route('**/api/me/guesses/g1', (r) => {
      guess = r.request().postDataJSON();
      return r.fulfill(json({ giftId: 'g1', suspectId: 'p2' }));
    });
    await page.goto('/e');
    const select = page.getByLabel('Your guess for Gift 1');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText(['Choose a person', 'Bruno', 'Zoe']);
    await expect(page.getByText('💡 Likes tea')).toBeVisible();
    await expect(page.getByTestId('guess-result')).toContainText('Nice try');
    expect(await axe(page)).toEqual([]);
    await select.selectOption('p2');
    await page.getByRole('button', { name: 'Save guess' }).click();
    await expect.poll(() => guess).toEqual({ suspectId: 'p2' });
    await expect(page.getByText('Guess saved')).toBeVisible();
  });

  test('missions: private list, submit completion, axe clean', async ({ page }) => {
    await mockRealtime(page, [pStream('gift_opening')]);
    let submitted: unknown;
    await page.route('**/api/me/missions', (r) =>
      r.fulfill(
        json({
          enabled: true,
          optedOut: false,
          verification: 'organizer',
          missions: [
            {
              assignmentId: 'a1',
              title: { en: 'Compliment a colleague', it: 'Fai un complimento' },
              description: { en: 'Say something kind.', it: 'Dì qualcosa di gentile.' },
              status: 'assigned',
              completed: false,
              swapsLeft: 1,
            },
          ],
        }),
      ),
    );
    await page.route('**/api/me/missions/a1/submit', (r) => {
      submitted = r.request().postDataJSON();
      return r.fulfill(
        json({ assignmentId: 'a1', status: 'submitted', completed: false, xpAwarded: false }),
      );
    });
    await page.goto('/e');
    await expect(page.getByText('Compliment a colleague')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'I did it!' }).click();
    await expect.poll(() => submitted).toEqual({});
  });

  test('trivia game: question with server timer, answer once, locked afterwards', async ({
    page,
  }) => {
    const round = {
      index: 0,
      total: 3,
      prompt: { en: 'Which reindeer has a red nose?' },
      options: [
        { id: '0', label: { en: 'Rudolph' } },
        { id: '1', label: { en: 'Dasher' } },
      ],
      opensAt: null,
      endsAt: later(60),
      submissionCount: 1,
      correctOptionIds: null,
    };
    const game = {
      gameId: 'game1',
      kind: 'trivia',
      title: { en: 'Trivia night' },
      rules: { en: 'Answer fast.' },
      status: 'round_open',
      stepEndsAt: null,
      round,
      results: null,
    };
    await mockRealtime(page, [
      pStream('games'),
      { stream: 'pub', data: { scene: { scene: 'game', game } } },
    ]);
    let done = false;
    let answer: unknown;
    await page.route('**/api/me/game', (r) =>
      r.fulfill(
        json({
          game,
          me: {
            submitted: done,
            answerId: done ? '0' : null,
            score: 0,
            lastRound: null,
            card: null,
          },
        }),
      ),
    );
    await page.route('**/api/me/game/answers', (r) => {
      answer = r.request().postDataJSON();
      done = true;
      return r.fulfill(json({ roundIndex: 0, accepted: true }));
    });
    await page.goto('/e');
    await expect(page.getByText('Which reindeer has a red nose?')).toBeVisible();
    await expect(page.getByRole('timer').first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'Rudolph' }).click();
    await expect.poll(() => answer).toEqual({ answerId: '0' });
    await expect(page.getByText('Answer sent: well done!')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dasher' })).toBeDisabled();
  });

  test('certificate: downloads the PNG for the UI locale', async ({ context }) => {
    const page = await newPage(context, { locale: 'it' });
    await mockRealtime(page, [pStream('awards')]);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.route('**/api/me/certificates', (r) =>
      r.fulfill(
        json({
          certificates: [
            {
              key: 'game_night',
              title: { en: 'Game Night', it: 'Serata di Giochi' },
              url: '/api/me/certificates/game_night',
            },
          ],
        }),
      ),
    );
    let locale: string | null = null;
    await page.route('**/api/me/certificates/game_night**', (r) => {
      locale = new URL(r.request().url()).searchParams.get('locale');
      return r.fulfill({ status: 200, contentType: 'image/png', body: png });
    });
    await page.goto('/e');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Scarica Serata di Giochi' }).click();
    expect((await download).suggestedFilename()).toBe('game_night-it.png');
    expect(locale).toBe('it');
  });
});

test.describe('phase 2 display (1080p)', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('game scene with submission counter, then published winners only; mission announcement is generic', async ({
    page,
  }) => {
    const game = {
      gameId: 'game1',
      kind: 'trivia',
      title: { en: 'Trivia night' },
      rules: { en: 'Answer fast.' },
      status: 'round_open',
      stepEndsAt: null,
      round: {
        index: 0,
        total: 3,
        prompt: { en: 'Which reindeer has a red nose?' },
        options: [{ id: '0', label: { en: 'Rudolph' } }],
        opensAt: null,
        endsAt: later(60),
        submissionCount: 4,
        correctOptionIds: null,
      },
      results: null,
    };
    const rt = await mockRealtime(page, [
      {
        stream: 'pub',
        data: { eventState: displayState('games'), scene: { scene: 'game', game } },
      },
    ]);
    await page.goto('/d');
    await expect(page.getByTestId('submission-count')).toHaveText('4 answered');
    rt.delta('pub', 'announcement', { type: 'mission_completed', at: later(0) });
    await expect(page.getByTestId('announcement')).toContainText('A secret mission was completed!');
    rt.delta('pub', 'scene', {
      scene: 'game',
      game: {
        ...game,
        status: 'results',
        round: null,
        results: {
          message: null,
          entries: [{ person: person('p2', 'Bruno'), rank: 1, tied: false }],
        },
      },
    });
    await expect(page.getByTestId('game-winners')).toContainText('Bruno');
  });
});
