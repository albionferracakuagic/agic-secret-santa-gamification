import { createContext, createElement, useContext, type ReactNode } from 'react';
import {
  AuditListResponseSchema,
  AwardDecisionResponseSchema,
  BoardActionResponseSchema,
  EventStatsSchema,
  IntegrityDetailsSchema,
  IntegrityReportSchema,
  OrganizerBoardsResponseSchema,
  OrganizerCeremonyStateSchema,
  type OrganizerGiftSchema,
  RemoveParticipantResponseSchema,
  UNMASK_GRANT_HEADER,
  UnmaskGrantResponseSchema,
  type BOARD_ACTIONS,
} from '@santa/contracts';
import type { z } from 'zod';
import { api } from './client';

export type CeremonyState = z.infer<typeof OrganizerCeremonyStateSchema>;
export type OrganizerBoards = z.infer<typeof OrganizerBoardsResponseSchema>;
export type BoardAction = (typeof BOARD_ACTIONS)[number];
export type EventStats = z.infer<typeof EventStatsSchema>;
export type IntegrityReport = z.infer<typeof IntegrityReportSchema>;
export type IntegrityDetails = z.infer<typeof IntegrityDetailsSchema>;
export type UnmaskGrant = z.infer<typeof UnmaskGrantResponseSchema>;
export type AuditEntries = z.infer<typeof AuditListResponseSchema>['entries'];
export type GiftModeration = {
  name?: string;
  description?: string | null;
  removePhoto?: boolean;
  hidden?: boolean;
};
export type ModeratedGift = z.infer<typeof OrganizerGiftSchema>;

/** Show control + admin endpoints (ceremony, boards, stats/integrity, unmask, moderation, audit). All responses are schema-validated. */
export interface AdminApi {
  ceremony(eventId: string): Promise<CeremonyState>;
  ceremonyAct(
    eventId: string,
    action: 'start' | 'restart' | 'pause' | 'resume' | 'cancel',
  ): Promise<CeremonyState>;
  ceremonyNext(eventId: string, fromIndex: number): Promise<CeremonyState>;
  decideAward(eventId: string, boardKey: string, giftId: string): Promise<void>;
  boards(eventId: string): Promise<OrganizerBoards>;
  boardAction(
    eventId: string,
    boardKey: string,
    action: BoardAction,
    acknowledgeSmallCohort?: boolean,
  ): Promise<void>;
  stats(eventId: string): Promise<EventStats>;
  integrity(eventId: string): Promise<IntegrityReport>;
  integrityDetails(eventId: string, grantId: string): Promise<IntegrityDetails>;
  unmask(eventId: string, reason: string): Promise<UnmaskGrant>;
  revokeUnmask(eventId: string, grantId: string): Promise<void>;
  removeParticipant(
    eventId: string,
    participantId: string,
    reason?: string,
  ): Promise<{ votesRemoved: number }>;
  moderateGift(eventId: string, giftId: string, patch: GiftModeration): Promise<void>;
  audit(eventId: string): Promise<AuditEntries>;
}

const base = (id: string) => `/api/events/${encodeURIComponent(id)}`;
const post = (id: string, path: string, body?: unknown) =>
  api(`${base(id)}/${path}`, { method: 'POST', ...(body !== undefined ? { body } : {}) });

export const httpAdminApi: AdminApi = {
  ceremony: async (id) => OrganizerCeremonyStateSchema.parse(await api(`${base(id)}/ceremony`)),
  ceremonyAct: async (id, action) =>
    OrganizerCeremonyStateSchema.parse(await post(id, `ceremony/${action}`)),
  ceremonyNext: async (id, fromIndex) =>
    OrganizerCeremonyStateSchema.parse(await post(id, 'ceremony/next', { fromIndex })),
  decideAward: async (id, boardKey, giftId) => {
    AwardDecisionResponseSchema.parse(
      await post(id, `awards/${encodeURIComponent(boardKey)}/decide`, { giftId }),
    );
  },
  boards: async (id) => OrganizerBoardsResponseSchema.parse(await api(`${base(id)}/boards`)),
  boardAction: async (id, boardKey, action, ack) => {
    BoardActionResponseSchema.parse(
      await post(id, `boards/${encodeURIComponent(boardKey)}`, {
        action,
        ...(ack ? { acknowledgeSmallCohort: true } : {}),
      }),
    );
  },
  stats: async (id) => EventStatsSchema.parse(await api(`${base(id)}/stats`)),
  integrity: async (id) => IntegrityReportSchema.parse(await api(`${base(id)}/integrity`)),
  integrityDetails: async (id, grantId) =>
    IntegrityDetailsSchema.parse(
      await api(`${base(id)}/integrity/details`, { headers: { [UNMASK_GRANT_HEADER]: grantId } }),
    ),
  unmask: async (id, reason) =>
    UnmaskGrantResponseSchema.parse(await post(id, 'unmask', { confirm: true, reason })),
  revokeUnmask: async (id, grantId) => {
    await post(id, `unmask/${encodeURIComponent(grantId)}/revoke`);
  },
  removeParticipant: async (id, pid, reason) => {
    const r = RemoveParticipantResponseSchema.parse(
      await post(id, `participants/${encodeURIComponent(pid)}/remove`, reason ? { reason } : {}),
    );
    return { votesRemoved: r.votesRemoved };
  },
  moderateGift: async (id, giftId, patch) => {
    await api(`${base(id)}/gifts/${encodeURIComponent(giftId)}`, { method: 'PATCH', body: patch });
  },
  audit: async (id) => AuditListResponseSchema.parse(await api(`${base(id)}/audit`)).entries,
};

const Ctx = createContext<AdminApi>(httpAdminApi);
export const AdminApiProvider = ({ value, children }: { value: AdminApi; children: ReactNode }) =>
  createElement(Ctx.Provider, { value }, children);
export const useAdminApi = () => useContext(Ctx);
