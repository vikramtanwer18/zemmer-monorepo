# Milestone Plan

Run **one milestone per Claude Code session** (or a few sessions per milestone if it is large). Open Claude Code
at the repo root and paste: `Run the milestone in docs/milestones/M<n>-<name>.md`.

| # | Milestone | Outcome | Depends on |
|---|---|---|---|
| M0 | [Foundation](M0-foundation.md) | Monorepo, local stack, design system, worker, test + CI harness | — |
| M1 | [SaaS core](M1-saas-core.md) | Both auth realms, tenants, branches, RBAC, entitlements, RLS, platform admin shell, trial onboarding | M0 |
| M2 | [Members & memberships](M2-members-memberships.md) | Members, plans, membership lifecycle, GST invoices, manual payments, credit, notifications, member PWA shell | M1 |
| M3 | [Floor operations](M3-floor-operations.md) | Member QR card + staff scanner, classes & bookings, staff & trainers, PT packages | M2 |
| M4 | [Online payments & SaaS billing](M4-payments-saas-billing.md) | Gym Razorpay links/webhooks/reconciliation/refunds, PWA pay & renew, SaaS subscriptions, staging deploy — **sellable MVP** | M3 |
| M5 | [CRM](M5-crm.md) | Leads, pipeline, trials, follow-up tasks, lead capture, campaign attribution | M4 |
| M6 | [Growth automation](M6-growth-automation.md) | WhatsApp (tenant WABAs), consent, campaigns, automation engine, retention dashboard | M5 |
| M7 | [Fitness & engagement](M7-fitness-engagement.md) | Workouts, nutrition, assessments, streaks, rewards, referrals | M3 |
| M8 | [Intelligence](M8-intelligence.md) | Full reports & dashboard, AI Copilot (OpenAI-compatible) | M6, M7 |
| M9 | [Extended](M9-extended.md) | Expenses, inventory, POS, profitability, custom roles, branch transfers | M8 |

M7 only depends on M3, so it can run in parallel with M5–M6 if you have two developers.

## Standard session protocol (every milestone prompt says "follow the session protocol")

1. **Orient.** Read `CLAUDE.md`, `docs/DECISIONS.md`, `docs/IMPLEMENTATION_STATUS.md`, this milestone file, and only the
   `MASTER_SPEC.md` sections the milestone lists.
2. **Baseline.** Run install, lint, typecheck, tests, build. Record pre-existing failures in the status doc before changing anything.
   If the previous milestone's acceptance checklist is not met, report the gaps and ask whether to fix them first.
3. **Plan.** Write a short plan to the task list: the slices in order, each with its tests. Confirm the data model
   changes (new tables, enums, migrations) in a few lines before writing them.
4. **Build in vertical slices.** Each slice = migration + RLS + core service + adapter (action/route/job) + UI + tests.
   Finish and verify a slice before starting the next.
5. **Verify.** After each slice: lint, typecheck, unit + integration tests. At the end: e2e tests, production build,
   and a browser check of every new screen (desktop + 390px mobile).
6. **Record.** Update `IMPLEMENTATION_STATUS.md` with evidence, assumptions, mocks, and next tasks. Add new
   permission keys to `docs/PERMISSIONS.md` and new KPIs to `docs/KPI_DEFINITIONS.md`.
7. **Stop** when the acceptance checklist passes or a real blocker needs the product owner. End with: what was built,
   what to demo (step-by-step), what is mocked, and open questions.

If the context window gets long mid-milestone, write progress to the status doc first, then continue.

## Start these now (external lead times — not code)

| Item | Needed by | Who |
|---|---|---|
| Meta Business verification + Meta app + **Tech Provider** application (for WhatsApp Embedded Signup) | M6 (Manual Connect works without it) | Client / Fonix |
| A test WhatsApp Business Account + phone number | M6 | Client |
| Razorpay **test-mode** keys: one account acting as a "gym", one as the platform (Fonix/client) | M4 | Client / Fonix |
| AWS account: SES domain verification + request production access (sandbox only mails verified addresses) | M1 (dev uses Mailpit), M4 for staging | Fonix |
| Google OAuth client (web) for `app.` domain | M1 | Fonix |
| Client's CA to confirm SAC code, GST rate, place-of-supply rule, invoice format | M2 | Client |
| Client sign-off on `docs/KPI_DEFINITIONS.md` open questions | M2 (thin dashboard), M8 | Client |
| AI provider account (any OpenAI-compatible endpoint) | M8 | Client |
