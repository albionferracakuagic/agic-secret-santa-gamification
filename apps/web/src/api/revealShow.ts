import {
  MyRevealShowResponseSchema,
  RevealShowStateSchema,
  ShowChoiceVoteResponseSchema,
  TreeLightResponseSchema,
  type ShowChoiceVoteRequest,
} from '@santa/contracts';
import { api } from './client';

const host = (eventId: string) => `/api/events/${encodeURIComponent(eventId)}/reveal`;

export const revealShowApi = {
  mine: async () => MyRevealShowResponseSchema.parse(await api('/api/me/reveal/show')),
  light: async (giftId: string) =>
    TreeLightResponseSchema.parse(
      await api(`/api/me/reveal/gifts/${encodeURIComponent(giftId)}/light`, { method: 'POST' }),
    ),
  vote: async (body: ShowChoiceVoteRequest) =>
    ShowChoiceVoteResponseSchema.parse(
      await api('/api/me/reveal/choice', { method: 'POST', body }),
    ),
  state: async (eventId: string) => RevealShowStateSchema.parse(await api(`${host(eventId)}/show`)),
  round: async (eventId: string, cancel: boolean) =>
    RevealShowStateSchema.parse(
      await api(`${host(eventId)}/choice${cancel ? '/cancel' : ''}`, { method: 'POST' }),
    ),
};
