import { randomUUID } from 'node:crypto';

/**
 * Fan-out between server instances (scale-out prep, ADR-0008). Production adapters (Azure Web PubSub or Redis
 * pub/sub) implement this interface; the default is in-process, which is exactly the single-replica behaviour.
 * Messages are role-projected payloads that already passed the send-guard: a bus never sees raw rows.
 */
export interface FanoutBus {
  readonly instanceId: string;
  publish<T>(topic: string, message: T): Promise<void>;
  /** Returns an unsubscribe function. Handlers must be idempotent (at-least-once adapters). */
  subscribe<T>(topic: string, handler: (message: T) => void): () => void;
  close(): Promise<void>;
}

/** Delta relayed to the other instances; they emit it to their local sockets. */
export interface HubDeltaMessage {
  origin: string;
  eventId: string;
  stream: string;
  surface: string;
  cursor: number;
  payload: unknown;
}
export const HUB_DELTA_TOPIC = 'hub.delta';

/** Same-process bus: delivers to every local subscriber (a hub filters its own messages on `origin`). */
export class InMemoryFanoutBus implements FanoutBus {
  readonly instanceId: string;
  private readonly handlers = new Map<string, Set<(m: never) => void>>();
  private closed = false;

  constructor(instanceId: string = randomUUID()) {
    this.instanceId = instanceId;
  }

  async publish<T>(topic: string, message: T): Promise<void> {
    if (this.closed) return;
    this.deliver(topic, message);
  }

  /** Local delivery (also used by the linked-bus test double to model a shared broker). */
  deliver<T>(topic: string, message: T): void {
    // one clone per subscriber: nobody can mutate what the others receive
    for (const h of this.handlers.get(topic) ?? [])
      queueMicrotask(() => (h as (m: T) => void)(structuredClone(message)));
  }

  subscribe<T>(topic: string, handler: (message: T) => void): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler as (m: never) => void);
    this.handlers.set(topic, set);
    return () => set.delete(handler as (m: never) => void);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }
}

/** N buses sharing one broker (tests, and a model of how an external adapter behaves). */
export function createLinkedBuses(n = 2): InMemoryFanoutBus[] {
  const buses = Array.from({ length: n }, () => new InMemoryFanoutBus());
  for (const b of buses) {
    b.publish = async (topic, message) => {
      for (const other of buses) other.deliver(topic, message);
    };
  }
  return buses;
}