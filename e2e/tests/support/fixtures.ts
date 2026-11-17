import type { BrowserContext, Page } from '@playwright/test';

export const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

export const event = {
  eventId: 'e1',
  name: 'Office Party',
  description: null,
  theme: 'xmas',
  startsAt: '2026-12-20T18:00:00Z',
  timezone: 'UTC',
  paused: false,
  votingEndsAt: null as string | null,
};

export const person = (id: string, name: string, avatar = 'elf') => ({
  participantId: id,
  displayName: name,
  avatar,
});

export const meOf = (id: string, name: string) => ({
  participantId: id,
  displayName: name,
  avatar: 'santa',
  status: 'active',
  xp: { xp: 10, level: 1 },
  votes: [],
});

export const gift = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  giftId: id,
  alias: `Gift ${id.replace('g', '')}`,
  name,
  description: null,
  photoUrl: null,
  status: 'opened',
  ...extra,
});

export const displayState = (
  phase: string,
  counts = { participants: 3, giftsRegistered: 0 },
  extra = {},
) => ({
  ...event,
  role: 'display',
  phase,
  counts,
  ...extra,
});
export const participantState = (
  phase: string,
  me: ReturnType<typeof meOf>,
  counts = { participants: 3, giftsRegistered: 0 },
  extra = {},
) => ({
  ...event,
  role: 'participant',
  phase,
  counts,
  me,
  ...extra,
});

/** A new page whose cookie notice is already acknowledged and (optionally) whose UI language is fixed. */
export async function newPage(
  ctx: BrowserContext,
  opts: { locale?: 'en' | 'it' } = {},
): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript(
    ([ack, locale]) => {
      localStorage.setItem('sg.cookieNotice', ack);
      if (locale) localStorage.setItem('sg.locale', locale);
    },
    ['ack', opts.locale ?? ''] as const,
  );
  return page;
}
