import { eq, lt, sql } from 'drizzle-orm';
import { idempotencyKeys, type Db } from '@santa/db';
import type { IdempotencyEntry, IdempotencyStore } from './idempotency.js';

type Row = typeof idempotencyKeys.$inferSelect;

const toEntry = (r: Row): IdempotencyEntry => ({
  fingerprint: r.fingerprint,
  state: r.state,
  ...(r.status === null ? {} : { status: r.status }),
  ...(r.body === null ? {} : { body: r.body }),
  ...(r.contentType === null ? {} : { contentType: r.contentType }),
  expiresAt: r.expiresAt.getTime(),
});

/** Postgres-backed idempotency keys: survive restarts and work across replicas (atomic claim via the PK). */
export class DbIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Db) {}

  async get(key: string) {
    const [r] = await this.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    if (!r) return undefined;
    if (r.expiresAt.getTime() < Date.now()) {
      await this.db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
      return undefined;
    }
    return toEntry(r);
  }

  /** Inserts the key, or takes over an expired one, in one statement: exactly one caller wins. */
  async claim(key: string, e: IdempotencyEntry) {
    const rows = await this.db
      .insert(idempotencyKeys)
      .values({
        key,
        fingerprint: e.fingerprint,
        state: e.state,
        expiresAt: new Date(e.expiresAt),
      })
      .onConflictDoUpdate({
        target: idempotencyKeys.key,
        set: {
          fingerprint: e.fingerprint,
          state: e.state,
          status: null,
          body: null,
          contentType: null,
          expiresAt: new Date(e.expiresAt),
        },
        setWhere: lt(idempotencyKeys.expiresAt, sql`now()`),
      })
      .returning({ key: idempotencyKeys.key });
    return rows.length > 0;
  }

  async set(key: string, e: IdempotencyEntry) {
    await this.db
      .update(idempotencyKeys)
      .set({
        fingerprint: e.fingerprint,
        state: e.state,
        status: e.status ?? null,
        body: e.body ?? null,
        contentType: e.contentType ?? null,
        expiresAt: new Date(e.expiresAt),
      })
      .where(eq(idempotencyKeys.key, key));
  }

  async delete(key: string) {
    await this.db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
  }
}

export const purgeExpiredIdempotencyKeys = (db: Db) =>
  db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, sql`now()`));
