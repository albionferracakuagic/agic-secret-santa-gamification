import { createContext, createElement, useContext, type ReactNode } from 'react';
import {
  AccountLinkConfirmResponseSchema,
  AccountLinkStartResponseSchema,
  ArchiveResponseSchema,
  AwardCustomAchievementResponseSchema,
  CoinGrantResponseSchema,
  CustomAchievementsResponseSchema,
  EventFeaturesResponseSchema,
  HallOfFameResponseSchema,
  LifetimeResponseSchema,
  MyAuctionResponseSchema,
  MyCoinsResponseSchema,
  OrganizerCategoriesResponseSchema,
  OrganizerCoinsResponseSchema,
  OrganizerPrizeSchema,
  OrganizerPrizesResponseSchema,
  PlaceBidResponseSchema,
  PrizeActionResponseSchema,
  type CreateCategoryRequestSchema,
  type CreateCustomAchievementRequestSchema,
  type CreatePrizeRequestSchema,
  type FeaturesPatch,
  type PRIZE_ACTIONS,
  type UpdateCategoryRequestSchema,
  type UpdatePrizeRequestSchema,
} from '@santa/contracts';
import type { z } from 'zod';
import { api } from './client';

type Out<S extends z.ZodType> = z.infer<S>;
export type FeaturesView = Out<typeof EventFeaturesResponseSchema>;
export type MyCoins = Out<typeof MyCoinsResponseSchema>;
export type OrganizerCoins = Out<typeof OrganizerCoinsResponseSchema>;
export type MyAuction = Out<typeof MyAuctionResponseSchema>;
export type PlaceBid = Out<typeof PlaceBidResponseSchema>;
export type OrganizerPrizes = Out<typeof OrganizerPrizesResponseSchema>;
export type OrganizerPrize = Out<typeof OrganizerPrizeSchema>;
export type PrizeAction = (typeof PRIZE_ACTIONS)[number];
export type PrizeInput = z.input<typeof CreatePrizeRequestSchema>;
export type PrizePatch = z.input<typeof UpdatePrizeRequestSchema>;
export type Archive = Out<typeof ArchiveResponseSchema>;
export type HallOfFame = Out<typeof HallOfFameResponseSchema>;
export type Lifetime = Out<typeof LifetimeResponseSchema>;
export type OrganizerCategories = Out<typeof OrganizerCategoriesResponseSchema>;
export type CustomAchievements = Out<typeof CustomAchievementsResponseSchema>;
export type CategoryInput = z.input<typeof CreateCategoryRequestSchema>;
export type CategoryPatch = z.input<typeof UpdateCategoryRequestSchema>;
export type CustomAchievementInput = z.input<typeof CreateCustomAchievementRequestSchema>;

/** Phase 3 endpoints (features, coins, auction, history, account link, custom content), validated with the contract schemas. */
export interface Phase3Api {
  myCoins(): Promise<MyCoins>;
  myAuction(): Promise<MyAuction>;
  placeBid(amount: number): Promise<PlaceBid>;
  myHistory(): Promise<Archive>;
  myHallOfFame(): Promise<HallOfFame>;
  myLifetime(): Promise<Lifetime>;
  startAccountLink(email: string): Promise<void>;
  confirmAccountLink(token: string): Promise<void>;

  updateFeatures(eventId: string, patch: FeaturesPatch): Promise<FeaturesView>;
  organizerCoins(eventId: string): Promise<OrganizerCoins>;
  grantCoins(
    eventId: string,
    g: { key: string; amount: number; participantIds?: string[] },
  ): Promise<{ granted: number }>;
  prizes(eventId: string): Promise<OrganizerPrizes>;
  createPrize(eventId: string, input: PrizeInput): Promise<void>;
  updatePrize(eventId: string, prizeId: string, patch: PrizePatch): Promise<void>;
  deletePrize(eventId: string, prizeId: string): Promise<void>;
  prizeAction(
    eventId: string,
    prizeId: string,
    action: PrizeAction,
    durationSeconds?: number,
  ): Promise<void>;
  archive(eventId: string): Promise<Archive>;
  hallOfFame(eventId: string): Promise<HallOfFame>;
  categories(eventId: string): Promise<OrganizerCategories>;
  createCategory(eventId: string, input: CategoryInput): Promise<OrganizerCategories>;
  updateCategory(
    eventId: string,
    categoryId: string,
    patch: CategoryPatch,
  ): Promise<OrganizerCategories>;
  deleteCategory(eventId: string, categoryId: string): Promise<OrganizerCategories>;
  customAchievements(eventId: string): Promise<CustomAchievements>;
  createCustomAchievement(
    eventId: string,
    input: CustomAchievementInput,
  ): Promise<CustomAchievements>;
  deleteCustomAchievement(eventId: string, id: string): Promise<CustomAchievements>;
  awardCustomAchievement(
    eventId: string,
    id: string,
    participantIds: string[],
  ): Promise<{ awarded: number }>;
}

const ev = (id: string) => `/api/events/${encodeURIComponent(id)}`;
const seg = encodeURIComponent;

export const httpPhase3Api: Phase3Api = {
  myCoins: async () => MyCoinsResponseSchema.parse(await api('/api/me/coins')),
  myAuction: async () => MyAuctionResponseSchema.parse(await api('/api/me/auction')),
  placeBid: async (amount) =>
    PlaceBidResponseSchema.parse(
      await api('/api/me/auction/bids', { method: 'POST', body: { amount } }),
    ),
  myHistory: async () => ArchiveResponseSchema.parse(await api('/api/me/history')),
  myHallOfFame: async () => HallOfFameResponseSchema.parse(await api('/api/me/hall-of-fame')),
  myLifetime: async () => LifetimeResponseSchema.parse(await api('/api/me/lifetime')),
  startAccountLink: async (email) => {
    AccountLinkStartResponseSchema.parse(
      await api('/api/me/account-link', { method: 'POST', body: { email } }),
    );
  },
  confirmAccountLink: async (token) => {
    AccountLinkConfirmResponseSchema.parse(
      await api('/api/account-link/confirm', { method: 'POST', body: { token } }),
    );
  },

  updateFeatures: async (id, patch) =>
    EventFeaturesResponseSchema.parse(
      await api(`${ev(id)}/features`, { method: 'PATCH', body: patch }),
    ),
  organizerCoins: async (id) => OrganizerCoinsResponseSchema.parse(await api(`${ev(id)}/coins`)),
  grantCoins: async (id, g) =>
    CoinGrantResponseSchema.parse(await api(`${ev(id)}/coins/grants`, { method: 'POST', body: g })),
  prizes: async (id) => OrganizerPrizesResponseSchema.parse(await api(`${ev(id)}/auction/prizes`)),
  createPrize: async (id, input) => {
    OrganizerPrizeSchema.parse(
      await api(`${ev(id)}/auction/prizes`, { method: 'POST', body: input }),
    );
  },
  updatePrize: async (id, prizeId, patch) => {
    OrganizerPrizeSchema.parse(
      await api(`${ev(id)}/auction/prizes/${seg(prizeId)}`, { method: 'PATCH', body: patch }),
    );
  },
  deletePrize: async (id, prizeId) => {
    await api(`${ev(id)}/auction/prizes/${seg(prizeId)}`, { method: 'DELETE' });
  },
  prizeAction: async (id, prizeId, action, durationSeconds) => {
    PrizeActionResponseSchema.parse(
      await api(`${ev(id)}/auction/prizes/${seg(prizeId)}`, {
        method: 'POST',
        body: { action, ...(durationSeconds ? { durationSeconds } : {}) },
      }),
    );
  },
  archive: async (id) => ArchiveResponseSchema.parse(await api(`${ev(id)}/archive`)),
  hallOfFame: async (id) => HallOfFameResponseSchema.parse(await api(`${ev(id)}/hall-of-fame`)),
  categories: async (id) =>
    OrganizerCategoriesResponseSchema.parse(await api(`${ev(id)}/categories`)),
  createCategory: async (id, input) =>
    OrganizerCategoriesResponseSchema.parse(
      await api(`${ev(id)}/categories`, { method: 'POST', body: input }),
    ),
  updateCategory: async (id, cid, patch) =>
    OrganizerCategoriesResponseSchema.parse(
      await api(`${ev(id)}/categories/${seg(cid)}`, { method: 'PATCH', body: patch }),
    ),
  deleteCategory: async (id, cid) =>
    OrganizerCategoriesResponseSchema.parse(
      await api(`${ev(id)}/categories/${seg(cid)}`, { method: 'DELETE' }),
    ),
  customAchievements: async (id) =>
    CustomAchievementsResponseSchema.parse(await api(`${ev(id)}/custom-achievements`)),
  createCustomAchievement: async (id, input) =>
    CustomAchievementsResponseSchema.parse(
      await api(`${ev(id)}/custom-achievements`, { method: 'POST', body: input }),
    ),
  deleteCustomAchievement: async (id, aid) =>
    CustomAchievementsResponseSchema.parse(
      await api(`${ev(id)}/custom-achievements/${seg(aid)}`, { method: 'DELETE' }),
    ),
  awardCustomAchievement: async (id, aid, participantIds) =>
    AwardCustomAchievementResponseSchema.parse(
      await api(`${ev(id)}/custom-achievements/${seg(aid)}/awards`, {
        method: 'POST',
        body: { participantIds },
      }),
    ),
};

const Ctx = createContext<Phase3Api>(httpPhase3Api);
export const Phase3ApiProvider = ({ value, children }: { value: Phase3Api; children: ReactNode }) =>
  createElement(Ctx.Provider, { value }, children);
export const usePhase3Api = () => useContext(Ctx);
