# ADR-0004 — Identity, auth, claims, display tokens, unmask grants

Status: Accepted

## Context
- Public multi-tenant: anyone creates events. Participants must join via QR in seconds, no account. Organizer can also play but must not see secrets (givers, votes, full rankings) unless audited.
- Pairing list comes from an external draw; roster entries may be pre-created (import) and must not be hijackable by someone merely picking a name.

## Decision
**Organizer accounts** — Better Auth: email magic link, Microsoft, Google. `event_organizers(eventId, userId, role owner|co, participantId?)`. `user.isPlatformAdmin` for moderation. ToS: organizer 18+.

**Guest sessions (participants)** — no Better Auth account in MVP.
- Opaque random token, stored hashed (`sessionTokenHash`); cookie `httpOnly; Secure; SameSite=Lax`, per event; one active session per roster entry.
- Join entry: event link/QR (128-bit token, hashed in `event_access`) + short code (6–8 chars, rate-limited, expiring, revocable). Join page EN/IT auto-detect.
- **Verified claim paths** (atomic; one active claim per entry):
  a. personal email claim link (roster has email);
  b. per-person claim code (organizer exports name+code list — never pairings);
  c. pick roster name → `pending` → organizer in-person approval.
  Auto-approve toggle grants **base access only, never secrets** (own recipient, missions).
- Re-claim / new device / recovery → verified path again; old session revoked; audited.
- Organizer-player binds own roster entry once (audited); rebinding or privileged reassignment needs unmask + audit.
- Guest → account linking = Phase 3.

**Display tokens** — separate `event_access(kind=display)` token, revocable, read-only, public projection only; URL token exchanged for a display session cookie then stripped from the URL; not shared with participant cookies.

**Unmask ("audit unmask")**
- Requires organizer session + explicit confirm + reason. Creates `unmask_grant` valid 10 min (non-extendable; renewal = new confirm + new audit row), persistent banner, `audit_log` entry.
- Unlocks: pairing list, giver details, full rankings, vote details, others' XP, assignment corrections, identity reassignment. Delivered only via grant-scoped REST scope + socket channel (ADR-0002); participants always 403.
- Expiry/revoke/membership removal/session replacement ⇒ forced disconnect.
- A non-playing co-organizer should own these tasks.

**Controls**: rate-limit join/claim/code endpoints per IP+event; constant-time compare; hashed tokens/codes (claim codes high-entropy + lockout after N tries); CSRF via SameSite + `Origin` check on mutations; helmet CSP; logs redact votes/pairings/missions/tokens.

## Consequences
- + Frictionless join; knowing a name does not expose secrets.
- + Organizer parity with participants by default; unmask exceptional and traceable.
- − Guest sessions are device-bound; lost device ⇒ verified re-claim.
- − Two auth stacks → single `Principal` resolver used by REST and socket handshake.
- − Emailed claim links depend on ACS deliverability (SPF/DKIM).
