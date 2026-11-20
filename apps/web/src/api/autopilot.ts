import { createContext, createElement, useContext, type ReactNode } from 'react';
import {
  AutopilotResponseSchema,
  AutopilotSettingsPatchSchema,
  type AutopilotCommand,
  type AutopilotResponse,
  type AutopilotSettingsPatch,
} from '@santa/contracts';
import { api } from './client';

const base = (eventId: string) => `/api/events/${encodeURIComponent(eventId)}/autopilot`;

/** Organizer-only show autopilot REST boundary. */
export interface AutopilotApi {
  get(eventId: string): Promise<AutopilotResponse>;
  command(eventId: string, command: AutopilotCommand): Promise<AutopilotResponse>;
  patch(eventId: string, patch: AutopilotSettingsPatch): Promise<AutopilotResponse>;
}

export const httpAutopilotApi: AutopilotApi = {
  get: async (eventId) => AutopilotResponseSchema.parse(await api(base(eventId))),
  command: async (eventId, command) =>
    AutopilotResponseSchema.parse(
      await api(base(eventId), {
        method: 'POST',
        body: command,
      }),
    ),
  patch: async (eventId, patch) =>
    AutopilotResponseSchema.parse(
      await api(base(eventId), {
        method: 'PATCH',
        body: AutopilotSettingsPatchSchema.parse(patch),
      }),
    ),
};

const Ctx = createContext<AutopilotApi>(httpAutopilotApi);
export const AutopilotApiProvider = ({
  value,
  children,
}: {
  value: AutopilotApi;
  children: ReactNode;
}) => createElement(Ctx.Provider, { value }, children);
export const useAutopilotApi = () => useContext(Ctx);
