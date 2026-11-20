import { useRef } from 'react';

interface OrganizerEventStatePresence {
  organizer?: {
    displayConnected?: unknown;
  } | null;
}

/** Reads the optional server field without depending on a contracts version that includes it. */
export function serverDisplayPresence(snapshot: unknown): boolean | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined;
  const organizer = (snapshot as OrganizerEventStatePresence).organizer;
  if (typeof organizer !== 'object' || organizer === null) return undefined;
  const value = organizer.displayConnected;
  return typeof value === 'boolean' ? value : undefined;
}

/** Organizer readiness comes only from the authenticated org projection. */
export function useDisplayPresence(eventId: string, organizerSnapshot?: unknown) {
  const authoritative = useRef<{ eventId: string; value?: boolean }>({
    eventId,
  });
  if (authoritative.current.eventId !== eventId) {
    authoritative.current = { eventId };
  }
  const serverConnected = serverDisplayPresence(organizerSnapshot);
  if (serverConnected !== undefined) authoritative.current.value = serverConnected;

  return authoritative.current.value ?? false;
}
