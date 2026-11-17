import { createContext, createElement, useContext, type ReactNode } from 'react';
import {
  ClaimRequestSchema,
  ClaimResponseSchema,
  JoinResolveResponseSchema,
  MeResponseSchema,
  type ProfileUpdateRequestSchema,
} from '@santa/contracts';
import type { z } from 'zod';
import { api } from './client';

export type JoinTarget = { joinToken: string } | { shortCode: string };
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;
export type JoinResolve = z.infer<typeof JoinResolveResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type ProfilePatch = z.infer<typeof ProfileUpdateRequestSchema>;

/** Boundary used by the join, profile and display screens; the HTTP adapter validates every response with the contract schemas. */
export interface ParticipantApi {
  resolve(target: JoinTarget): Promise<JoinResolve>;
  claim(req: ClaimRequest): Promise<ClaimResponse>;
  me(): Promise<MeResponse>;
  updateProfile(patch: ProfilePatch): Promise<MeResponse>;
  exchangeDisplayToken(token: string): Promise<void>;
}

export const httpParticipantApi: ParticipantApi = {
  resolve: async (target) =>
    JoinResolveResponseSchema.parse(
      await api('/api/join/resolve', { method: 'POST', body: target }),
    ),
  claim: async (req) =>
    ClaimResponseSchema.parse(
      await api('/api/join/claim', { method: 'POST', body: ClaimRequestSchema.parse(req) }),
    ),
  me: async () => MeResponseSchema.parse(await api('/api/me')),
  updateProfile: async (patch) =>
    MeResponseSchema.parse(await api('/api/me/profile', { method: 'PATCH', body: patch })),
  exchangeDisplayToken: async (token) => {
    await api('/api/join/display', { method: 'POST', body: { token } });
  },
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
