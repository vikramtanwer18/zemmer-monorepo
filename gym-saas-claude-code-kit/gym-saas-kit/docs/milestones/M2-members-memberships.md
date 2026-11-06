# M2 — Members, Memberships, Invoices & Manual Payments

**Goal:** a gym can register members, sell them membership plans, issue GST-correct (or non-GST) invoices,
record manual payments (full or partial), track outstanding balances and member credit, and run the membership
lifecycle (activate, freeze, renew, cancel, expire). Members get a PWA sign-in and a home screen showing their
membership and dues. A thin dashboard shows real numbers.

Follow the session protocol in `docs/milestones/README.md`.

## Read
- `docs/DECISIONS.md` D-03 (member auth), D-04, D-08, D-10 (manual part), D-11
- `docs/KPI_DEFINITIONS.md`
- `MASTER_SPEC.md` Module 1 (dashboard — thin version only), Module 2, Module 3, Module 9 (invoices, manual payments, allocations, tax), Module 19 (in-app + email only), Module 20 (tax, invoice numbering, membership policies, notification preferences), §9

## Data model (confirm before migrating)
`MemberProfile` (tenantId, homeBranchId, userId nullable, memberCode, name, email nullable, phone E.164 + `phoneVerifiedAt` null, DOB, gender optional, address, emergency contact, status, source, joinedAt), `MemberNote`, `MemberDocument` → `FileRecord`, `ContactConsent` (channel, purpose service|marketing, status, method, capturedBy, capturedAt, evidence), `MembershipPlan` (+ `PlanBranch`, price, joining fee, duration unit/count, tax config, SAC, freeze rules, grace days, cancellation policy, entitlements JSON validated by Zod schema, active/archived, version), `Coupon`, `Membership` (status `PENDING_PAYMENT|ACTIVE|PAUSED|EXPIRED|CANCELLED`, startDate, endDate, branch access), `MembershipEvent`, `MembershipFreeze`, `GymInvoice` + `GymInvoiceLine` (taxable value, CGST/SGST/IGST amounts & rates, SAC), `InvoiceSeries` (per GSTIN/tenant per FY, next number — row-locked), `CreditNote` + lines, `GymPayment` (method, reference, status, receivedBy, receivedAt, proof file), `PaymentAllocation`, `MemberCreditEntry` (ledger), `Notification`, `NotificationPreference`, `EmailTemplate`.

Member status (proposed): `PROSPECT → ACTIVE ↔ INACTIVE`, `ARCHIVED`; derived "membership state" comes from memberships, not stored twice.

## Build (in this order)

### 1. Member management
- Create member (staff form with duplicate detection on phone/email within tenant), profile page with tabs (Overview, Memberships, Invoices & Payments, Attendance [empty until M3], Notes, Documents, Consents).
- Search, filters (status, branch, plan, expiring within N days, has dues), sort, server pagination.
- Notes (staff-only visibility levels), documents (S3 presigned upload, content-type/size allow-list, AV scan hook stub, downloads via short-lived signed URLs after a permission check).
- Consent capture at onboarding: service messages (default yes, required for operations) vs marketing (explicit opt-in, unchecked by default) per channel email/WhatsApp; full history kept.
- CSV **import** (background job, validation report with row errors, dry-run first) and **export** (permission `members.export`, background job, file expires in 24 h, audited).
- Bulk actions with confirm dialog: assign branch, add tag, archive.

### 2. Member accounts & PWA shell
- Staff can send an **app invite** to a member with an email: sets password via email link; links `MemberProfile.userId`. Self-signup via gym join link (`/join/{tenantSlug}`) creates a pending member for approval (toggle per tenant).
- Member PWA (mobile-first): sign-in, optional email OTP, gym picker if member of several gyms (D-04), Home (current membership, days left, renewal date, outstanding dues), Invoices & receipts (view/download PDF), Profile (edit phone/emergency contact, change password), Consent settings (marketing opt-in/out).

### 3. Membership plans
- Plan CRUD with versioning (editing a plan with sold memberships creates a new version; existing memberships keep their terms).
- Branch eligibility, access rules (all branches / home branch / listed branches; optional time windows), entitlements schema (class credits, PT sessions — consumed in M3), joining fee, trial plan flag, coupons (percent/flat, validity, usage limits), freeze rules (max days, max times, fee), grace days, cancellation/refund policy text + rules.

### 4. Membership lifecycle (`packages/core/memberships`)
- Sell membership (staff): choose plan → dates (start today or future) → coupon → preview invoice → issue invoice → optionally record payment now. Membership `PENDING_PAYMENT` → `ACTIVE` per tenant policy ("activate on full payment" | "activate on any payment" | "activate immediately").
- Prevent duplicate overlapping active memberships unless plan allows add-ons.
- Renew (starts at current end date + 1 day or today if expired), extend (staff, with reason), freeze/unfreeze (rules enforced; end date extended by frozen days per KPI open question default), cancel (policy-driven, creates credit note when refunding — refund execution for online payments is M4; for manual payments record a manual refund).
- Daily **expiry job** per tenant timezone: ACTIVE → EXPIRED after end date (+grace for access, configurable), emits events.
- Every transition writes `MembershipEvent` + audit.

### 5. Invoicing & tax (D-11)
- Tax engine: given tenant/branch GST status, line price, inclusive/exclusive, rate, place-of-supply rule → taxable value + CGST/SGST or IGST, half-up rounding per line, invoice totals. Pure function, exhaustively unit-tested (inclusive/exclusive, intra/inter, unregistered, coupons before tax, joining fee line).
- Invoice numbering: `InvoiceSeries` row locked `FOR UPDATE` inside the issuing transaction; format configurable within 16 chars (e.g. `IT/25-26/000123`); FY rollover; gap-free (voided invoices keep their number).
- Invoice PDF (server-rendered; correct title "Tax Invoice" vs "Bill/Receipt"; supplier GSTIN, recipient details, SAC, tax breakup, amount in words), stored in S3, emailed on request.
- Credit notes for corrections/cancellations; issued invoices immutable.

### 6. Manual payments, allocations, credit
- Record payment: method (cash, UPI-external, bank transfer, card terminal, cheque, other), amount, date, reference, proof upload. Allocate across open invoices (default oldest first; staff can adjust). Supports **partial** payments.
- Overpayment → `MemberCreditEntry` (credit). Apply credit to an invoice (staff action, and automatically on new invoices if tenant setting on).
- Void a payment (permission + reason; reverses allocations; audited). Receipts for each payment.
- Member financial summary: total invoiced, paid, outstanding, credit.

### 7. Notifications foundation
- `notify(ctx, recipient, templateKey, data, { category: SERVICE|MARKETING })` → in-app (bell + list, unread count) and email via worker queue; respects preferences and consent (marketing requires consent; service always allowed unless legally required otherwise).
- Templates: member invite, membership activated, invoice issued, payment received, membership expiring (7/3/1 days, configurable), membership expired.

### 8. Thin dashboard
- Cards (with branch + date filters): Active members, New members, Expiring next 7 days, Outstanding dues, Collected this period (manual payments), Invoiced this period. Every figure computed by `packages/core/metrics` per `KPI_DEFINITIONS.md` and clicking a card opens the filtered list.

## Tests required
- Unit: tax engine matrix, numbering format/rollover, allocation algorithm (partial, multi-invoice, overpay → credit), membership state machine (all valid + invalid transitions), freeze rules, coupon rules, KPI functions on fixtures.
- Integration: concurrent invoice issuance never duplicates a number (parallel transactions); payment + allocation + membership activation atomic (failure mid-way rolls back); member A cannot see member B's invoices from the PWA; receptionist without `billing.void` cannot void.
- E2E: create plan → create member → sell membership → record partial cash payment → member sees outstanding in PWA → record remaining UPI payment → membership active → invoice PDF downloads.

## Out of scope
Online payments/webhooks/refunds via gateway (M4), attendance (M3), classes (M3), WhatsApp (M6), full dashboard (M8).

## Acceptance checklist
- [ ] Member → membership → invoice → partial + full manual payment → active membership, all database-backed and audited.
- [ ] GST-registered and unregistered tenants produce correct documents; numbers are gap-free under concurrency.
- [ ] Overpayment creates credit, and credit applies to the next invoice.
- [ ] Expiry job transitions memberships correctly across timezones (test with IST and one other zone).
- [ ] Member PWA sign-in works; a member sees only their own data in each gym they belong to.
- [ ] Dashboard numbers match KPI definitions on seed data (test asserts the values).
- [ ] All checks pass; `DATABASE_DESIGN.md`, `PERMISSIONS.md`, status doc updated. Open GST questions for the client listed in the status doc.
