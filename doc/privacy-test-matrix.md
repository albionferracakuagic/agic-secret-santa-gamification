# Privacy test matrix

> Aggiornata al: 19/11/2026 — **v1.1.0**

Traceability from the privacy requirements (FR-046 rules 1-10, FR-013, acceptance criteria AC7 and AC13) to the automated tests that enforce them. Policy: ADR-0002 (projection/realtime), ADR-0003 (publication policy), ADR-0004 (identity). **Adding a route, surface or output field must add or update a row here** (the sweep tests below fail on unclassified routes and on key-allowlist changes).

Layers: **D** = domain/contract unit, **DB** = PGlite, **API** = Fastify inject, **WS** = Socket.IO integration.

## Cross-cutting enforcement

| Mechanism | What it guarantees | Tests |
|---|---|---|
| Strict per-role output schemas (`OutputSchemas`) | Unknown keys are rejected; roles cannot receive each other's shapes | `packages/domain/src/projection.test.ts` (role x phase x surface, incl. `leaderboards`, `announcement`); `privacy-surfaces.test.ts` (ceremony scenes role x phase x step, key allowlists) |
| Send-guard (dev/test throw, prod strip + alert) | A leaky projection is never emitted | `packages/contracts/src/index.test.ts`; `hub.test.ts` "send guard: leaky payloads are never emitted" |
| Forbidden-value scanner (`scanForbidden`) | Ids, scores, ordering metadata absent from every payload | used in `projection.test.ts`, `privacy-surfaces.test.ts`, `flow.test.ts`, `show.test.ts`, `privacy-api.test.ts` |
| Route sweep | Every registered route is classified; every event/me/admin route enforces its auth class; no route name exposes rank/score/tally/result | `privacy-api.test.ts` "API authorisation sweep" |
| Single publication policy `canPublish()` | Floors (>=5 voters, hiddenMin 2, safe-N), ties, neutral fallback | `ranking.test.ts` (properties), `deduction.test.ts` (brute-force cohorts 3..12), `boards.test.ts`, `ceremony.test.ts` |

## FR-046

| # | Rule | Enforced by | Tests |
|---|---|---|---|
| 1 | No public last-place awards | Winners only (rank 1) from locked awards; ceremony never shows ranks > 1; no last place in any payload | D `projection.test.ts` "non-top / last place never appears"; DB `ceremony.test.ts` (nominees only canPublish-safe, no rank/score); API `show.test.ts` ceremony scan |
| 2 | No public negative gift rankings | Public boards = top-N only, `score`/totals dropped, tail hidden (hiddenMin) | D `ranking.test.ts` properties (never exposes last place / ranks beyond N / totals); `privacy-surfaces.test.ts` public leaderboard entry keys = `entryId,label,rank,tied`; WS `privacy-api.test.ts` snapshots have no `score` |
| 3 | No public identification of low-scoring participants | Board labels are gift aliases, never people; XP board hides totals and is off by default | D `scene.test.ts` "board labels are gift aliases"; DB `boards.test.ts` (xp board only when feature on) |
| 4 | No embarrassing failure animations | Contract has no failure/negative cue; unsafe boards use neutral `christmas_magic` message | D `scene.test.ts` "live board that is unsafe shows the neutral message"; web FX catalog tests (Fiammetta) |
| 5 | No public individual voting history | Votes never in any projection; own selections only on the participant's own stream/endpoint | D `projection.test.ts` forbidden `voterId`/`votes`; API `flow.test.ts` "only own selections returned"; DB `admin.test.ts` integrity report aggregate-only |
| 6 | No disclosure of hidden Santa identity before reveal | Giver absent from gift projections until `giverRevealedAt`; reveal is irreversible (DB trigger); ceremony reveals at the winner step only | D `projection.test.ts` gift list; `privacy-surfaces.test.ts` giver only in `winner` step; DB `gifts.test.ts` (irreversible reveal), `ceremony.test.ts` "giver revealed only at the winner step"; API `flow.test.ts` reveal; `show.test.ts` only winners' givers on the public stream |
| 7 | No insulting/negative reactions | Closed positive reaction enum, per-participant bucket, organizer mute | `reactions.test.ts`; contracts reaction enum |
| 8 | No percentile / hidden-position indicators for non-top | Entries carry only `rank` within top-N and `tied`; no counts of hidden entries; stats are counts without ranks | D `privacy-surfaces.test.ts` allowlists (leaderboard, stats, integrity); `ranking.test.ts` |
| 9 | No participant access to unpublished full rankings through APIs | No ranking/score route exists; unmasked data only with an active grant; sockets serve `lastPublished` only | API `privacy-api.test.ts` "no route exposes a ranking...", "unmask-gated routes refuse..."; WS "reconnecting returns the last PUBLISHED board and counter", "only a cadence tick changes what reconnecting clients see", "participant cannot subscribe to organizer or grant streams"; `hub.test.ts` guest never gets organizer streams, grant-scoped channel |
| 10 | Positive recognition independent of voting performance | Spirit/Champion achievements from qualifying XP, not votes; XP self-only | D `ceremony.test.ts` Christmas Spirit ignores non-qualifying XP; DB `ceremony.test.ts` spirit + champion unlock; `xp.test.ts` |

Organizer access to complete results is restricted: unmasked projections require an active grant (`organizer.test.ts` "secret data only behind an active grant", `privacy-api.test.ts` expired/bogus/missing grant on pairings, integrity details, corrections, organizer-state), every grant and detail read is audited (`organizer.test.ts`, `admin.test.ts`).

## FR-013 Anonymous voting

| Aspect | Enforced by | Tests |
|---|---|---|
| Nobody can see who voted for what | No per-voter data in any projection; masked integrity report counts only | `projection.test.ts`, `admin.test.ts`, `privacy-api.test.ts` |
| Deduction from published aggregates | >=5 distinct voters, hiddenMin 2, safe-N; brute-force check for cohorts 3..12 shows 0 deducible voters at the floors | `deduction.test.ts` (recalibrate upward only if it ever fails; ADR-0003) |
| Voters-count / "N voted" cannot be polled for timing correlation | Counter and boards publish on cadence only; a reconnect gets the last published value | WS `privacy-api.test.ts` cadence tests; `flow.test.ts` "N voted appears only on cadence"; residual timing-correlation risk accepted (ADR-0003) |
| Removed voter | Votes deleted while voting is open; after close the locked awards are not rewritten and the case is flagged | `admin.test.ts` |
| Delete-my-data | Ballots stay anonymous, identity erased | `admin.test.ts` "delete-my-data anonymises..." |

## Phase 2: guesses, missions, games, presentations (FR-025..032, FR-041)

Policy: ADR-0007. Every guess-, game- or mission-derived public output goes through `publishPeopleBoard()` = `canPublish()`; private data is readable only by its owner.

| # | Rule | Enforced by | Tests |
|---|---|---|---|
| P2-1 | Guesses visible only to their owner (REST, sockets, organizer, display) | Participant-only routes; no guess in any organizer/display projection; `guess_result` is a personal announcement accepted only by the participant schema, sent on `p:<id>` | D `privacy-phase2.test.ts` "personal announcement...", key allowlists; API `phase2.test.ts` "other guesser never sees...", "result on THEIR stream only" (bob/display get nothing) |
| P2-2 | Guess results are playful, never punitive | Result payload = `{outcome, cue: confetti\|wink, xp}`; no negative cue exists in the contract; incorrect = 0 XP, nothing deducted | D `privacy-phase2.test.ts` (cue `sad` rejected); DB `phase2.test.ts` |
| P2-3 | Santa Detective / Invisible Santa / Mission Master / game winners obey canPublish | `publishPeopleBoard()`: >= 5 contributors (`detectiveMinGuessers` raise-only), top-N, hidden tail >= 2, shared ties, no totals, neutral `christmas_magic` on failure, reason code organizer-only | D `privacy-phase2.test.ts` property tests (cohorts 1..12), `phase2.test.ts`; DB `phase2.test.ts` (4 guessers -> fallback, 5-player floor for games and missions); API "presentations: canPublish gate" |
| P2-4 | Clues are anonymous | Author id stored for authorship checks only, never projected; queue = alias + text + status; announcement = alias + text; filter blocks self-reveal and the giver's name | D `phase2.test.ts` (filter), `privacy-phase2.test.ts` allowlists; DB/API `phase2.test.ts` (scan for giver id in queue and announcement) |
| P2-5 | Missions are private; the display learns only "a secret mission was completed" | Own-data-only routes; organizer sees counts + submissions awaiting verification; `mission_completed` carries only `at`; delivered by a jittered durable job, no public delta at completion time; audit redaction of `mission*`/`note` | D `privacy-phase2.test.ts` (extra keys rejected for every role); API `phase2.test.ts` "display learns only..." (empty delta window at completion, then exactly one generic announcement) |
| P2-6 | Mini-game payloads leak no answers, scores or other players' state | Correct ids only after round close; scene identical for every viewer; per-person score/answer/card only on `GET /api/me/game`; winners top-N via canPublish; no `score`/`result` route names | D `privacy-phase2.test.ts` (scene scan, leaky payload rejected / stripped + alert in prod); DB `phase2.test.ts`; API sweep `privacy-api.test.ts` (new routes classified, 401/403 matrix) |
| P2-7 | Phase 2 XP cannot leak guess/game/mission results | Non-qualifying XP only (`planPhase2Award`): Christmas Champion and Christmas Spirit ignore it; own XP is self-only | DB `phase2.test.ts` (ledger `qualifying = false`) |
| P2-8 | Certificates only for the owner's unlocked achievements | Ownership check, identical 404 for unknown / not yours; achievements themselves come from canPublish-gated paths | API `phase2.test.ts` "certificates..." |
| P2-9 | Delete-my-data / removal erase Phase 2 personal rows | `purgePhase2Personal()` | DB `phase2.test.ts` |

Sweep tests (`privacy-api.test.ts`) run against the new routes without special cases; the world uses a raised global rate limit because the sweep replays every route per principal.
## Phase 3: coins, auction, history, Hall of Fame, editor (FR-033/034/042..044)

Policy: ADR-0008 (extends ADR-0007). Coins/bids/lifetime data are self-only; every ranking-like output (seasonal top-N) goes through `publishPeopleBoard()` = `canPublish()`.

| # | Rule | Enforced by | Tests |
|---|---|---|---|
| P3-1 | Coins are earned only (XP-derived rules with server `rewardKey`, organizer grants); never bought, transferred or converted; no coin board | `coin_ledger` unique `(event, participant, rewardKey)`, earn hook in `awardXp`, `COIN_REASONS` has no purchase/transfer/convert; route names checked | DB `phase3.test.ts` (earn rules, replay, grant idempotency, reasons); API `phase3.test.ts` "coins are self-only..." (route-name scan) |
| P3-2 | Balance/ledger visible only to the owner; organizer sees rules + one aggregate | `GET /api/me/coins` participant-only; `OrganizerCoinsResponse` has no per-person field | D `privacy-phase3.test.ts` (allowlists); API (organizer/display 401) |
| P3-3 | Auction shows prices, never bidders; "you are leading" only to yourself | `AuctionView` = price + deadline + winner after close; `MyAuction.you` own position; public scene/announcements strict; bid history is not exposed anywhere | D `privacy-phase3.test.ts` (bidderId/bids rejected for every role, guard strips + alerts in prod); API `phase3.test.ts` "auction end to end" (scan of the display stream for bidder ids) |
| P3-4 | Mystery content stays hidden until the reveal step | `reveal` null in every payload until status `revealed`; only the `mystery_reveal` announcement carries it | DB + API auction tests |
| P3-5 | Bids cannot overspend or double-pay; timers are durable | Participant row lock + balance check + hold in one tx; outbid holds released; `closeVersion` guards stale timers; anti-snipe bounded by `maxExtensions` | DB `phase3.test.ts` (holds, release, snipe, stale/early/replay close, cancel/disable refund) |
| P3-6 | Archive keeps PUBLIC results only | Snapshot builder reads only locked+publishable+ceremony-revealed awards (rank 1), unlocked achievements, finished games' published results; names resolved at read time (anonymised people drop out); photo URL only while the photo exists; deleted at `retention.archiveDays` | DB `phase3.test.ts` "history archive" (votes/nominees/unrevealed awards/XP/bids absent; anonymisation; retention); D `privacy-phase3.test.ts` (extra keys rejected) |
| P3-7 | Hall of Fame / lifetime profile are positive only | Only winners, champions, achievements; no low ranks, no totals; seasonal board via canPublish (>= 5 linked accounts, top-N, hidden tail, no XP numbers) and only from events that ran the XP board | DB `phase3.test.ts` (HoF, seasons incl. floor, no-xpBoard) |
| P3-8 | Account link needs a verified claim and a mailbox proof | Verified claim only (auto-approved guests refused); single-use hashed 30-min token; one generic 401 for wrong/used/expired; delete-my-data removes that event's titles | DB + API `phase3.test.ts` |
| P3-9 | Feature PATCH cannot lower floors | `FeaturesPatchSchema` has no floor keys, `detectiveMinGuessers` min 5, merged settings re-validated; locked at `completed`; nothing new in `awards`; audited | D `privacy-phase3.test.ts`; DB + API `phase3.test.ts` |
| P3-10 | Custom categories keep ballot integrity | Editable only before voting opens; `c_` key space; custom winner achievements go through the same canPublish-locked awards | DB + API `phase3.test.ts` |

Scale-out (no privacy surface change): deltas relayed between instances are already role-guarded; `grant:*` channels never cross instances (`scale/scale.test.ts`).

## Giver reveal server and participant experience

Policy: ADR-0003 (publication), ADR-0009 (durable reveal/autopilot engine).

| # | Rule | Enforced by | Tests |
|---|---|---|---|
| R-1 | A staged gift exposes recipient/countdown only; the giver is `null` until the server writes `giverRevealedAt` | `RevealViewSchema` discriminated drumroll shape; `projectReveal()` includes giver only when gift status is `revealed`; hidden/unopened gifts are excluded | `packages/domain/src/privacy-reveal.test.ts` (exact key allowlists, drumroll/revealed property over 300 runs, `scanForbidden`, send guard); `packages/db/src/reveal.test.ts` |
| R-2 | Drumroll deadlines and unveil are durable and cannot reveal early | `events.current_gift_id` + `scheduled_jobs` kind `reveal.unveil`; deadline re-check, staged-gift check, stale/duplicate no-op, reveal-all cancels pending unveil jobs | `packages/db/src/reveal.test.ts`; `apps/server/src/routes/reveal.test.ts` (no early giver, reconnect snapshot, duplicate delivery, cancelled stale job) |
| R-3 | Reveal data is the same public projection on `/d` and participant sockets; participants cannot drive reveal routes | Display/participant receive the scene through role output schemas and the send guard; organizer-only `/reveal/next` and `/reveal/all` | `apps/server/src/routes/reveal.test.ts` ("participants cannot drive the reveal"); `apps/server/src/routes/autopilot.test.ts` privacy case |
| R-4 | `/e` gives only the recipient the full-screen personal moment; other reveals are ordinary public toasts | `RevealPersonal` keys on `current.recipient.participantId`; it does not fetch pairings or organizer data; dismissal is per-gift session storage only | `apps/web/src/reveal.test.tsx` (own drumroll, reveal overlay, others' toast, reduced motion, dismissed gift) |
| R-5 | `/e/recap` never widens reveal access | `isRecapPhase()` unlocks at awards/completed; Santa/giver comes only from an already-revealed scene/gift/archive; no recap-specific server secret source | `apps/web/src/recap.test.tsx` (locked pre-awards, drumroll omission, revealed-only giver, completed archive, omitted counters) |

## Show Autopilot privacy

Policy: ADR-0009. Autopilot decides from aggregate counts and coarse ceremony state; it is never present on display or participant contracts.

| # | Rule | Enforced by | Tests |
|---|---|---|---|
| AP-1 | Autopilot state, settings and timeline are organizer-only | `autopilot` is accepted only in the organizer event-state shape; strict output schemas reject it on display/participant surfaces | `packages/contracts/src/autopilot.test.ts`; `apps/server/src/routes/autopilot.test.ts` "privacy: autopilot only in the organizer eventState..." |
| AP-2 | Logs cannot carry names, pairings, votes, missions or organizer free text | Log `code` enum plus slug/integer/boolean parameters; schema rejects arbitrary strings and secret-shaped values | `packages/contracts/src/autopilot.test.ts` (leaky log names and giver IDs rejected); `packages/domain/src/autopilot.test.ts` |
| AP-3 | Decisions use aggregate counts only | Server snapshot contains gift/reveal counts, voter floor boolean, game/ceremony state; no ballots, pairings, participant rows or gift identities | `packages/db/src/autopilot.ts`; `packages/db/src/autopilot.test.ts`; `apps/server/src/routes/autopilot.test.ts` |
| AP-4 | Hold/freeze do not turn into an input lock that can be mistaken for privacy isolation | Hold stores remaining timeline time only; participant interaction remains governed by event phase. Freeze causes `frozen_held` and rejects resume until the event is unpaused | `packages/domain/src/autopilot.test.ts`; `packages/db/src/autopilot.test.ts`; `apps/server/src/routes/autopilot.test.ts` freeze/resume case |
| AP-5 | Manual/rescheduled execution cannot reveal or duplicate work through retries | `seq` rejects stale/ahead ticks; `claim_seq`/claim TTL serializes a seq; services are idempotent; auto-resolve changes only publishable tie decisions; cancelled ceremony is polled, never restarted | `packages/domain/src/autopilot.test.ts`; `packages/db/src/autopilot.test.ts`; `apps/server/src/routes/autopilot.test.ts` manual override, stale seq and freeze cases |

## Acceptance criteria

| AC | Statement | Tests |
|---|---|---|
| AC7 | No participant can see last place, negative rankings or private vote information | all FR-046 rows 1, 2, 5, 9 above; participant socket snapshot scan in `privacy-api.test.ts` |
| AC13 | Hidden data remains protected in the backend, not merely concealed in the UI | route sweep (anonymous/guest/display/non-member/IDOR), unmask-gated routes, malformed-id handling, removed/suspended principals on REST and sockets, send-guard, grant expiry/revocation (`hub.test.ts`, `organizer.test.ts`), takedown (`show.test.ts`, `privacy-api.test.ts`) |

## API negative-test catalogue (`privacy-api.test.ts`)

- Anonymous / guest / display session on any `/api/events/:eventId/*` route: 401. Non-member organizer: 403.
- Anonymous / display / organizer session on any `/api/me*` or `/api/profiles/*` route: 401.
- `/api/admin/*`: anonymous 401, guest 401, ordinary organizer 403.
- Unmask-gated (`pairings`, `integrity/details`, `pairings/correct`, `organizer-state` with a grant header): missing, expired, unknown and malformed grant: 403.
- Cross-event IDOR: a participant of another event cannot read this event's profiles (404) or vote for its gifts.
- Another participant's profile exposes only `participantId, displayName, avatar, achievements`.
- Malformed ids: 400 `bad_request`, never 500.
- Removed participant: every `/api/me*` GET 401 and socket refused. Suspended (taken-down) event: participant and display sessions 401 and sockets refused; restore reverses it.

## Socket audit catalogue

| Scenario | Test |
|---|---|
| Unauthenticated connection refused | `hub.test.ts` |
| Role-scoped snapshots, per-stream contiguous cursors, event isolation | `hub.test.ts` |
| Grant-scoped channel: only the holder; expiry mid-session, explicit revoke, DB revocation, membership removal, session replacement each cut the next send | `hub.test.ts`, `organizer.test.ts` (`grant.expire` job) |
| Reconnect cannot bypass cadence | `privacy-api.test.ts` |
| Participant cannot subscribe to `org`/`grant:*` streams | `privacy-api.test.ts` |
| Removed participant / suspended event refused | `privacy-api.test.ts`, `show.test.ts` |
| Public stream during ceremony: only winners' givers, announcements allowed, no vote/score keys | `show.test.ts` |

## Known residual risks (accepted, see ADR-0003)

Timing correlation between a single vote and a cadence tick (cohorts under 10 can be small enough to infer); organizer collusion via unmask is mitigated by audit, not prevented.
