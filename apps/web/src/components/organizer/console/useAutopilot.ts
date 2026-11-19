import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AutopilotCommand,
  AutopilotResponse,
  AutopilotSettingsPatch,
  AutopilotState,
} from '@santa/contracts';
import { useAutopilotApi } from '../../../api/autopilot';
import { useRealtime } from '../../../realtime/react';

export const autopilotQueryKey = (eventId: string) => ['autopilot', eventId] as const;

/**
 * Autopilot REST state plus the organizer-only realtime repush bridge.
 * The projected state remains an immediate fallback while the richer GET response is loading.
 */
export function useAutopilot(eventId: string, projected?: AutopilotState | undefined) {
  const api = useAutopilotApi();
  const qc = useQueryClient();
  const { state: realtime, rt } = useRealtime(eventId);
  const queryKey = useMemo(() => autopilotQueryKey(eventId), [eventId]);
  const q = useQuery({
    queryKey,
    queryFn: () => api.get(eventId),
    enabled: !!eventId && !!projected,
  });
  const orgEventState = realtime.surfaces.org?.eventState;

  useEffect(() => {
    if (orgEventState === undefined) return;
    void qc.invalidateQueries({ queryKey });
    void qc.invalidateQueries({ queryKey: ['event', eventId] });
  }, [eventId, orgEventState, qc, queryKey]);

  const storeResponse = (response: AutopilotResponse) => {
    qc.setQueryData(queryKey, response);
  };
  const command = useMutation({
    mutationFn: (input: AutopilotCommand) => api.command(eventId, input),
    onSuccess: storeResponse,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ['event', eventId] });
    },
  });
  const patch = useMutation({
    mutationFn: (input: AutopilotSettingsPatch) => api.patch(eventId, input),
    onSuccess: storeResponse,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ['event', eventId] });
    },
  });

  return {
    response: q.data,
    state: q.data?.state ?? projected,
    query: q,
    command,
    patch,
    realtimeStatus: realtime.status,
    displayConnected:
      realtime.status === 'live' && realtime.surfaces.pub?.eventState !== undefined,
    serverNow: () => rt?.serverNow() ?? Date.now(),
  };
}
