import { fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneSchema } from '@santa/contracts';
import i18n from './i18n';
import { usePrefs } from './prefs/store';
import { ApiError } from './api/client';
import type { PlayApi } from './api/play';
import { ME, setup } from './test-utils';

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
  counts: { participants: 7, giftsRegistered: 4 },
  me: ME,
  ...over,
});
const ownGift = {
  giftId: 'g-mine',
  alias: 'Gift 2',
  name: 'Mug',
  description: null,
  photoUrl: null,
  status: 'registered' as const,
};
const pubGift = (id: string, name: string) => ({
  giftId: id,
  alias: `Gift ${id}`,
  name,
  description: null,
  photoUrl: null,
  status: 'opened' as const,
});

const createObjectURL = vi.fn(() => 'blob:gift-preview');
const revokeObjectURL = vi.fn();
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
let rasterizedBlob: Blob;
let restoreCanvas: () => void = () => undefined;

beforeEach(async () => {
  await i18n.changeLanguage('en');
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' });
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  // jsdom has no createImageBitmap/canvas: mock the rasterizer GiftPhoto uses for local previews.
  rasterizedBlob = new Blob(['rasterized pixels'], { type: 'image/png' });
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 2, height: 3, close: vi.fn() }) as unknown as ImageBitmap),
  );
  const getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(
      new Proxy({}, { get: () => () => undefined }) as unknown as CanvasRenderingContext2D,
    );
  const toBlobSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation((callback) => {
      callback(rasterizedBlob);
    });
  restoreCanvas = () => {
    getContextSpy.mockRestore();
    toBlobSpy.mockRestore();
  };
});

afterEach(() => {
  restoreCanvas();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('gift registration', () => {
  it('shows only a count (no gift content) and registers name, description and photo with a client preview', async () => {
    const saveGift = vi.fn<PlayApi['saveGift']>(async () => ({
      gift: { ...ownGift, name: 'Warm scarf', description: 'Blue' },
      editable: true,
    }));
    const uploadPhoto = vi.fn<PlayApi['uploadPhoto']>(async () => ({
      gift: { ...ownGift, name: 'Warm scarf', photoUrl: 'https://cdn.test/p.jpg' },
      editable: true,
    }));
    const t = setup(
      '/e',
      {},
      {
        getGift: async () => ({ gift: null, editable: true }),
        saveGift,
        uploadPhoto,
      },
    );
    t.snapshot('p:p1', { eventState: es('gift_registration') });
    expect(await screen.findByText('4 gifts registered so far')).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Gift name'), {
      target: { value: ' Warm scarf ' },
    });
    fireEvent.change(screen.getByLabelText('Short description (optional)'), {
      target: { value: 'Blue' },
    });
    const file = new File([JPEG_BYTES], 'p.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Photo (optional)'), { target: { files: [file] } });
    const preview = await screen.findByTestId('gift-photo-preview');
    expect(createObjectURL).toHaveBeenCalledWith(rasterizedBlob);
    expect(preview.getAttribute('src')).toBe('blob:gift-preview');
    expect(preview.getAttribute('alt')).toBe('Preview of your gift photo');
    expect((preview as HTMLImageElement).hidden).toBe(true);
    fireEvent.load(preview);
    expect((preview as HTMLImageElement).hidden).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Register gift' }));
    await waitFor(() =>
      expect(saveGift).toHaveBeenCalledWith({ name: 'Warm scarf', description: 'Blue' }),
    );
    await waitFor(() => expect(uploadPhoto).toHaveBeenCalledWith(file));
    expect(await screen.findByText('Gift saved!')).toBeTruthy();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:gift-preview'));
  });

  it('provides an accessible drag-and-drop photo picker with replace and remove controls', async () => {
    const t = setup('/e', {}, { getGift: async () => ({ gift: null, editable: true }) });
    t.snapshot('p:p1', { eventState: es('gift_registration') });

    const input = await screen.findByLabelText('Photo (optional)');
    expect(input.getAttribute('accept')).toBe('image/*');
    expect(screen.getByText('Choose photo')).toBeTruthy();
    expect(screen.getByText('Drag and drop a photo here, or choose one.')).toBeTruthy();
    expect(screen.getByText('Image file (JPG or PNG recommended), max 5 MB.')).toBeTruthy();

    const first = new File([JPEG_BYTES], 'first.jpg', { type: 'image/jpeg' });
    fireEvent.drop(screen.getByTestId('gift-photo-dropzone'), {
      dataTransfer: { files: [first] },
    });
    expect(await screen.findByTestId('gift-photo-preview')).toBeTruthy();
    expect(screen.getByText('first.jpg selected')).toBeTruthy();
    expect(screen.getByText('Replace photo')).toBeTruthy();

    const second = new File([PNG_BYTES], 'second.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [second] } });
    expect(await screen.findByText('second.png selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }));
    await waitFor(() => expect(screen.queryByTestId('gift-photo-preview')).toBeNull());
    expect(screen.getByText('Choose photo')).toBeTruthy();
  });

  it('removes an uploaded gift photo through the existing API', async () => {
    const removePhoto = vi.fn<PlayApi['removePhoto']>(async () => ({
      gift: { ...ownGift, photoUrl: null },
      editable: true,
    }));
    const t = setup(
      '/e',
      {},
      {
        getGift: async () => ({
          gift: { ...ownGift, photoUrl: '/uploads/mug.jpg' },
          editable: true,
        }),
        removePhoto,
      },
    );
    t.snapshot('p:p1', { eventState: es('gift_registration') });

    expect(await screen.findByTestId('gift-photo')).toBeTruthy();
    expect(screen.getByText('Replace photo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }));
    await waitFor(() => expect(removePhoto).toHaveBeenCalledTimes(1));
  });

  it('does not render an image when no photo URL exists', async () => {
    const t = setup(
      '/e',
      {},
      { getGift: async () => ({ gift: ownGift, editable: false }) },
    );
    t.snapshot('p:p1', { eventState: es('gift_registration') });
    await screen.findByDisplayValue('Mug');
    expect(screen.queryByTestId('gift-photo')).toBeNull();
    expect(screen.queryByAltText('Preview of your gift photo')).toBeNull();
  });

  it('renders persisted photos from safe URLs and removes them after a load failure', async () => {
    const t = setup(
      '/e',
      {},
      {
        getGift: async () => ({
          gift: { ...ownGift, photoUrl: '/uploads/mug.jpg' },
          editable: false,
        }),
      },
    );
    t.snapshot('p:p1', { eventState: es('gift_registration') });
    const photo = await screen.findByTestId('gift-photo');
    expect(photo.getAttribute('src')).toBe(new URL('/uploads/mug.jpg', window.location.origin).href);
    fireEvent.load(photo);
    expect((photo as HTMLImageElement).hidden).toBe(false);
    fireEvent.error(photo);
    await waitFor(() => expect(screen.queryByTestId('gift-photo')).toBeNull());
  });

  it('rejects non-images and oversize photos on the client', async () => {
    const t = setup('/e', {}, { getGift: async () => ({ gift: null, editable: true }) });
    t.snapshot('p:p1', { eventState: es('gift_registration') });
    const input = await screen.findByLabelText('Photo (optional)');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] },
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/not a usable image/);
    const big = new File([new Uint8Array(1)], 'b.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/too large/);
  });

  it('assignment: recipient is absent until revealed, then hidden on the second click', async () => {
    const t = setup(
      '/e',
      {},
      {
        assignment: async () => ({
          recipient: { participantId: 'p5', displayName: 'Bruno', avatar: 'elf' },
        }),
      },
    );
    t.snapshot('p:p1', { eventState: es('gift_registration') });
    expect(await screen.findByRole('button', { name: 'Reveal recipient' })).toBeTruthy();
    expect(screen.queryByText('You are giving a gift to')).toBeNull();
    expect(screen.queryByText('Bruno')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal recipient' }));
    expect(await screen.findByText('Bruno')).toBeTruthy();
    expect(screen.getByText('You are giving a gift to')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide recipient' }));
    expect(screen.queryByText('Bruno')).toBeNull();
    expect(screen.queryByText('You are giving a gift to')).toBeNull();
  });

  it('assignment: unverified claims get a friendly pointer instead', async () => {
    const t = setup(
      '/e',
      {},
      {
        assignment: async () => {
          throw new ApiError(403, 'verification_required');
        },
      },
    );
    t.snapshot('p:p1', { eventState: es('gift_registration') });
    expect((await screen.findAllByText(/Confirm your identity/)).length).toBeGreaterThan(0);
  });
});

describe('opening on the participant app', () => {
  it('shows progress and the current gift once revealed (reduced motion: immediately)', async () => {
    usePrefs.setState({ reducedMotion: 'on' });
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: es('gift_opening') });
    t.snapshot('pub', {
      scene: SceneSchema.parse({
        scene: 'opening',
        openedCount: 2,
        total: 6,
        countdownSeconds: 3,
        countdownEndsAt: null,
        current: {
          ...pubGift('7', 'Candle'),
          photoUrl: '/media/gifts/e1/candle.jpg?exp=10&sig=test',
        },
      }),
    });
    expect(await screen.findByText('2 of 6 gifts opened')).toBeTruthy();
    expect((await screen.findByTestId('opening-revealed')).textContent).toContain('Candle');
    expect(screen.getByTestId('opening-gift-photo').getAttribute('src')).toBe(
      new URL('/media/gifts/e1/candle.jpg?exp=10&sig=test', window.location.origin).href,
    );
  });
});

describe('voting', () => {
  const categories = [
    {
      id: 'c1',
      key: 'funniest',
      name: { en: 'Funniest', it: 'Il più divertente' },
      description: null,
    },
    { id: 'c2', key: 'cosy', name: { en: 'Coziest', it: 'Il più accogliente' }, description: null },
  ];
  const gifts = {
    mode: 'gallery',
    currentGiftId: null,
    gifts: [pubGift('g-mine', 'Mug'), pubGift('g2', 'Scarf'), pubGift('g3', 'Candle')],
  };

  it('one selection per category, own gift disabled, edit while open, own-picks summary, counter and countdown', async () => {
    const votes: Array<{ categoryId: string; giftId: string }> = [];
    const castVote = vi.fn<PlayApi['castVote']>(async (v) => {
      votes.splice(0, votes.length, ...votes.filter((x) => x.categoryId !== v.categoryId), v);
      return { ...v, xpAwarded: false };
    });
    const t = setup(
      '/e',
      {},
      {
        getGift: async () => ({ gift: ownGift, editable: false }),
        voting: async () => ({
          status: 'open',
          endsAt: new Date(Date.now() + 120_000).toISOString(),
          votedCount: 4,
          categories,
        }),
        ownVotes: async () => ({ votes: [...votes] }),
        castVote,
      },
    );
    t.snapshot('p:p1', {
      eventState: es('voting', {
        votedCount: 4,
        votingEndsAt: new Date(Date.now() + 120_000).toISOString(),
      }),
    });
    t.snapshot('pub', { giftList: gifts });
    const funniest = await screen.findByRole('group', { name: 'Funniest' });
    const radios = Array.from(funniest.querySelectorAll('input[type=radio]')) as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    expect(radios[0]!.disabled).toBe(true); // own gift
    expect(radios[1]!.disabled).toBe(false);
    expect(screen.getByTestId('voted-count').textContent).toBe('4 people have voted');
    expect(screen.getByRole('timer').textContent).toMatch(/^0[12]:\d\d$/);

    fireEvent.click(radios[1]!);
    await waitFor(() => expect(castVote).toHaveBeenCalledWith({ categoryId: 'c1', giftId: 'g2' }));
    await waitFor(() =>
      expect(screen.getByTestId('own-picks').textContent).toContain('Funniest: Scarf'),
    );
    fireEvent.click(radios[2]!); // change while open
    await waitFor(() =>
      expect(castVote).toHaveBeenLastCalledWith({ categoryId: 'c1', giftId: 'g3' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('own-picks').textContent).toContain('Funniest: Candle'),
    );
    expect(screen.getByTestId('own-picks').querySelectorAll('li')).toHaveLength(1);
  });

  it('closed voting is read-only; Italian category names are used', async () => {
    await i18n.changeLanguage('it');
    const t = setup(
      '/e',
      {},
      {
        getGift: async () => ({ gift: ownGift, editable: false }),
        voting: async () => ({ status: 'closed', endsAt: null, votedCount: null, categories }),
      },
    );
    t.snapshot('p:p1', { eventState: es('voting') });
    t.snapshot('pub', { giftList: gifts });
    const group = await screen.findByRole('group', { name: 'Il più divertente' });
    expect((group as HTMLFieldSetElement).disabled).toBe(true);
    expect(screen.getByText('Le votazioni sono chiuse. Grazie!')).toBeTruthy();
  });

  it('a11y: voting panel has no axe violations', async () => {
    const t = setup(
      '/e',
      {},
      {
        getGift: async () => ({ gift: ownGift, editable: false }),
        voting: async () => ({ status: 'open', endsAt: null, votedCount: null, categories }),
      },
    );
    t.snapshot('p:p1', { eventState: es('voting') });
    t.snapshot('pub', { giftList: gifts });
    await screen.findByRole('group', { name: 'Funniest' });
    const res = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('reveal + leaderboard on the participant app', () => {
  it('lists revealed givers; own gift on the board gets a congratulation, others a neutral message', async () => {
    const t = setup('/e', {}, { getGift: async () => ({ gift: ownGift, editable: false }) });
    t.snapshot('p:p1', { eventState: es('reveal') });
    t.snapshot('pub', {
      giftList: {
        mode: 'gallery',
        currentGiftId: null,
        gifts: [
          {
            ...pubGift('g2', 'Scarf'),
            status: 'revealed',
            giver: { participantId: 'p8', displayName: 'Marta', avatar: null },
          },
        ],
      },
      leaderboards: {
        boards: [
          {
            boardKey: 'funniest',
            state: 'live',
            message: null,
            entries: [{ entryId: 'g-mine', label: 'Gift 2', rank: 1, tied: false }],
          },
        ],
      },
    });
    expect((await screen.findByTestId('reveal-list')).textContent).toContain('Marta');
    expect(await screen.findByText(/Your gift is on the leaderboard/)).toBeTruthy();
  });
});
