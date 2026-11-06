# CLAUDE.md — Gym Growth & Management SaaS

Multi-tenant SaaS for gyms (India-first). Client build by Fonix Technologies.
Read this file at the start of every session. It is short on purpose; details live in `docs/`.

## Source of truth (read in this order)
1. `docs/DECISIONS.md` — binding decisions. They override everything else.
2. The current milestone prompt in `docs/milestones/` — what to build now.
3. `docs/MASTER_SPEC.md` — full product spec. Read only the sections the milestone prompt lists.
4. `docs/IMPLEMENTATION_STATUS.md` — what exists, what is partial, known issues. Update it before you finish.
5. `docs/KPI_DEFINITIONS.md` — metric definitions. Never compute a KPI differently from this file.

## Layout
`apps/admin` (platform realm) · `apps/web` (staff dashboard + member PWA) · `apps/worker` (BullMQ)
`packages/db` · `packages/core` · `packages/auth` · `packages/ui` · `packages/integrations` · `packages/testing`
· `packages/env` (Zod env schemas) · `packages/eslint-config` · `packages/typescript-config` (see proposed D-16)

## Commands
- Install: `pnpm install` (Node 24, pnpm 11). First time: `cp .env.example .env`
- Local services: `pnpm services:up` (Postgres, Redis, MinIO, Mailpit) · `pnpm services:down`
- Dev: `pnpm dev` (web :3000, admin :3001, worker health :4100)
- Lint / types / tests: `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm test:int` · `pnpm test:e2e` · `pnpm format:check`
- Integration tests on private containers: `TESTCONTAINERS=1 pnpm test:int`
- Design-system showcase (dev): http://localhost:3000/ui
- Build: `pnpm build`
- DB: `pnpm db:migrate` (dev) · `pnpm db:deploy` (prod) · `pnpm db:seed` (demo data; set `SEED_DEMO_PASSWORD`)
- First platform admin: `pnpm platform:create-admin` (reads `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` or prompts)
- Permission docs: `pnpm docs:permissions` (regenerates `docs/PERMISSIONS.md`; a test fails if it drifts)
- Emails in dev: Mailpit at http://localhost:8025

## Non-negotiable rules
**Tenancy & auth**
- Every tenant-owned query goes through the scoped Prisma client with an `AuthContext`. Never pass a client-supplied `tenantId` without verifying membership.
- Check permissions by permission key (`members.edit`), never by role name.
- Order of checks: authenticate → resolve tenant/branch → subscription status → entitlement (402) → permission (403) → quota (402) → validate → execute.
- Proxy/middleware is for redirects only. Real checks happen in the service layer, plus RLS.
- Every new tenant-owned table needs: `tenantId` column + FK, RLS policy, registry entry in the scoping extension, and a cross-tenant test.

**Business logic**
- Business logic only in `packages/core`. Server Actions, Route Handlers, and jobs are thin adapters.
- Validate all external input with Zod at the boundary.
- Multi-record financial or membership changes run in one transaction.
- Money is integer paise + currency code. No floats for money, ever.
- Timestamps stored in UTC; render in the tenant timezone.

**Payments & webhooks**
- Verify the signature before reading the body as trusted. Deduplicate by provider event id. Handlers must be idempotent and tolerate out-of-order delivery.
- A redirect or client callback never marks an invoice paid.
- Issued invoices are immutable. Corrections use credit notes.

**Secrets & privacy**
- Never log secrets, tokens, OTPs, passwords, full card data, or health data. Use the redacting logger.
- Integration credentials are encrypted at rest and never returned to the browser.
- No PII inside QR codes.

**Messaging**
- No promotional message without a recorded consent. Opt-outs apply immediately to all future sends.
- Tests never send real email/WhatsApp or take real payments. Use fakes or sandbox.

**Data safety**
- Never run `prisma migrate reset`, drop tables, or edit an applied migration on a database that may contain real data. Ask first.
- Ask before: destructive DB changes, removing features, real messages, real payments, production deploys, security-setting changes.

## Definition of done (per feature)
UI works with loading/empty/error/success states · input validated · authz enforced server-side · tenant + branch isolation tested ·
audit event written for sensitive actions · unit + integration tests for the business rules · e2e test for the main path ·
lint, typecheck, tests, build all pass · `IMPLEMENTATION_STATUS.md` updated with real evidence (commands run and results).

A placeholder screen is not done. A mocked integration is not live — label it "mock" in the status doc.

## Working style
- Inspect before editing. Prefer small, verifiable vertical slices.
- Make reversible technical decisions yourself and note them under "Assumptions" in the status doc.
- If a decision in `DECISIONS.md` looks wrong, stop and propose an amendment instead of quietly deviating.
- Before using a library API, check the installed version and its current docs.
- When context gets long, write progress to `IMPLEMENTATION_STATUS.md` first so the next session can resume.
