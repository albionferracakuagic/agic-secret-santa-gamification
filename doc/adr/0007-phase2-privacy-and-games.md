# ADR-0007 — Phase 2: guesses, missions, mini-games, presentations, certificates

Status: Accepted (Phase 2 backend; extends ADR-0002/0003, supersedes nothing)

## Context
- FR-025..032 and FR-041 add guess-derived, mission-derived and game-derived outputs next to the vote-derived ones. FR-046 and the single `canPublish()` must hold for all of them.

## Decision
- **One publication function.** Santa Detective, Invisible Santa, Mission Master and game winners call `publishPeopleBoard()` (domain `guess.ts`), a thin wrapper over `canPublish()`: >= 5 distinct contributors (`phase2.detectiveMinGuessers`, raise-only), top-N, `hiddenMin >= 2`, shared ties, no totals, no rank outside the published set, neutral `christmas_magic` on failure (reason code only in the organizer response).
- **Private by construction.** Guesses, missions, clues' authors, answers, bingo cards and per-person scores exist only on `/api/me/*` and the owner's own stream. `guess_result` is a *personal* announcement: only the participant output schema accepts it. Organizer views are masked (no authors, no guesses, unsubmitted missions never listed).
- **Settlement at the reveal.** Guesses are marked correct/incorrect idempotently (`settleGuesses`) after any giver reveal (route, reveal-all, ceremony winner step) and lazily on reads. Wrong guesses cost nothing; the payload has no failure cue.
- **XP is non-qualifying** for guesses, missions and games (`planPhase2Award`), like achievement XP, so Christmas Champion/Spirit cannot leak Phase 2 outcomes. Winner XP/achievements exist only for published rank 1.
- **Mission announcement decorrelation.** Completion is silent on public streams; a durable `mission.announce` job (10..40 s jitter) emits `{type:'mission_completed'}` with no person, mission or counter.
- **Games = durable state machine.** `intro -> round_open -> round_closed -> ... -> results -> finished`; every deadline is a `game.step` job carrying `stepVersion` (stale/early/duplicate deliveries are no-ops); one active game per event (partial unique index); server clock decides windows; Speed Challenge hides its random GO time until it happens (`game.go` job broadcasts it). Mystery Santa Predictions write `santa_guesses` (`source = prediction`) and are scored only at the giver reveal (so they feed Detective/Invisible Santa; the game itself publishes no winners).
- **Presentations** (`event_spotlights`) store only the policy result (ids + ranks), resolved to names at read time, so anonymisation applies.
- **Certificates**: satori + resvg in-process, fonts = the web app's licensed WOFF2 files unpacked in memory (wawoff2), procedural SVG art, text folded to the font subset, ownership-checked, `no-store`, rate-limited. satori and resvg are MPL-2.0 (file-level copyleft, server-side only, unmodified).

## Consequences
- + Same audit point for all "best at X" output; Phase 2 adds no new way to read votes.
- + All timers survive restarts; handlers idempotent.
- − Small events (< 5 guessers/players/completers) get the neutral fallback for these boards, as for vote boards.
- − Guess-derived boards have no brute-force deduction run (they publish who is best, never which suspect a person chose); revisit if per-gift guess statistics are ever published.
- − The keyword filter is best-effort; the organizer queue is the real control.
