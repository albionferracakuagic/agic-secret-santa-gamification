# Organizer guide

> Updated: 23/11/2026 — **v1.2.0**

## 1. Organizer console

The organizer console is split into five tabs; `?tab=` deep-links to each one.

- **Live**: event summary, Show Autopilot status/timeline, warnings, and the manual phase/pause controls under **Manual override**.
- **Setup**: autopilot timing, feature settings, pairing import, reactions, categories and custom achievements.
- **People**: access links/QR/codes, roster and approval, and participant removal.
- **Show**: context-sensitive controls for opening, voting, reveal, games, boards and the ceremony.
- **Admin**: aggregate stats, integrity, moderation, audit unmask, archive and audit log.

Only the active tab is mounted. Use the deep link (for example `?tab=setup`) when you need to resume a specific setup task.

## 2. Event lifecycle

Phases (organizer-driven): preparation → registration → gift registration → gift opening → voting → games → reveal → awards → completed.

- The event-level **Pause/Resume** control is available in any phase. It is separate from autopilot **Hold/Resume**.
- Back-steps are allowed (audited) until the reveal starts.
- Pairing re-import is disabled forever once gift opening has started.
- Max 100 participants per event.

## 3. Pairing file

You draw Secret Santa outside the app, then upload the result (CSV or XLSX).

- Columns: giver and recipient, by **name and/or email**. Headers are auto-mapped (EN/IT synonyms such as giver/santa/from/donatore, recipient/to/destinatario); fix the mapping manually if needed.
- `,` and `;` delimiters both work (Italian Excel). UTF-8, UTF-16 and CP1252 are detected. XLSX: pick the sheet.
- Matching: email (case-insensitive), else normalized name (no accents/case). Unknown names become new unclaimed roster entries.
- Errors (block "ready"): self-pair, duplicate rows, ambiguous name, giver with more than one recipient.
- Warnings: recipient with 0 or >1 givers, roster entry without a pairing.
- Status: draft (open issues) or ready. **Ready is required to leave preparation for gift registration.**
- The raw file is not stored. The result shows counts and row-numbered issues only; pairs stay hidden.

## 4. Join, claims and codes

- Share the event QR/link or the short code (rate-limited, expiring). Join page auto-detects EN/IT.
- Participants claim their roster name by one of:
  1. personal email link (roster has email);
  2. per-person claim code (export the name+code list; it contains no pairings);
  3. pick name → pending → you approve in person.
- Auto-approve grants base access only, never secrets. One active session per roster entry; re-claiming on a new device revokes the old one (audited).
- Display screen uses its own revocable token.

## 5. Voting privacy rules

- A category's results are published only with **≥5 distinct voters**. These floors are fixed and cannot be lowered.
- With **<10 voters** the live board is off by default (results appear at close/ceremony); you may switch it on.
- Boards show top-N only: no totals, no last place, no "who voted". The counter "N voted" updates on a ~10 s cadence.
- If a category fails the floor it is skipped with a neutral "Christmas magic" message; participation recognition is unaffected.
- Tiny events (<5 voters) get no vote-derived winners; you are warned at setup.
- Winners lock at voting close. Reopening voting invalidates locked awards (audited).

## 6. Show Autopilot

Show Autopilot is optional. **Start Show** appears on **Live** and is available from gift opening (also from a later show phase if you start manually), while the event is not paused. The UI readiness checks require:

- the latest pairing import to be **ready**;
- at least one registered gift;
- the organizer client's public realtime channel is live (this is not proof that a physical `/d` screen is open);
- feature settings in the organizer state;
- an allowed show phase (`gift opening` through `awards`).

The server runs the sequence opening → voting → optional games → reveal → awards → completed through durable jobs. It uses server time and the actual event state, not a browser timer.

### Pace presets and overrides

Choose the preset in **Setup**:

| Pace | Gift opening / gift | Voting | Games | Giver reveal / gift | Interlude |
|---|---:|---:|---:|---:|---:|
| Quick | 20 s | 3 min | 5 min | 12 s | 5 s |
| Standard | 40 s | 5 min | 10 min | 20 s | 10 s |
| Relaxed | 60 s | 10 min | 15 min | 30 s | 20 s |

Each timing can be overridden. Leave a field blank (or clear it with `null` through the API) to return to the selected preset. Allowed ranges are: opening 5–600 s, voting and games 1–120 min, reveal 5–300 s, interlude 0–120 s. **Include extras** controls whether enabled mini-games/auction features enter the games step; privacy floors and feature permissions cannot be overridden here.

Settings can be changed until the event is completed. Changes during a running show refresh the timeline estimate; the server always reads the latest effective timing when it decides the next action.

### Hold, freeze and manual control

- **Hold** pauses only the autopilot timeline. Participant voting, reactions and other interactions continue according to the current event phase. Resume restores the remaining time.
- An event **freeze** (`Pause`) is different: when the next durable tick observes it, autopilot moves to held/frozen; normal event actions also remain subject to the paused-event guards. Unfreeze first, then explicitly resume autopilot.
- **Skip current step** ends the current wait. It does not bypass irreversible phase logic (for example, voting is closed before the show leaves voting).
- **Stop autopilot** returns the show to manual operation; it does not change the current phase.
- A manual phase/action override wins. On the next tick autopilot resynchronizes to the actual phase and avoids repeating an effect already completed by the organizer.
- Commands carry a `fromSeq` guard, and durable ticks carry `seq`: stale or duplicate deliveries are no-ops.

### Auto-resolve

Autopilot does not leave the show waiting on an ordinary organizer decision:

- publishable tied awards configured for organizer tie-breaking become **shared wins**, before the ceremony starts;
- a voting round below the non-overridable privacy floor is still closed, but its categories remain hidden/neutral;
- steps with nothing enabled or nothing to show are skipped.

If a ceremony has been **cancelled**, autopilot polls in a waiting state and does **not** restart it. Stop autopilot or resolve the ceremony manually; restarting automatically is intentionally not supported.

## 7. Ceremony and reveal routes

Scripted steps run from the organizer console and mirror on the display: nominees → winners → achievements. Achievements unlock only at the ceremony step. Reveal start ends back-steps.

- `/d`: the public dramatic reveal stages one gift at a time. A drumroll shows the recipient and countdown, never the giver. Only the durable server unveil makes the giver visible, followed by a finale grid and a recap prompt.
- `/e`: the recipient gets a personal drumroll banner and, once the giver is revealed server-side, a personal full-screen reveal with positive reactions. Other participants see only a normal reveal toast. Dismissing the personal overlay is remembered for the current browser session.
- `/e/recap`: participants can open the recap from awards through completed; before then it remains locked. It reuses only published event data (winners, already-revealed givers, the participant's own data and public archive), never hidden votes or unrevealed identities.

### Light the Tree and the scene-effect choice (Reveal pilot)

Two small, optional additions to the reveal stage. Existing gift voting is unchanged.

- **Light the Tree**: for the gift currently being revealed, each verified participant may tap once, optionally. Publicly only a **cumulative** result is shown: no names and no per-gift turnout.
- **Effect choice**: at a break in the reveal stage, the host opens **Snowstorm vs Sleigh Bells** from **Live** or **Show**. Participants have **10 seconds** to tap one option or sit it out. The host can **cancel** the round. There are **no live tallies and no voter identities**.
- **Privacy floor**: the outcome is published only with at least **5 voters**, or the event's own floor if higher. A **tie** or **low participation** gives a neutral result.
- **Result**: the winning effect plays briefly, **once**, on the public display, following the normal motion/sound preferences. Autopilot waits for the result before moving on.

## 8. Audit unmask

You play masked: pairings, givers, full rankings, vote details and others' XP are hidden. For corrections or integrity checks use "Audit unmask": confirm + reason → 10-minute grant, visible banner, audit log entry. Pairing corrections after opening are possible only this way, until voting closes.

## 9. Event-day runbook

1. Day before: dry run with a few devices; check pairing import is **ready**, categories enabled, event not paused.
2. Display: open `/d` on a 1080p screen/TV with the display token; fullscreen; verify the join QR/short code is readable from the room.
3. Sound: browsers block audio until a click — tap "enable sound" once on the display (and on participant phones if desired). Sound is opt-in; reduced-motion is respected.
4. Choose: run **Start Show** from Live, or keep the manual run-of-show in Show. If autopilot is running, use **Hold** for a timeline-only stop; use event Pause only when participant actions must be blocked too. Watch the "N voted" counter before closing.
5. If a device drops, reconnect restores state automatically.
6. **No deploys or restarts during events.** Freeze releases from the day before.
7. After: phase → completed; photos follow the retention policy.

## 10. Phase 2–3 features

- **Feature flags panel**: turn features on/off per event (e.g. guessSanta, missions; both off by default).
- **Guess Santa**: participants guess their giver; results are published only through the privacy gate.
- **Missions**: optional challenges; their XP is non-qualifying (does not affect awards).
- **Games**: mini-games run in the games phase.
- **Coins and auction**: Santa Coins are earned in the event and spent in the auction; auction countdown depends on the realtime clock offset.
- **History / Hall of Fame**: past events and winners; participants can link their account.
- **Certificates**: PDFs for participants/winners. Custom achievements: awarded by rule; manual award form not available yet.
