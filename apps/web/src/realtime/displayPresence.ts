import { useEffect, useRef, useState } from 'react';

const PREFIX = 'santa:display-presence:';
const CHANGED_EVENT = 'santa:display-presence-changed';
const HEARTBEAT_MS = 1_500;
const PRESENCE_TTL_MS = 4_500;

interface DisplayPresence {
  eventId: string;
  clientId: string;
  expiresAt: number;
}

interface OrganizerEventStatePresence {
  organizer?: {
    displayConnected?: unknown;
  } | null;
}

const keyFor = (eventId: string) => `${PREFIX}${eventId}`;

function notifyChanged() {
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/** Browser-local liveness marker written only after a display socket receives its own event projection. */
export function publishDisplayPresence(
  eventId: string,
  clientId: string,
  now = Date.now(),
) {
  const value: DisplayPresence = {
    eventId,
    clientId,
    expiresAt: now + PRESENCE_TTL_MS,
  };
  try {
    localStorage.setItem(keyFor(eventId), JSON.stringify(value));
    notifyChanged();
  } catch {
    // Storage can be unavailable in private/locked-down contexts; never claim readiness.
  }
}

/** Clears only this display instance's marker, so closing one of several displays is safe. */
export function removeDisplayPresence(eventId: string, clientId: string) {
  try {
    const raw = localStorage.getItem(keyFor(eventId));
    const value = raw ? (JSON.parse(raw) as Partial<DisplayPresence>) : undefined;
    if (value?.clientId !== clientId) return;
    localStorage.removeItem(keyFor(eventId));
    notifyChanged();
  } catch {
    // Best effort only; an unparseable or unavailable marker expires/does not count.
  }
}

export function isDisplayPresenceConnected(eventId: string, now = Date.now()) {
  if (!eventId) return false;
  try {
    const raw = localStorage.getItem(keyFor(eventId));
    if (!raw) return false;
    const value = JSON.parse(raw) as Partial<DisplayPresence>;
    return (
      value.eventId === eventId &&
      typeof value.clientId === 'string' &&
      value.clientId.length > 0 &&
      typeof value.expiresAt === 'number' &&
      value.expiresAt > now
    );
  } catch {
    return false;
  }
}

/** Reads the optional server field without depending on a contracts version that includes it. */
export function serverDisplayPresence(snapshot: unknown): boolean | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined;
  const organizer = (snapshot as OrganizerEventStatePresence).organizer;
  if (typeof organizer !== 'object' || organizer === null) return undefined;
  const value = organizer.displayConnected;
  return typeof value === 'boolean' ? value : undefined;
}

/** A display must have an authenticated, live public event snapshot before it advertises liveness. */
export function usePublishDisplayPresence(eventId?: string) {
  const clientId = useRef(
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  useEffect(() => {
    if (!eventId) return;
    const publish = () => publishDisplayPresence(eventId, clientId.current);
    publish();
    const timer = window.setInterval(publish, HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      removeDisplayPresence(eventId, clientId.current);
    };
  }, [eventId]);
}

/** Server presence is authoritative; same-browser liveness is used only before an org snapshot. */
export function useDisplayPresence(eventId: string, organizerSnapshot?: unknown) {
  const [localConnected, setLocalConnected] = useState(() =>
    isDisplayPresenceConnected(eventId),
  );
  const authoritative = useRef<{ eventId: string; value?: boolean }>({
    eventId,
  });
  if (authoritative.current.eventId !== eventId) {
    authoritative.current = { eventId };
  }
  const serverConnected = serverDisplayPresence(organizerSnapshot);
  if (serverConnected !== undefined) authoritative.current.value = serverConnected;

  useEffect(() => {
    const refresh = () => setLocalConnected(isDisplayPresenceConnected(eventId));
    refresh();
    const timer = window.setInterval(refresh, 750);
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === keyFor(eventId)) refresh();
    };
    window.addEventListener(CHANGED_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(CHANGED_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, [eventId]);

  if (authoritative.current.value !== undefined) return authoritative.current.value;
  return organizerSnapshot === undefined ? localConnected : false;
}
