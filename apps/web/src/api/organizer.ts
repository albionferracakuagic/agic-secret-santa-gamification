import { createContext, createElement, useContext, type ReactNode } from 'react';
import {
  ApproveParticipantResponseSchema,
  ClaimCodesResponseSchema,
  ClaimEmailLinksResponseSchema,
  CreateAccessResponseSchema,
  CloseVotingResponseSchema,
  OpeningStateSchema,
  OrganizerGiftListResponseSchema,
  OrganizerParticipantsResponseSchema,
  RevealAllResponseSchema,
  RevealGiftResponseSchema,
  VotingStateSchema,
  PairingImportLatestResponseSchema,
  PairingImportResultSchema,
  type PairingMapping,
} from '@santa/contracts';
import type { z } from 'zod';
import { api, ApiError } from './client';

export type PairingImportResult = z.infer<typeof PairingImportResultSchema>;
export type PairingLatest = z.infer<typeof PairingImportLatestResponseSchema>;
export type ClaimCodes = z.infer<typeof ClaimCodesResponseSchema>;
export type AccessLink = z.infer<typeof CreateAccessResponseSchema>;
export type RosterRow = z.infer<typeof OrganizerParticipantsResponseSchema>['participants'][number];
export type OpeningState = z.infer<typeof OpeningStateSchema>;
export type OrganizerGift = z.infer<typeof OrganizerGiftListResponseSchema>['gifts'][number];
export type VotingState = z.infer<typeof VotingStateSchema>;

/** Organizer-only endpoints. Responses are schema-validated; no pairs/emails ever reach this layer. */
export interface OrganizerApi {
  uploadPairing(
    eventId: string,
    file: File,
    opts?: { sheet?: string | undefined; mapping?: PairingMapping | undefined },
  ): Promise<PairingImportResult>;
  latestPairing(eventId: string): Promise<PairingLatest>;
  createAccess(eventId: string, kind: 'join' | 'display'): Promise<AccessLink>;
  claimCodes(eventId: string): Promise<ClaimCodes>;
  sendEmailLinks(eventId: string): Promise<{ sent: number }>;
  listRoster(eventId: string): Promise<{ participants: RosterRow[] }>;
  approve(eventId: string, participantId: string): Promise<void>;
  setReactionsEnabled(eventId: string, enabled: boolean): Promise<void>;
  muteParticipant(eventId: string, participantId: string, muted: boolean): Promise<void>;
  openingState(eventId: string): Promise<OpeningState>;
  openingNext(eventId: string): Promise<OpeningState>;
  openingOrder(
    eventId: string,
    order: { mode: 'random' } | { mode: 'manual'; order: string[] },
  ): Promise<OpeningState>;
  listGifts(eventId: string): Promise<OrganizerGift[]>;
  openVoting(eventId: string, durationMinutes?: number): Promise<VotingState>;
  closeVoting(
    eventId: string,
  ): Promise<{ categoriesLocked: number; categoriesPublishable: number }>;
  revealGift(eventId: string, giftId: string): Promise<void>;
  revealAll(eventId: string): Promise<{ revealed: number }>;
}

const base = (eventId: string) => `/api/events/${encodeURIComponent(eventId)}`;

const post = (id: string, path: string, body?: unknown) =>
  api(`${base(id)}/${path}`, { method: 'POST', ...(body !== undefined ? { body } : {}) });

export const httpOrganizerApi: OrganizerApi = {
  async uploadPairing(eventId, file, opts = {}) {
    const form = new FormData();
    form.append('file', file, file.name);
    if (opts.sheet) form.append('sheet', opts.sheet);
    if (opts.mapping) form.append('mapping', JSON.stringify(opts.mapping));
    const res = await fetch(`${base(eventId)}/pairing-imports`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: form,
    });
    if (!res.ok) {
      const code = await res
        .json()
        .then((j: { error?: { code?: string } }) => j.error?.code ?? 'generic')
        .catch(() => 'generic');
      throw new ApiError(res.status, code);
    }
    return PairingImportResultSchema.parse(await res.json());
  },
  latestPairing: async (id) =>
    PairingImportLatestResponseSchema.parse(await api(`${base(id)}/pairing-imports/latest`)),
  createAccess: async (id, kind) =>
    CreateAccessResponseSchema.parse(
      await api(`${base(id)}/access`, { method: 'POST', body: { kind } }),
    ),
  claimCodes: async (id) =>
    ClaimCodesResponseSchema.parse(await api(`${base(id)}/claims/codes`, { method: 'POST' })),
  sendEmailLinks: async (id) =>
    ClaimEmailLinksResponseSchema.parse(
      await api(`${base(id)}/claims/email-links`, { method: 'POST' }),
    ),
  listRoster: async (id) =>
    OrganizerParticipantsResponseSchema.parse(await api(`${base(id)}/participants`)),
  approve: async (id, pid) => {
    ApproveParticipantResponseSchema.parse(
      await api(`${base(id)}/participants/${encodeURIComponent(pid)}/approve`, { method: 'POST' }),
    );
  },
  setReactionsEnabled: async (id, enabled) => {
    await api(`${base(id)}/reactions/settings`, { method: 'POST', body: { enabled } });
  },
  muteParticipant: async (id, pid, muted) => {
    await api(`${base(id)}/participants/${encodeURIComponent(pid)}/mute`, {
      method: 'POST',
      body: { muted },
    });
  },
  openingState: async (id) => OpeningStateSchema.parse(await api(`${base(id)}/opening`)),
  openingNext: async (id) => OpeningStateSchema.parse(await post(id, 'opening/next')),
  openingOrder: async (id, o) => OpeningStateSchema.parse(await post(id, 'opening/order', o)),
  listGifts: async (id) =>
    OrganizerGiftListResponseSchema.parse(await api(`${base(id)}/gifts`)).gifts,
  openVoting: async (id, durationMinutes) =>
    VotingStateSchema.parse(
      await post(id, 'voting/open', durationMinutes ? { durationMinutes } : {}),
    ),
  closeVoting: async (id) => {
    const r = CloseVotingResponseSchema.parse(await post(id, 'voting/close'));
    return { categoriesLocked: r.categoriesLocked, categoriesPublishable: r.categoriesPublishable };
  },
  revealGift: async (id, giftId) => {
    RevealGiftResponseSchema.parse(await post(id, `reveal/gifts/${encodeURIComponent(giftId)}`));
  },
  revealAll: async (id) => RevealAllResponseSchema.parse(await post(id, 'reveal/all')),
};
const Ctx = createContext<OrganizerApi>(httpOrganizerApi);
export const OrganizerApiProvider = ({
  value,
  children,
}: {
  value: OrganizerApi;
  children: ReactNode;
}) => createElement(Ctx.Provider, { value }, children);
export const useOrganizerApi = () => useContext(Ctx);
