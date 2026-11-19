# ADR-0009 — Durable Show Autopilot and server-driven reveal

> Aggiornata al: 19/11/2026 — **v1.1.0**

Status: Accepted (extends ADR-0002/0003; supersedes nothing)

## Context

The organizer can now run the show manually or from a server-driven autopilot. Browser timers are not authoritative: refreshes, reconnects, duplicate job deliveries and organizer overrides must not reopen voting, reveal a giver early, repeat a phase action or restart a cancelled ceremony.

The feature introduces a tabbed organizer console, `/d` dramatic reveal, recipient-specific `/e` reveal moments and `/e/recap`. All existing privacy/publication rules still apply: display and participants receive no organizer autopilot state, and no giver is exposed before the database records the reveal.

## Decision

- **Autopilot state is one row per event.** `autopilot_state` stores the validated `AutopilotState` JSON plus `claim_seq`, `claimed_at` and `updated_at`. The state has `idle | running | held | done`, a current step, server deadline, bounded timeline, bounded coarse log and monotonic `seq`. Organizer projections and the organizer-only GET route may expose it; display and participant output schemas reject it.
- **The job engine is durable.** Each state transition cancels older ticks and enqueues `autopilot.tick` in `scheduled_jobs` with the current `seq`. Delivery is at-least-once at the runner boundary, while `seq` checks plus an atomic per-row claim and 60-second crash TTL serialize work for a sequence. Stale, ahead, fresh-claimed and post-transition ticks do not execute effects. The executable services are rerun-safe; an event-service conflict releases the claim and retries after a short poll.
- **The actual event phase wins.** Tick decisions use fresh aggregate server state. If an organizer opens a gift, closes voting or changes phase manually, the next action is `resync`: no inverse/replay; autopilot adopts the real phase and continues from it. Commands accept optional `fromSeq`; a mismatch returns `stale_seq`.
- **Hold is timeline-only; freeze is event-wide.** `hold` clears the next autopilot deadline and saves remaining milliseconds, so participant interactions continue under the current phase. On resume the deadline and pending ETAs shift by the held duration. Event `paused` is separate: an observing tick holds with `frozen_held`, schedules nothing, and resume is rejected until the event is unpaused and the organizer resumes explicitly.
- **Pace is preset plus bounded override.** `quick`, `standard` and `relaxed` provide opening, voting, games, reveal and interlude timings. Optional per-step values override a preset; `null`/blank restores it. `includeExtras` decides whether enabled mini-games/auction enter the games block. Timing changes are allowed until completion and replan estimates without changing privacy floors or feature authorization.
- **Auto-resolve is bounded and positive.** Before a ceremony, publishable tied awards that normally need an organizer tie decision become shared wins and are audited. A category below the voter floor is still closed but remains neutral/hidden. Empty/disabled steps are skipped. Autopilot does not lower `canPublish()` or expose the reason to participants.
- **Cancelled ceremony is terminal for that run.** A ceremony status of `cancelled` becomes `ceremony_cancelled` polling: autopilot waits and does not call start or advance again. The organizer must stop/resolve the run manually.
- **Reveal uses durable server state.** The staged gift is `events.current_gift_id`; `reveal.unveil` carries the deadline and is allowed to write `giverRevealedAt` only when the gift is still staged, unrevealed, non-hidden, and the event remains in reveal. A drumroll projection has `giver: null`; exact recipient-specific/public reveal data is emitted only after the server-side unveil. Duplicate and early jobs are no-ops; reveal-all cancels pending drumroll jobs.
- **Presentation is projection-only.** `/d` renders the public dramatic stage and finale; `/e` adds a personal moment only when the revealed pair's recipient is the current participant. `/e/recap` is available from awards through completed and composes only participant/public/archive data already authorized. None of these routes receive pairings, ballots or autopilot decisions.
- **Timers are server-time based.** Clients show countdowns from absolute deadlines using the realtime clock-offset estimate. The authoritative deadline transition still happens in the job runner; a client refresh or clock display cannot reveal or advance a step.

## Consequences

- + A server restart, reconnect or duplicate delivery does not reset the run; the organizer sees a durable timeline and coarse audit log.
- + Manual and automated operation can coexist: organizer intent takes precedence, without duplicate side effects.
- + Hold remains useful for pauses in presentation while participants keep interacting; event freeze has visibly stronger semantics.
- + Reveal privacy is enforced by the database state and projection contract, not by client animation timing.
- − Side effects execute outside the state-row transaction, then the state sequence commits. Recovery therefore relies on service idempotency and the claim/seq guards rather than one cross-service transaction.
- − A claim can wait until its crash TTL expires before another worker proceeds after an unclean exit.
- − A cancelled ceremony leaves autopilot polling until explicit organizer action; this is intentional to avoid an unexpected ceremony restart.
- − The UI Start Show "display" readiness verifies a live public realtime projection from the organizer client, not whether a physical display browser is currently open.
- − Scale-out still needs shared realtime cursor/rate-limit infrastructure; the autopilot claim and durable jobs remain database-backed.
