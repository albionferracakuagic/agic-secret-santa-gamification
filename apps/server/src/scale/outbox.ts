import { dispatchOutbox, type Db } from '@santa/db';
import type { FanoutBus } from './bus.js';

/**
 * Relays the transactional outbox to the bus. Several instances can run it: rows are claimed with SKIP LOCKED
 * inside one transaction, so each message is relayed by exactly one of them (at-least-once overall).
 */
export class OutboxDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly bus: FanoutBus,
    private readonly o: { batch?: number; clock?: () => Date } = {},
  ) {}

  async tick() {
    return dispatchOutbox(this.db, {
      limit: this.o.batch ?? 50,
      now: (this.o.clock ?? (() => new Date()))(),
      publish: (m) => this.bus.publish(m.topic, { id: m.id, eventId: m.eventId, payload: m.payload }),
    });
  }

  start(intervalMs = 500) {
    this.timer = setInterval(() => {
      this.inFlight = this.inFlight.then(() => this.tick()).catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}