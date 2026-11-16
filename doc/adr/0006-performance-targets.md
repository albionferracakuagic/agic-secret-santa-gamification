# ADR-0006 — Performance / NFR targets (TR-003)

Status: **Accepted** (owner-approved 2026-11-16, incl. 99.5 % availability on single replica and no deploys during events). Numbers still validated/revised by `perf-load` task.

## Context
- TR-003: animations and realtime stay responsive under simultaneous participation. Peaks: voting close, board publish, ceremony reveal (mobile + 1080p display).
- MVP cap 100 participants/event; single replica (ADR-0005).

## Decision (proposed)
Load profile: **100 clients/event × 5 concurrent events ≈ 500 sockets** on 1 replica (0.5–1 vCPU, 1–2 GiB), Burstable PG. Stretch: 10 events.

| Area | Target |
|---|---|
| REST read (state/snapshot) | p95 ≤ 300 ms, p99 ≤ 800 ms |
| REST mutation (vote, gift) | p95 ≤ 400 ms, errors < 0.5 % |
| Photo upload (≤5 MB → processed) | p95 ≤ 4 s |
| Socket connect + snapshot | p95 ≤ 1.5 s on 4G |
| Board/phase push → delivered to 100 clients | p95 ≤ 1 s, max ≤ 3 s |
| Display vs participant skew | ≤ 1 s |
| Reconnect recovery | p95 ≤ 3 s |
| Server CPU / mem under load | < 70 % / < 75 % sustained |
| Crash/restart job resume | ≤ 15 s |
| Web initial load (4G, mid phone) | LCP ≤ 2.5 s; initial JS ≤ 250 KB gz (FX lazy) |
| Interaction | INP ≤ 200 ms; FX 60 fps target, 30 fps floor |
| Availability in event window | 99.5 % (no deploys during events) |

**FX auto-degrade**: client rolling ~1 s frame-time; sustained < 40 fps or low `deviceMemory`/`hardwareConcurrency` → drop intensity one level (high→normal→low→off). Never blocks input (`pointer-events:none`). `prefers-reduced-motion` ⇒ off/low. User may pin level. Client-local, not reported with identity. Display may cap particles. Every cue keeps text/ARIA-live equivalent.

**Server protections**: payload caps; reactions ≤5/s/socket; pushes coalesced (≤1 per stream per 250 ms); DB pool ~10/replica; `(eventId, …)` indexes on hot paths; jittered reconnect backoff.

**Test**: k6/Artillery socket scenario (ramp → vote burst → publish → 30 % reconnect storm), Playwright multi-device smoke, Lighthouse CI budget.

## Consequences
- + Concrete pass/fail for `perf-load`.
- − Numbers are estimates; revise after first load run. Breach ⇒ scale-up before scale-out.
- − Deploy-time reconnect storm is the worst case.
