# M3 — Floor Operations: QR Check-in, Classes & Bookings, Staff & Trainers

**Goal:** members check in by showing a rotating QR on their PWA card that staff scan; staff can also check members
in manually. Gyms schedule classes that members book without overbooking, with waitlists and no-show tracking.
Staff and trainer profiles, availability, client assignments, and PT packages work end to end.

Follow the session protocol in `docs/milestones/README.md`.

## Read
- `docs/DECISIONS.md` **D-09** (check-in design — follow exactly), D-07, D-08
- `MASTER_SPEC.md` Module 4, Module 5, Module 6, §7C (card, check-in history, class booking), §12, §14 security tests on QR replay

## Data model (confirm before migrating)
`MemberPass` (tenantId, memberId, passId opaque random, secretEncrypted, status ACTIVE|REVOKED, issuedAt, rotatedAt), `AttendanceEvent` (tenantId, branchId, memberId, type CHECK_IN|CHECK_OUT, method QR|MANUAL|CORRECTION, passId, timeStep, scannedByUserId, deviceId, reason, result ACCEPTED|REJECTED + rejectCode, occurredAt; unique `(passId, timeStep)` for accepted QR events), `ScanDevice` (optional named device per branch), `ClassCategory`, `ClassTemplate` (recurrence rule, duration, capacity, room, trainer, eligible plans, booking window, cancellation cutoff), `ClassSession` (materialized occurrence, status SCHEDULED|CANCELLED|COMPLETED, capacity, bookedCount), `Room`, `Booking` (status BOOKED|CANCELLED|ATTENDED|NO_SHOW, source), `WaitlistEntry` (position), `StaffProfile` (extend M1), `TrainerProfile` (specialties, bio, certifications), `StaffAvailability`, `TrainerClientAssignment`, `PTPackage` (plan-like sellable, session count, validity), `PTPackageBalance`, `PTAppointment`, `EntitlementLedger` (credits granted/consumed per membership or package).

## Build (in this order)

### 1. Member pass & digital card (D-09)
- Issue a pass when a member gets PWA access (and on reissue/revoke by staff). Secret: 32 random bytes, encrypted at rest; delivered to the member's device over the authenticated session only.
- PWA **Card** screen: member name, photo, gym/branch, membership status + end date, rotating QR (30 s step, visible countdown), brightness hint. Cached for **offline** use: secret in IndexedDB, card shell cached by the service worker; if the membership data is stale (> 24 h offline) show "last synced" time.
- On sign-out or pass revoke, the device copy is wiped on next sync; server rejects revoked passes regardless.

### 2. Staff scanner & validation
- Staff **Scan** page (permission `attendance.scan`): camera scanner (works on phone and tablet; request permission gracefully), also accepts keyboard-wedge scanners. Branch selector defaults to staff's current branch.
- `attendance.validateScan(ctx, payload, branchId)`: parse → find pass → verify HMAC (constant-time) → timeStep within ±1 → pass ACTIVE → member status → active membership with branch access and access hours → duplicate-scan window (default 2 min, configurable) → **one-time use of `(passId, timeStep)`** via Redis `SET NX` + DB unique constraint. Write an `AttendanceEvent` for both accepted and rejected scans (rejected with code).
- Result screen: big green/red state, member photo + name for visual identity check, reason for rejection in plain words (expired membership, wrong branch, already checked in, invalid/expired code), dues warning badge if outstanding > 0 (configurable: warn or block).
- **Manual check-in**: search member → check in, requires reason; same eligibility checks with an override permission (`attendance.override`) for exceptions, audited.
- Optional check-out (branch setting). Corrections (edit/delete an event) with permission + reason, audited.
- Member PWA: check-in history list; simple streak counter (definition documented; full rules in M7).
- Staff: today's attendance list per branch, live count.

### 3. Classes & scheduling
- Categories, rooms, class templates with recurrence (RRULE subset: weekly days, until/count). Worker job materializes sessions 8 weeks ahead and on template change (without touching sessions that already have bookings — flag conflicts instead).
- Conflict detection: trainer double-booked, room double-booked, outside trainer availability.
- Calendar views (week/day, branch filter) for staff; session detail with roster.
- Cancel a session → bookings cancelled, credits returned, members notified.

### 4. Booking (concurrency-safe)
- Member books from PWA (eligible plans only, within booking window, credit available if plan uses credits); staff can book on behalf.
- **No overbooking:** atomic conditional update (`UPDATE ClassSession SET bookedCount = bookedCount + 1 WHERE id = $1 AND bookedCount < capacity`) or `SELECT … FOR UPDATE` inside the transaction that creates the booking and consumes the credit. Pick one and test it with parallel requests.
- Waitlist when full; auto-promote on cancellation (in transaction), notify promoted member; promotion stops at the cancellation cutoff.
- Cancellation before cutoff returns credit; after cutoff counts as late cancel (policy).
- Attendance marking by trainer/staff; QR check-in on the day can auto-mark booked classes at that branch (setting). End-of-session job marks remaining BOOKED as NO_SHOW.
- Reminders (in-app + email) N hours before session.

### 5. Staff & trainers
- Staff profile (contact, roles, branches, employment info; compensation fields visible only with `staff.compensation.view`).
- Trainer profile: specialties, certifications (file upload), bio; availability (weekly + exceptions).
- Client assignment (trainer ↔ member) with history.
- **PT packages:** sell like a plan (invoice via M2 invoicing; SAC/tax from package config); balance ledger; book PT appointment (trainer availability, conflict check); mark completed (consumes a session) / no-show per policy.
- Trainer view: my schedule, my clients, my sessions today. Trainers see only assigned members' relevant data, not their payments.
- Staff activity log (from audit log, filtered by actor).

## Tests required
- Unit: TOTP/HMAC generation & verification (shared code between PWA and server — same test vectors), time-step window, RRULE materialization, waitlist promotion order, credit ledger.
- Integration: **replay** — the same QR value accepted once, second scan rejected; a code from 2 steps ago rejected; revoked pass rejected; tenant B staff cannot validate tenant A pass; **20 parallel bookings for the last 1 seat → exactly 1 succeeds**; waitlist promotion under concurrent cancellation; trainer cannot read payments.
- E2E: member opens card (mock camera by feeding the QR value to the scan page) → staff scans → accepted → history shows it; same code again → "already used"; book class → full → waitlist → cancellation promotes.

## Out of scope
Hardware turnstiles (keep `AccessDevice` interface only), workout plans (M7), online payment for PT packages (M4 adds it automatically via invoices).

## Acceptance checklist
- [ ] Check-in works with the member offline and the staff device online; replayed/expired/foreign codes are rejected with clear messages.
- [ ] Manual check-in and corrections are permission-gated and audited.
- [ ] No overbooking under concurrency (test proves it); waitlist promotion correct.
- [ ] Staff, trainer, availability, PT package sale → appointment → completion work end to end.
- [ ] PWA card installable and usable on a 390 px screen; scanner works on a phone camera.
- [ ] All checks pass; status doc updated (note: hardware access control not implemented).
