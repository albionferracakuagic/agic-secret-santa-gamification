import { createContext, createElement, useContext, type ReactNode } from 'react';
import {
  AssignMissionsResponseSchema,
  BingoDecisionResponseSchema,
  BingoMarkResponseSchema,
  BingoPendingResponseSchema,
  ClueDecisionResponseSchema,
  ClueQueueResponseSchema,
  CreateGameRequestSchema,
  GameActionResponseSchema,
  MyCluesResponseSchema,
  MyGameResponseSchema,
  MyMissionsResponseSchema,
  MyCertificatesResponseSchema,
  GuessStateResponseSchema,
  MissionOptOutResponseSchema,
  OrganizerGamesResponseSchema,
  OrganizerMissionsResponseSchema,
  PresentResponseSchema,
  ReassignMissionResponseSchema,
  SetGuessResponseSchema,
  SubmitAnswerResponseSchema,
  SubmitClueResponseSchema,
  SubmitMissionResponseSchema,
  VerifyMissionResponseSchema,
  HideSpotlightResponseSchema,
  type GAME_ACTIONS,
  type SpotlightKind,
} from '@santa/contracts';
import type { z } from 'zod';
import { api } from './client';

type Out<S extends z.ZodType> = z.infer<S>;
export type GuessState = Out<typeof GuessStateResponseSchema>;
export type MyClues = Out<typeof MyCluesResponseSchema>;
export type MyMissions = Out<typeof MyMissionsResponseSchema>;
export type MyMission = MyMissions['missions'][number];
export type MyGame = Out<typeof MyGameResponseSchema>;
export type MyCertificates = Out<typeof MyCertificatesResponseSchema>;
export type ClueQueue = Out<typeof ClueQueueResponseSchema>;
export type OrganizerMissions = Out<typeof OrganizerMissionsResponseSchema>;
export type OrganizerGames = Out<typeof OrganizerGamesResponseSchema>;
export type BingoPending = Out<typeof BingoPendingResponseSchema>;
export type PresentResult = Out<typeof PresentResponseSchema>;
export type CreateGameInput = z.input<typeof CreateGameRequestSchema>;
export type GameAction = (typeof GAME_ACTIONS)[number];

/** Phase 2 endpoints (guess, clues, missions, games, certificates); every HTTP response is validated with the contract schemas. */
export interface Phase2Api {
  guessState(): Promise<GuessState>;
  setGuess(giftId: string, suspectId: string): Promise<void>;
  myClues(): Promise<MyClues>;
  submitClue(text: string): Promise<void>;
  myMissions(): Promise<MyMissions>;
  setMissionOptOut(optOut: boolean): Promise<void>;
  submitMission(assignmentId: string, note?: string): Promise<void>;
  reassignMission(assignmentId: string): Promise<MyMission>;
  myGame(): Promise<MyGame>;
  submitAnswer(answerId: string): Promise<void>;
  markBingo(cell: number): Promise<void>;
  myCertificates(): Promise<MyCertificates>;
  fetchCertificate(url: string, locale: 'en' | 'it'): Promise<Blob>;

  clueQueue(eventId: string): Promise<ClueQueue>;
  decideClue(eventId: string, clueId: string, action: 'approve' | 'reject'): Promise<void>;
  present(eventId: string, kind: SpotlightKind): Promise<PresentResult>;
  hideSpotlight(eventId: string): Promise<void>;
  organizerMissions(eventId: string): Promise<OrganizerMissions>;
  assignMissions(eventId: string, perParticipant?: number): Promise<{ assigned: number }>;
  verifyMission(
    eventId: string,
    assignmentId: string,
    action: 'verify' | 'reject' | 'reassign',
  ): Promise<void>;
  organizerGames(eventId: string): Promise<OrganizerGames>;
  createGame(eventId: string, input: CreateGameInput): Promise<void>;
  gameAction(eventId: string, gameId: string, action: GameAction): Promise<void>;
  bingoPending(eventId: string, gameId: string): Promise<BingoPending>;
  decideBingo(
    eventId: string,
    gameId: string,
    markId: string,
    action: 'confirm' | 'reject',
  ): Promise<void>;
}

const ev = (id: string) => `/api/events/${encodeURIComponent(id)}`;
const seg = encodeURIComponent;

export const httpPhase2Api: Phase2Api = {
  guessState: async () => GuessStateResponseSchema.parse(await api('/api/me/guess')),
  setGuess: async (giftId, suspectId) => {
    SetGuessResponseSchema.parse(
      await api(`/api/me/guesses/${seg(giftId)}`, { method: 'PUT', body: { suspectId } }),
    );
  },
  myClues: async () => MyCluesResponseSchema.parse(await api('/api/me/clues')),
  submitClue: async (text) => {
    SubmitClueResponseSchema.parse(await api('/api/me/clues', { method: 'POST', body: { text } }));
  },
  myMissions: async () => MyMissionsResponseSchema.parse(await api('/api/me/missions')),
  setMissionOptOut: async (optOut) => {
    MissionOptOutResponseSchema.parse(
      await api('/api/me/missions/opt-out', { method: 'POST', body: { optOut } }),
    );
  },
  submitMission: async (id, note) => {
    SubmitMissionResponseSchema.parse(
      await api(`/api/me/missions/${seg(id)}/submit`, {
        method: 'POST',
        body: note ? { note } : {},
      }),
    );
  },
  reassignMission: async (id) =>
    ReassignMissionResponseSchema.parse(
      await api(`/api/me/missions/${seg(id)}/reassign`, { method: 'POST' }),
    ),
  myGame: async () => MyGameResponseSchema.parse(await api('/api/me/game')),
  submitAnswer: async (answerId) => {
    SubmitAnswerResponseSchema.parse(
      await api('/api/me/game/answers', { method: 'POST', body: { answerId } }),
    );
  },
  markBingo: async (cell) => {
    BingoMarkResponseSchema.parse(
      await api('/api/me/game/bingo-marks', { method: 'POST', body: { cell } }),
    );
  },
  myCertificates: async () => MyCertificatesResponseSchema.parse(await api('/api/me/certificates')),
  async fetchCertificate(url, locale) {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}locale=${locale}`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error('certificate');
    return res.blob();
  },

  clueQueue: async (id) => ClueQueueResponseSchema.parse(await api(`${ev(id)}/clues`)),
  decideClue: async (id, clueId, action) => {
    ClueDecisionResponseSchema.parse(
      await api(`${ev(id)}/clues/${seg(clueId)}`, { method: 'POST', body: { action } }),
    );
  },
  present: async (id, kind) =>
    PresentResponseSchema.parse(
      await api(`${ev(id)}/presentations`, { method: 'POST', body: { kind } }),
    ),
  hideSpotlight: async (id) => {
    HideSpotlightResponseSchema.parse(await api(`${ev(id)}/presentations`, { method: 'DELETE' }));
  },
  organizerMissions: async (id) =>
    OrganizerMissionsResponseSchema.parse(await api(`${ev(id)}/missions`)),
  assignMissions: async (id, perParticipant) =>
    AssignMissionsResponseSchema.parse(
      await api(`${ev(id)}/missions/assign`, {
        method: 'POST',
        body: perParticipant ? { perParticipant } : {},
      }),
    ),
  verifyMission: async (id, assignmentId, action) => {
    VerifyMissionResponseSchema.parse(
      await api(`${ev(id)}/missions/${seg(assignmentId)}`, { method: 'POST', body: { action } }),
    );
  },
  organizerGames: async (id) => OrganizerGamesResponseSchema.parse(await api(`${ev(id)}/games`)),
  createGame: async (id, input) => {
    await api(`${ev(id)}/games`, { method: 'POST', body: CreateGameRequestSchema.parse(input) });
  },
  gameAction: async (id, gameId, action) => {
    GameActionResponseSchema.parse(
      await api(`${ev(id)}/games/${seg(gameId)}`, { method: 'POST', body: { action } }),
    );
  },
  bingoPending: async (id, gameId) =>
    BingoPendingResponseSchema.parse(await api(`${ev(id)}/games/${seg(gameId)}/bingo-marks`)),
  decideBingo: async (id, gameId, markId, action) => {
    BingoDecisionResponseSchema.parse(
      await api(`${ev(id)}/games/${seg(gameId)}/bingo-marks/${seg(markId)}`, {
        method: 'POST',
        body: { action },
      }),
    );
  },
};

const Ctx = createContext<Phase2Api>(httpPhase2Api);
export const Phase2ApiProvider = ({ value, children }: { value: Phase2Api; children: ReactNode }) =>
  createElement(Ctx.Provider, { value }, children);
export const usePhase2Api = () => useContext(Ctx);
