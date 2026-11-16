import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';

export interface OrganizerMe {
  userId: string;
  email: string;
  isPlatformAdmin: boolean;
}

/** `data === null` means signed out (401); other errors surface as query errors. */
export function useOrganizer() {
  return useQuery({
    queryKey: ['organizer', 'me'],
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<OrganizerMe | null> => {
      try {
        return await api<OrganizerMe>('/api/organizer/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}

export function useProviders() {
  return useQuery({
    queryKey: ['config'],
    staleTime: Infinity,
    queryFn: () => api<{ providers: { google: boolean; microsoft: boolean } }>('/api/config'),
  });
}
