# M8 — Intelligence: Reports, Full Dashboard, AI Business Copilot

**Goal:** owners get accurate, drillable reports and a full dashboard built on one set of KPI definitions, plus an
AI Copilot that answers business questions using only authorized data and deterministic figures, through a
platform-configured OpenAI-compatible provider.

Follow the session protocol in `docs/milestones/README.md`.

## Read
- `docs/DECISIONS.md` **D-13**, D-05, D-07
- `docs/KPI_DEFINITIONS.md` (finalize with client answers before building)
- `MASTER_SPEC.md` Module 1, Module 14, Module 15, Module 17 (consolidated owner dashboard, branch comparison), §12, §14 (AI security test)

## Build (in this order)

### 1. Metrics layer
- Finalize `KPI_DEFINITIONS.md` (record client sign-off and version). Every KPI implemented once in `packages/core/metrics` with typed params `{ tenantId, branchIds, period, timezone }`, fixture-based unit tests, and a `explain()` that returns the definition text + numerator/denominator.
- Performance: add indexes and, where needed, daily rollup tables refreshed by worker jobs (documented as derived data with rebuild command). Reports read rollups for history and live tables for today.

### 2. Reports
- Membership, renewals, attendance, revenue invoiced vs collected, outstanding & aging, refunds, lead funnel & conversion, campaign performance, trial conversion, retention/churn indicators, class & trainer utilization, branch comparison, referral performance (+ inventory/expenses after M9).
- Date range + branch filters, comparison to previous period, footer showing KPI definition version, drill-down to records, CSV/XLSX export via background job (`reports.export`, audited, expiring link). Large reports run async with progress.

### 3. Full dashboard
- All Module 1 cards/charts on the metrics layer, configurable date range and branch filter, consolidated multi-branch view for owners, every element navigable to filtered records, "recent activity" feed from audit/domain events. Seed/demo data clearly labelled.

### 4. AI provider config (apps/admin)
- Platform settings → AI: provider label, base URL, model id, API key (encrypted), timeout, max tokens, enabled flag, "Test connection" button. Per-plan entitlement `ai.copilot` + monthly quota `ai.requests` metered per tenant.
- `packages/integrations/ai`: OpenAI-compatible client (`openai` SDK with `baseURL`). Detect tool-calling support at test time; store capability flags. Fallback mode when tools are unsupported: Copilot answers only from a server-built structured summary of the requested metrics.

### 5. Copilot (apps/web)
- Chat panel for permitted roles (`ai.copilot.use`). Flow per spec Module 15: authenticate → resolve tenant/branch scope → model receives **only tool definitions**, never data dumps or schemas → tool calls validated with Zod → each tool calls existing core services/metrics under the caller's `AuthContext` (permissions apply; e.g. a Branch Manager only sees their branches) → results returned as structured data → model writes the explanation → response shows figures **from tool results**, the period, and a "Sources" list of tools/reports used with links.
- Initial tools (read-only): `get_kpis`, `compare_periods`, `list_expiring_memberships`, `list_overdue_invoices`, `list_leads_needing_followup`, `campaign_performance`, `branch_attendance_trend`, `list_unreconciled_payments`, `weekly_summary`, `explain_metric`.
- Guardrails: system prompt states facts-vs-estimates rules and "say when data is insufficient"; post-check rejects answers containing numbers not present in tool outputs (or flags them); prompt-injection resistance (tool outputs treated as data; member-entered text fields are quoted, never followed); no secrets/env in context; per-tenant rate limits; logs store tool names, timings, token counts — not full sensitive content (configurable retention).
- **Actions** (optional, last): Copilot may *propose* creating a follow-up task or drafting a campaign; the user must confirm in a normal UI dialog that calls the regular permission-checked service. No refunds, payments, cancellations, or message sends from AI.
- Optional: "Draft workout plan with AI" for trainers (M7 plans) — saved as draft, must be reviewed/approved by a trainer before assignment; non-medical disclaimer.

### 6. Evaluation
- `apps/web/ai-evals/`: 30+ questions with seeded data and expected tool calls/figures; run as a script (not in CI by default, since it needs a provider); a fake provider runs in CI to test the orchestration.

## Tests required
- Unit: every KPI vs fixtures; tool argument schemas; number-grounding post-check.
- Integration: Copilot under Branch Manager cannot return other-branch data; tenant A Copilot cannot reach tenant B data even if the model asks for a tenant id (tools ignore model-supplied tenant ids); prompt-injection string in a lead note does not change tool behaviour; quota exhaustion returns 402.
- E2E: owner asks "Which memberships expire this week?" (fake provider) → list matches report.

## Acceptance checklist
- [ ] Dashboard and reports agree with each other and with `KPI_DEFINITIONS.md` (shared tests).
- [ ] Platform admin can switch AI provider/model without code changes.
- [ ] Copilot uses authorized data only, reports grounded figures with sources, discloses insufficient data, and performs no unapproved consequential action.
- [ ] Eval script results recorded in status doc for the configured provider.
- [ ] All checks pass; status doc updated.
