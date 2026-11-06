# M0 — Foundation

**Goal:** an empty-but-real platform skeleton every later milestone builds on: monorepo, local stack, shared
config, database plumbing, design system, worker, logging, error model, test harness, CI, and container builds.
No business features yet.

Follow the session protocol in `docs/milestones/README.md`.

## Read
- `CLAUDE.md`, `docs/DECISIONS.md` (all), `docs/IMPLEMENTATION_STATUS.md`
- `MASTER_SPEC.md` §3 Principles, §4 Stack, §11 Frontend & Design System, §12 Background Jobs, §14 Testing, §17 Environment

## Build (in this order)

### 1. Monorepo
- pnpm workspaces + Turborepo. Layout exactly as D-01. TypeScript `strict`, `noUncheckedIndexedAccess`.
- Shared ESLint (incl. a rule or lint script that forbids importing `@prisma/client`/`packages/db` from `apps/*/app/**` client components and forbids `packages/core` importing `apps/*`), Prettier, tsconfig bases in `packages/config`.
- `apps/admin` and `apps/web`: Next.js (latest stable, App Router, `output: 'standalone'`), Tailwind, each with a `/api/health` route.
- `apps/web` has route groups `(staff)` and `(member)` with placeholder layouts. `(member)` gets its own web app manifest and a service worker scoped to the member path (installable, offline fallback page).
- `apps/worker`: Node entry that starts BullMQ workers, exposes a tiny health HTTP endpoint, and shuts down gracefully on SIGTERM (finish in-flight job, then exit).

### 2. Local stack
- `docker-compose.yml`: PostgreSQL (current major), Redis, MinIO (S3), Mailpit (SMTP + UI). Named volumes. Health checks.
- `packages/config/env.ts`: Zod-validated env schema per app; app fails fast with a readable error if env is invalid.
- `.env.example` with every variable, placeholders only, grouped and commented.

### 3. Database plumbing (`packages/db`)
- Prisma with **multi-schema** (`platform`, `app`). Verify the installed Prisma major and use its current config style.
- First migration (raw SQL alongside Prisma) creates DB roles: `gym_owner` (migrations), `gym_app` (web/worker runtime, **no BYPASSRLS**), `gym_platform` (admin runtime). Document how dev/prod connection strings map to roles.
- A placeholder `HealthCheck` table only. Real models start in M1.
- Skeleton of the **tenant-scoping extension** and a `withTenant(ctx, fn)` helper that runs `fn` inside a transaction after `set_config('app.tenant_id', ..., true)`. No tenant tables yet; add one throwaway test table in the test DB to prove the RLS pattern works end to end, then remove it from the main schema (keep the test).
- Seed script entry point (empty for now).

### 4. Core conventions (`packages/core`)
- `AppError` with stable string codes (`AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `ENTITLEMENT_REQUIRED`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `PROVIDER_ERROR`, `INTERNAL`) mapped to HTTP status.
- A standard action/route wrapper: parse with Zod → build context → call service → map errors → consistent JSON `{ ok, data | error: { code, message, fields? } }`.
- Logger: pino, JSON, request id, **redaction list** (password, token, otp, secret, authorization, cookie, keySecret, accessToken, card*, health fields). Test that redaction works.
- Money helpers: `Money { amountMinor: bigint|number, currency }`, add/subtract/multiply-by-rate with half-up rounding, format for INR. Unit tests including rounding edge cases.
- Time helpers: tenant-timezone ↔ UTC, Indian financial year from a date, day boundaries.
- Outbox table design (create in M1 when tenant tables exist) — document it now in `docs/ARCHITECTURE.md`.

### 5. Worker & queues
- Queue registry with typed job payloads. Every job payload carries `{ tenantId | null, actor, idempotencyKey }`. A wrapper re-establishes tenant context in the worker before running the handler.
- Defaults: retries with exponential backoff, timeout, failed-job retention (no silent drops), concurrency per queue.
- A sample `system.ping` job enqueued from `apps/web` and processed by the worker, with an integration test.

### 6. Design system (`packages/ui`)
- Load the `frontend-design` guidance if available. Tokens as CSS variables + Tailwind preset: primary `#204289`, secondary `#394E85`, accent `#00A89D`, background `#F7F7F7`, plus semantic success/warning/danger/info and neutrals.
- **Contrast rule:** `#00A89D` on white is ~3.1:1, so it fails WCAG AA for body text. Use it for fills, icons, and large text; derive a darker accent shade for accent-colored text and links. White text on primary is fine.
- Components: Button, IconButton, Input, Textarea, Select, Combobox, Checkbox, Switch, RadioGroup, FormField (label/help/error), Dialog, ConfirmDialog, Drawer, DropdownMenu, Tabs, Badge, Card, DataTable (server pagination, sorting, column visibility, empty/loading/error states), Pagination, Toast, Skeleton, EmptyState, ErrorState, Breadcrumbs, PageHeader, StatCard, AppShell (responsive sidebar, header slots for tenant/branch switchers, search, notifications, profile menu), MobileTabBar (member PWA).
- Keyboard and screen-reader accessible (focus trap in dialogs, aria labels). A `/ui` showcase route in `apps/web` (dev only) rendering every component in each state.

### 7. Testing & CI
- Vitest workspace (unit per package), integration tests with **Testcontainers** (Postgres + Redis) in `packages/testing`, Playwright in `apps/web` and `apps/admin` with one smoke test each.
- Scripts: `lint`, `typecheck`, `test`, `test:int`, `test:e2e`, `build`, `db:*` (see `CLAUDE.md`).
- GitHub Actions: install (cached) → lint → typecheck → unit → integration → build. E2E on a separate job.

### 8. Containers & docs
- Multi-stage Dockerfiles for admin, web (Next standalone), worker. Non-root user. Health checks.
- `docs/ARCHITECTURE.md`: diagram (Mermaid) of apps, packages, data stores, request flow, job flow, the two auth realms, and the isolation layers.
- `docs/SECURITY.md`: threat-model outline (tenant isolation, auth realms, webhooks, secrets, PII/health data, QR replay) to be filled in as milestones land.
- Fill in the **Commands** section of `CLAUDE.md` with the real commands.

## Out of scope
Any business model, auth, real UI pages beyond placeholders and the UI showcase.

## Acceptance checklist
- [ ] Fresh clone → `docker compose up -d` → `pnpm install` → `pnpm db:migrate` → `pnpm dev` starts admin, web, worker; all `/health` endpoints return OK.
- [ ] `system.ping` job round-trips web → Redis → worker, proven by an integration test.
- [ ] RLS pattern proven by an integration test: as `gym_app`, a row with another `app.tenant_id` is invisible and cannot be inserted.
- [ ] Logger redaction test passes; money rounding tests pass.
- [ ] `/ui` showcase renders every component; Lighthouse/axe shows no critical accessibility violations on it.
- [ ] Member route group is installable as a PWA (manifest + SW detected) and shows an offline page.
- [ ] Lint, typecheck, unit, integration, build all pass locally and in CI. One Playwright smoke test per app passes.
- [ ] Docker images build for all three apps.
- [ ] `ARCHITECTURE.md`, `CLAUDE.md` commands, and `IMPLEMENTATION_STATUS.md` updated.
