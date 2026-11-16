# ADR-0003 — Privacy publication policy (`canPublish()`)

Status: Accepted (floors are owner decisions; numeric defaults calibrated by brute-force tests)

## Context
- FR-013: individual votes private. FR-046: no last place, no negative rankings, no low-scorer ID, no unpublished rankings, recognition independent of votes.
- Published aggregates of small cohorts can reveal ballots (e.g. 3 voters, top-1 shows 1 vote ⇒ a voter who knows their own ballot can infer others').

## Decision
**One pure function `canPublish(category, ballots, config, ctx) → {ok, projection} | {ok:false, reason}`** in `packages/domain`. ALL vote-derived output goes through it: live boards, ceremony nominees/winners, winner achievements/badges, certificates, history/Hall of Fame. No other code path may read `votes` for display.

Non-overridable floors (organizer may only be stricter):
- **≥5 distinct voters** in the category.
- **Safe-N**: `shown = max(0, min(configN, eligible − hiddenMin))`, `hiddenMin = 2`.
- Only entries with ≥1 vote are eligible.
- **Min total votes** threshold (default 5, calibrated).
- **Ties**: tie group straddling the cutoff → cut above the whole group if including it would break `hiddenMin`; otherwise include whole group (never arbitrary split). Winner ties → configured tie-break (co-winners default); tie info never exposes counts.
- Output: ids in rank order of shown only; **no totals, no rank for non-top, no percentages**. Vote totals per board = organizer toggle with warning, still under the same floors.
- **Fail ⇒ neutral fallback**: category skipped, "Christmas magic" message; no promise of a later reveal; reason code visible to organizer only.
- Participation recognition (Christmas Spirit etc.) is independent of votes and unaffected.

Cadence:
- Eligibility ≠ scheduling. Publish every T s (default 10) iff projection changed AND `canPublish()` ok. Vote edits count as changes. Staleness ≤ T. "N voted" counter on same cadence; never per-person "has voted".
- Manual publish and voting-close use the same guard.
- **<10 voters → live board off by default** (shown at close/ceremony); organizer may enable.
- Winners locked at voting close; achievements unlock only at the ceremony step. Reopen voting = explicit tx (invalidate locked awards, bump `votingRound`, cancel jobs, audit).
- Christmas Champion uses qualifying XP = participation only (excludes achievement XP) so XP cannot leak vote results. XP self-only.

## Risks (documented, accepted)
- **FR-013 deduction risk**: a participant who knows their own ballot plus published projections may infer others' ballots in small cohorts. Mitigation: floors + cadence + coarse top-N projection. Validation: **brute-force test** enumerating all ballot assignments consistent with the published projection sequence, for cohorts 5..12; assert no other voter's ballot is uniquely determined given the attacker's own ballot. **Owner decision (2026-11-16)**: if the deduction test fails for 5–12 voters, recalibrate the ≥5-voter floor and `hiddenMin = 2` (raise only, never lower); record new values here. A failing test blocks release (report to owner; never weaken tests).
- **Residual timing correlation**: someone who sees a board change at cadence T right after a known person votes (or watches the final vote) can correlate change ↔ voter. Mitigated, not eliminated: quantization to T, batched changes, no per-person indicators, <10-voter default-off. **Owner-accepted for MVP (2026-11-16)**; organizer warned at setup; live boards can be disabled.
- Tiny events (<5 voters) get no vote-derived winners (owner decision); organizer warned at setup.

## Calibration results (2026-11-16, `packages/domain/src/deduction.test.ts`)
- Model: n voters (voter 0 = attacker knowing own ballot), m candidate entries, every assignment enumerated; single final projection (`final` purpose, shared ties, topN 3, no totals).
- n=3..4: nothing published (voter floor). m=4, n=5..12 (up to 16.0 M assignments) and m=5, n=5..9: **0 uniquely-deducible ballots** in all published projections (non-vacuous: 4–65 distinct projections per cell).
- Result: **floors hold as set (≥5 voters, hiddenMin 2); no recalibration needed.** Re-run on any policy change; raise-only if it ever fails.
- Not modelled: live (multi-publication) sequences → covered by the accepted timing-correlation risk; own-gift voting restriction; totals toggle (`showTotals`) — enabling it should get its own deduction run before being offered in UI.

## Consequences
- + Single audit point; exhaustive tests (fast-check + brute force); forbidden-value contract scan on every projection.
- − Small family events lose voting suspense; fallback copy must be warm.
- − Any policy change requires re-running the deduction suite.
