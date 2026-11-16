import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { ClaimRequestSchema, EventStateOutput } from '@santa/contracts';
import type { z } from 'zod';
import { api } from './client';

export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;
export type Me = Extract<EventStateOutput, { role: 'participant' }>['me'];

export interface RosterEntry {
  participantId: string;
  displayName: string;
  avatar: string | null;
  available: boolean;
}
export interface JoinPreview {
  eventName: string;
  roster: RosterEntry[];
}
export type JoinStatus = 'pending' | 'active';

/**
 * Thin typed boundary for join / profile endpoints. The HTTP adapter below is the only place that knows paths;
 * swap it (or its DTO mapping) when the backend contracts land in @santa/contracts.
 */
export interface ParticipantApi {
  preview(input: { token?: string; shortCode?: string }): Promise<JoinPreview>;
  pickName(participantId: string): Promise<{ status: JoinStatus }>;
  claim(req: ClaimRequest): Promise<{ status: 'active' }>;
  me(): Promise<Me>;
  updateProfile(patch: { displayName?: string; avatar?: string | null }): Promise<Me>;
}

export const httpParticipantApi: ParticipantApi = {
  preview: (input) => api('/api/join/preview', { method: 'POST', body: input }),
  pickName: (participantId) => api('/api/join/pick', { method: 'POST', body: { participantId } }),
  claim: (req) => api('/api/join/claim', { method: 'POST', body: req }),
  me: () => api('/api/me'),
  updateProfile: (patch) => api('/api/me', { method: 'PATCH', body: patch }),
};

const Ctx = createContext<ParticipantApi>(httpParticipantApi);
export const ParticipantApiProvider = ({
  value,
  children,
}: {
  value: ParticipantApi;
  children: ReactNode;
}) => createElement(Ctx.Provider, { value }, children);
export const useParticipantApi = () => useContext(Ctx);
