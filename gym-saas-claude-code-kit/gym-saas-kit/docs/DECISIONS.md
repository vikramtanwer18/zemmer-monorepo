# Binding Decisions Register

These decisions were agreed with the product owner on 2026-10-29. They **override** anything in
`docs/MASTER_SPEC.md` that conflicts with them. Do not change a decision silently: if implementation
evidence shows one is wrong, stop, explain the problem, and propose an amendment (add a new row marked
`Proposed`, never edit an `Accepted` row in place).

Engagement context: this is a **client build delivered by Fonix Technologies**. Target market: gyms in
**India** first (INR, GST, Razorpay, WhatsApp), but nothing should hard-code India where a setting would do.

---

## D-01 Repository and app layout — Accepted

A new pnpm + Turborepo monorepo. It is unrelated to the earlier GymOS codebase; do not import or copy from it.

```
apps/
  admin/      Platform (SaaS operator) app. Own auth realm. Next.js App Router.
  web/        Gym staff dashboard + member PWA (route groups (staff) and (member)). Next.js App Router.
  worker/     BullMQ worker process (Node, long-running). No HTTP UI.
packages/
  db/         Prisma schema, migrations, generated client, tenant-scoping extension, RLS SQL, seed.
  core/       Server-only business services by domain (members, memberships, billing, attendance, ...).
  auth/       Auth setup for both realms, session helpers, permission checks.
  ui/         Internal design system (Tailwind, Lucide).
  config/     Shared tsconfig, eslint, tailwind preset, env schema (Zod).
  integrations/ Provider adapters: payments (Razorpay), email (SES/SMTP), whatsapp (Cloud API), ai (OpenAI-compatible), storage (S3).
  testing/    Test factories, tenant fixtures, Testcontainers helpers.
```

Rules:
- Business logic lives in `packages/core`. Server Actions, Route Handlers, and worker jobs are thin
  adapters that validate input, resolve context, and call a core service.
- `packages/core` never imports from `apps/*`. UI never imports Prisma.
- The member PWA has its own manifest and service worker scoped to the member route group.

## D-02 Frameworks and libraries — Accepted

- Latest stable Next.js (App Router), React, TypeScript (strict), Tailwind CSS, Lucide, Zod, React Hook Form, Recharts.
- Server state on the client: React Server Components first; **TanStack Query** where client-side fetching/caching is needed. Do **not** use Redux for server state (overrides spec §4).
- Prisma ORM on PostgreSQL. BullMQ on Redis.
- Before using any library, check the installed major version and follow its current docs. Known traps to verify:
  Next.js 16 renamed `middleware.ts` to `proxy.ts`; Prisma 7 uses `prisma.config.ts` and driver adapters.
- Vitest, React Testing Library, Playwright, Testcontainers (PostgreSQL + Redis).

## D-03 Authentication — Accepted

Library: **Better Auth** (verify current API before implementing; swap only with a written reason).

| Realm / user | Sign-in methods | Second factor |
|---|---|---|
| Platform admin (apps/admin) | Email + password | **Mandatory** email OTP |
| Gym owner / gym administrator | Email + password **or** Google | **Mandatory** email OTP (Google sign-in still requires it) |
| Other gym staff | Email + password or Google | Optional email OTP; owner can require it per tenant |
| Member (PWA) | Email + password | Optional email OTP, off by default |

- 2FA is **email-based OTP** (no SMS, no authenticator app in v1). OTPs: 6 digits, ≤10 min TTL, single use, hashed at rest, rate-limited, attempts capped.
- Members' **mobile number is collected and stored** (E.164, validated) but **not verified** and **no SMS OTP** is sent in v1. Store `phoneVerifiedAt` as null so verification can be added later.
- Member accounts are created by staff (invite email → set password) or by self-signup through a gym's join link (creates a pending member the gym can approve). Email is required for app access. A member record without an email can exist (walk-in) but cannot sign in.
- Two **separate realms**: platform and tenant use different cookie names, different auth secrets, different session tables, and different subdomains (`admin.` vs `app.`). A tenant session is never valid in apps/admin and vice versa.
- Login, OTP, password-reset, and invite endpoints are rate-limited (Redis) per IP and per account.

## D-04 Global identity — Accepted

- One global `User` per email in the tenant realm. A person can be a member of gym A, a member of gym B, and staff at gym C.
- All business data hangs off tenant-scoped profiles (`MemberProfile`, `StaffProfile`) linked to `User` via `TenantMembership`.
- After sign-in, the user picks an active tenant (and branch where relevant); the choice is stored in the session and re-verified on every request.
- Platform admins are a separate `PlatformUser` table in the platform realm.

## D-05 Tenant isolation — Accepted (two layers + routing guard)

1. **Service layer (primary):** every request resolves an `AuthContext { userId, tenantId, branchIds, roles, permissions }` from the verified session. Core services take this context explicitly. A central Prisma client extension injects `tenantId` filters on reads and sets `tenantId` on writes for all tenant-owned models; a model missing from the registry fails tests.
2. **Database (defense-in-depth):** PostgreSQL Row-Level Security on every tenant-owned table using `current_setting('app.tenant_id')`, set with `set_config(..., true)` inside the same transaction as the query. The app connects as a role **without** `BYPASSRLS`; migrations run as a separate owner role.
3. **Next.js proxy/middleware is only a routing convenience** (redirects to login, tenant picker). It is never the security boundary.

- Platform tables live in Postgres schema `platform`; tenant tables in schema `app` (Prisma multi-schema). The admin app's DB role cannot read tenant business tables; it reads tenant-level aggregates through explicit views/functions.
- Platform support access to a tenant ("support session") requires a reason, is time-boxed, read-only by default, and is written to both platform and tenant audit logs.

## D-06 Hosting — Accepted

AWS: **EC2** (Docker containers for admin, web, worker behind a load balancer / reverse proxy with TLS), **RDS PostgreSQL**, **ElastiCache Redis**, **S3** (private buckets, presigned URLs), **SES** for email. Secrets via AWS Secrets Manager or SSM Parameter Store. Local dev uses Docker Compose: Postgres, Redis, MinIO, Mailpit.

## D-07 Roles — Accepted

Fixed roles with a code-defined permission matrix in v1: Super Admin, Platform Support (platform realm);
Gym Owner, Gym Administrator, Branch Manager, Receptionist, Sales Staff, Trainer, Accountant, Member (tenant realm).
Custom roles are a later milestone. The permission check API must already be permission-based (not role-name checks) so custom roles drop in later.

## D-08 Member app — Accepted

Installable PWA first (apps/web member route group), mobile-first. All member features call the same core services through authenticated endpoints so a React Native client can be added later without new business logic.

## D-09 QR check-in — Accepted (revised 2026-10-29)

**The member shows a QR; authorized staff scan it.**

- The member opens the **digital membership card** in the PWA, which shows a **rotating QR** (new code every 30 s).
- QR payload = `passId.timeStep.hmac` (TOTP-style): `passId` is an opaque random ID (no PII), `hmac` = truncated HMAC-SHA256 of `passId|timeStep` using a per-pass secret. The PWA receives the secret at sign-in and caches it so the card works **offline** (basements with no signal). Secrets rotate when the pass is reissued.
- Staff use a **Scan page** in the staff dashboard (phone or reception tablet camera; also accepts a USB/Bluetooth scanner as keyboard input).
- Server validation: signature, time window (±1 step), pass status, member status, active membership, branch eligibility, access hours, and a duplicate-scan window. Each `(passId, timeStep)` is accepted once (Redis + DB unique key), which stops screenshot replay.
- Staff can **check in manually** (search member → check in) with a required reason; the staff user and device are recorded.
- Check-out is optional per branch setting.
- Turnstile/biometric hardware is out of scope for v1; keep a `AccessDevice` interface for it.

## D-10 Member payments — Accepted

- Gateway: **Razorpay only in v1**, behind a `PaymentProvider` adapter interface (Stripe etc. later).
- **Each gym connects its own Razorpay account** (key id, key secret, webhook secret), stored encrypted (envelope encryption with an app KEK from Secrets Manager), never sent to the browser, never logged. Settings show only "connected / last 4".
- Webhooks: `/api/webhooks/razorpay/{integrationId}`; the `integrationId` selects the tenant's webhook secret; signature verified before any processing; events deduplicated by provider event id; processing is idempotent and order-tolerant.
- Members can, from the PWA: **buy a membership, pay an outstanding balance, renew**. Staff can send an online **payment link** for any open invoice.
- **Manual payments:** staff record cash, UPI (collected outside the gateway), bank transfer, card-on-terminal, cheque, other — with reference number and optional proof upload.
- **Partial and full payments:** every payment is allocated to one or more invoices via `PaymentAllocation`; invoice status `ISSUED → PARTIALLY_PAID → PAID` (plus `VOID`, `REFUNDED`, `PARTIALLY_REFUNDED`). Outstanding = total − allocated − credit notes.
- **Overpayment** becomes **member credit** (a ledger, not a balance column) and is applied to the next invoice automatically or by staff.
- A browser redirect never marks anything paid; only a verified webhook or a successful reconciliation fetch does.
- Fonix's own Razorpay account is used **only** for SaaS subscription billing (gym → platform) and is fully separate.

## D-11 GST and invoicing — Accepted

- Tenant setting: GST-registered **or** unregistered (per branch override allowed if branches have different GSTINs).
- **Registered:** GSTIN validated, legal name, state; plans/products carry a SAC/HSN code (gym services are commonly SAC 999723 — **the client's CA must confirm**) and a GST rate (default 18%). Tax split CGST+SGST (intra-state) or IGST (inter-state) by a configurable place-of-supply rule; default intra-state for services performed at the branch.
- Prices can be configured tax-inclusive or tax-exclusive per tenant.
- **Unregistered:** no tax lines; document titled "Receipt" / "Bill" (not "Tax Invoice").
- Invoice numbers: sequential, gap-free per series, series per GSTIN (or per tenant if unregistered) per Indian financial year (Apr–Mar), ≤16 characters, generated inside the issuing transaction.
- All money as integer paise + ISO currency code. Tax computed per line with documented rounding (half-up to paise). Issued invoices are immutable; corrections use credit notes.

## D-12 WhatsApp — Accepted

- **Tenant-owned WABAs** on the official WhatsApp Cloud API. Messages are billed to the gym's own WABA.
- Target onboarding is Meta **Embedded Signup**, which requires the operator (client/Fonix) to be an approved **Meta Tech Provider** (business verification, Meta app, app review). That is an external dependency and may not be ready when M6 starts.
- Until then, build **Manual Connect**: the gym enters its WABA ID, phone number ID, and a system-user access token from its own Meta Business; the app validates them with a live API call. Embedded Signup plugs into the same `WhatsAppAccount` model later.
- One platform webhook endpoint receives Meta events; route to the tenant by WABA ID / phone number ID; verify `X-Hub-Signature-256`.
- Consent, opt-out, template-only outside the 24-hour window, and rate/quality limits per spec Module 11.

## D-13 AI Copilot — Accepted

- Use the **OpenAI-compatible SDK** (`openai` npm package with configurable `baseURL`). The **platform admin configures** provider name, base URL, model, and API key (encrypted) in apps/admin. Optional per-plan enable/disable via entitlements.
- The model only gets server-defined, read-only tools with Zod-validated arguments, executed under the caller's `AuthContext`. No raw SQL, no secrets, no cross-tenant data. Figures come from deterministic services, never from the model.
- Tool-calling support differs between OpenAI-compatible providers; the adapter must detect failure and degrade to "answer from pre-computed summary" rather than invent numbers.

## D-14 Delivery order — Accepted

Milestones M0–M9 in `docs/milestones/`. **M4 is the sellable MVP.** Each milestone is run as its own Claude Code session using its prompt file. A milestone is not started until the previous one's acceptance checklist passes or remaining items are explicitly deferred in `docs/IMPLEMENTATION_STATUS.md`.

## D-15 Out of scope for v1 (tracked, not built)

SMS OTP and phone verification; authenticator-app TOTP; custom roles; UPI AutoPay / recurring mandates for members;
gateways other than Razorpay; turnstile/biometric hardware; native mobile apps; visual workflow builder; predictive churn ML;
franchise and white-label features.
