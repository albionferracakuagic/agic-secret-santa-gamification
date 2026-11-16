import { createContext, createElement, useContext, type ReactNode } from 'react';
import {
  CastVoteResponseSchema,
  MyAssignmentResponseSchema,
  OwnGiftResponseSchema,
  OwnVotesResponseSchema,
  VotingStateSchema,
} from '@santa/contracts';
import type { z } from 'zod';
import { api, ApiError } from './client';

export type OwnGiftResponse = z.infer<typeof OwnGiftResponseSchema>;
export type MyAssignment = z.infer<typeof MyAssignmentResponseSchema>;
export type VotingState = z.infer<typeof VotingStateSchema>;
export type OwnVotes = z.infer<typeof OwnVotesResponseSchema>;
export type CastVoteResponse = z.infer<typeof CastVoteResponseSchema>;

/** Participant gameplay endpoints (gift, assignment, voting). Responses are schema-validated by the HTTP adapter. */
export interface PlayApi {
  getGift(): Promise<OwnGiftResponse>;
  saveGift(input: { name: string; description: string | null }): Promise<OwnGiftResponse>;
  uploadPhoto(file: File): Promise<OwnGiftResponse>;
  removePhoto(): Promise<OwnGiftResponse>;
  assignment(): Promise<MyAssignment>;
  voting(): Promise<VotingState>;
  ownVotes(): Promise<OwnVotes>;
  castVote(v: { categoryId: string; giftId: string }): Promise<CastVoteResponse>;
}

export const httpPlayApi: PlayApi = {
  getGift: async () => OwnGiftResponseSchema.parse(await api('/api/me/gift')),
  saveGift: async (body) =>
    OwnGiftResponseSchema.parse(await api('/api/me/gift', { method: 'PUT', body })),
  async uploadPhoto(file) {
    const form = new FormData();
    form.append('photo', file, file.name);
    const res = await fetch('/api/me/gift/photo', {
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
    return OwnGiftResponseSchema.parse(await res.json());
  },
  removePhoto: async () =>
    OwnGiftResponseSchema.parse(await api('/api/me/gift/photo', { method: 'DELETE' })),
  assignment: async () => MyAssignmentResponseSchema.parse(await api('/api/me/assignment')),
  voting: async () => VotingStateSchema.parse(await api('/api/me/voting')),
  ownVotes: async () => OwnVotesResponseSchema.parse(await api('/api/me/votes')),
  castVote: async (body) =>
    CastVoteResponseSchema.parse(await api('/api/me/votes', { method: 'POST', body })),
};

const Ctx = createContext<PlayApi>(httpPlayApi);
export const PlayApiProvider = ({ value, children }: { value: PlayApi; children: ReactNode }) =>
  createElement(Ctx.Provider, { value }, children);
export const usePlayApi = () => useContext(Ctx);
