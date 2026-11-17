# Organizer guide

> Updated: 17/11/2026 — **Phase 1–3**

## 1. Event lifecycle

Phases (organizer-driven): preparation → registration → gift registration → gift opening → voting → games → reveal → awards → completed.

- Pause/resume is available in any phase.
- Back-steps are allowed (audited) until the reveal starts.
- Pairing re-import is disabled forever once gift opening has started.
- Max 100 participants per event.

## 2. Pairing file

You draw Secret Santa outside the app, then upload the result (CSV or XLSX).

- Columns: giver and recipient, by **name and/or email**. Headers are auto-mapped (EN/IT synonyms such as giver/santa/from/donatore, recipient/to/destinatario); fix the mapping manually if needed.
- `,` and `;` delimiters both work (Italian Excel). UTF-8, UTF-16 and CP1252 are detected. XLSX: pick the sheet.
- Matching: email (case-insensitive), else normalized name (no accents/case). Unknown names become new unclaimed roster entries.
- Errors (block "ready"): self-pair, duplicate rows, ambiguous name, giver with more than one recipient.
- Warnings: recipient with 0 or >1 givers, roster entry without a pairing.
- Status: draft (open issues) or ready. **Ready is required to leave preparation for gift registration.**
- The raw file is not stored. The result shows counts and row-numbered issues only; pairs stay hidden.

## 3. Join, claims and codes

- Share the event QR/link or the short code (rate-limited, expiring). Join page auto-detects EN/IT.
- Participants claim their roster name by one of:
  1. personal email link (roster has email);
  2. per-person claim code (export the name+code list; it contains no pairings);
  3. pick name → pending → you approve in person.
- Auto-approve grants base access only, never secrets. One active session per roster entry; re-claiming on a new device revokes the old one (audited).
- Display screen uses its own revocable token.

## 4. Voting privacy rules

- A category's results are published only with **≥5 distinct voters**. These floors are fixed and cannot be lowered.
- With **<10 voters** the live board is off by default (results appear at close/ceremony); you may switch it on.
- Boards show top-N only: no totals, no last place, no "who voted". The counter "N voted" updates on a ~10 s cadence.
- If a category fails the floor it is skipped with a neutral "Christmas magic" message; participation recognition is unaffected.
- Tiny events (<5 voters) get no vote-derived winners; you are warned at setup.
- Winners lock at voting close. Reopening voting invalidates locked awards (audited).

## 5. Ceremony

Scripted steps run from the organizer console and mirror on the display: nominees → winners → achievements. Achievements unlock only at the ceremony step. Reveal start ends back-steps.

## 6. Audit unmask

You play masked: pairings, givers, full rankings, vote details and others' XP are hidden. For corrections or integrity checks use "Audit unmask": confirm + reason → 10-minute grant, visible banner, audit log entry. Pairing corrections after opening are possible only this way, until voting closes.

## 7. Event-day runbook

1. Day before: dry run with a few devices; check pairing import is **ready**, categories enabled, event not paused.
2. Display: open `/d` on a 1080p screen/TV with the display token; fullscreen; verify the join QR/short code is readable from the room.
3. Sound: browsers block audio until a click — tap "enable sound" once on the display (and on participant phones if desired). Sound is opt-in; reduced-motion is respected.
4. Run phases in order; announce each phase change. Watch the "N voted" counter before closing.
5. If a device drops, reconnect restores state automatically.
6. **No deploys or restarts during events.** Freeze releases from the day before.
7. After: phase → completed; photos follow the retention policy.

## 8. Phase 2–3 features

- **Feature flags panel**: turn features on/off per event (e.g. guessSanta, missions; both off by default).
- **Guess Santa**: participants guess their giver; results are published only through the privacy gate.
- **Missions**: optional challenges; their XP is non-qualifying (does not affect awards).
- **Games**: mini-games run in the games phase.
- **Coins and auction**: Santa Coins are earned in the event and spent in the auction; auction countdown depends on the realtime clock offset.
- **History / Hall of Fame**: past events and winners; participants can link their account.
- **Certificates**: PDFs for participants/winners. Custom achievements: awarded by rule; manual award form not available yet.
