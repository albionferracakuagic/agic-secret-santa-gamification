# ADR-0002 — Realtime: role projection, cursors, recovery, unmask channel

Status: Accepted

## Context
- FR-046/AC13: no leak of givers, votes, full rankings via any channel. TR-004: reconnect restores state.
- A global event version would (a) create false gaps for clients that don't see all events, (b) leak cadence of private activity (e.g. votes) via version jumps.

## Decision
1. **Server-authoritative.** Mutations = REST + `Idempotency-Key`. Socket.IO = server→client push + ephemeral positive reactions only. No client→server state-changing socket events.
2. **Role projectors.** Every payload (REST and socket) is built by one of: `participant`, `display`, `organizer-masked`, `organizer-unmasked`; validated against a strict zod output schema (`.strict()`) before send. Dev/test: throw. Prod: strip unknown + alert (App Insights). No handler serializes DB rows directly.
3. **Rooms**: `e:{id}:pub` (display + public data), `e:{id}:org` (masked only), `e:{id}:p:{pid}`. Handshake authenticates (guest cookie / Better Auth session / display token) and joins only rooms for that principal. Server decides joins; clients cannot request rooms.
4. **Per-projection cursors**: monotonic counter per stream (public, each participant, each organizer). Delta = `{stream, cursor, payload}`.
5. **Recovery**: subscribe → server returns snapshot with `cursor` → client drops buffered deltas ≤ cursor → applies later ones in order. Gap (cursor ≠ last+1) → re-request snapshot. Cursors are not comparable across streams.
6. **Board snapshots come only from `board_publications.lastPublished`**. Reconnect/snapshot cannot bypass cadence or `canPublish()` (ADR-0003).
7. **Unmask channel**: `grant:{grantId}` per-socket room, created on active unmask grant (ADR-0004). Authz re-checked **before every send** (grant active, not revoked/expired, membership, session still current). Expiry/revocation/membership removal/session replacement ⇒ forced room leave + disconnect of that socket; the expiry timer is a durable job, but the send-time check is the actual gate.
8. **Time**: deadlines are server timestamps; client estimates clock offset (ping/echo, median of N) → synced countdowns. Server remains authoritative on expiry.
9. Reactions: fixed positive enum validated server-side; fan-out aggregated, no per-gift counts (popularity proxy); rate-limited per socket.
10. `Cache-Control: no-store` on event/state APIs; SW caches static assets only.

## Implementation notes (gifts/voting, 2026-11-16)
- New public surfaces on the `pub` stream: `scene` (what the display shows: lobby+join URL/short code, opening current gift, voting deadline + published counter) and `announcement` (achievement celebration). Both are public data and identical for every role.
- `votingEndsAt` is a server timestamp; the server (not the client) closes at that instant: casting checks the deadline itself and a durable `voting.autoclose` job locks awards.
- Voted counter is a published value (`board_publications` key `voted_counter`) updated by the `board.publish` cadence job only when it changes; vote tallies are never pushed while voting is open.
- Gift photos: sharp pipeline (orientation, <=1600 px, JPEG, no metadata), renamed blob keys, short-lived signed URLs re-minted on every snapshot (local HMAC URL or Azure user-delegation SAS).
- Giver reveal is irreversible in the database (trigger + check constraint), not only in code.

## Consequences
- + No cadence side-channel from versioning; reconnect is safe by construction.
- + Privacy tests = (principal × phase) matrix of allowlisted keys + forbidden-value scan on both REST and socket payloads.
- − More streams/cursors to manage; client store keyed by stream.
- − Snapshots on reconnect may be slightly stale (≤ cadence T) — accepted.
- − Per-send authz check adds a lookup on the unmask channel only (low volume).
- Scale-out: cursors must move to DB/Redis; see ADR-0005.
