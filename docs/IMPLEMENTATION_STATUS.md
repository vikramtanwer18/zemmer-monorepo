# Implementation Status

Update this file at the end of every session with **evidence** (commands you ran and their results).
Never mark something complete that is mocked, partial, or untested.

Last updated: 2026-11-06, M8 built locally against a fake AI provider (Claude Code)

## M8 — Intelligence: reports, full dashboard, AI Copilot (built locally, 2026-11-06; AI provider: fake only)

Baseline: end of M7, all checks passed. **Client KPI sign-off: not available** — built on KPI_DEFINITIONS **v0.2**
with the proposed defaults (grace 7 days, 60-day lead window); every report/dashboard footer shows the version.
**No AI provider account yet**: the Copilot is built and tested against a **fake provider** (deterministic, keyword
routing, repeats tool figures) and scripted fakes in tests. The real OpenAI-compatible client is written but has
**not been called against a live provider** — mark it "mock" until the eval runs on one.

**Built**

- **KPI registry** (`packages/core/src/metrics`): 30 KPIs, each with definition text, unit, numerator/denominator,
  `explain()`, typed scope `{ tenantId, branchIds, period, timezone }` (tenant from the context; branches narrowed to
  the caller's grants; another branch → 403; money only with the money permission for every branch; module KPIs only
  on plans with the module), period presets + custom dates, comparison with the previous same-length period. Pure
  rules in `calc.ts` (renewal, churn, reactivation, unique visits, occupancy, no-show, availability minutes,
  utilisation, aging, collection rate) with fixture tests; SQL loaders. `getDashboardMetrics` (M2) now runs on it.
- **Daily rollup** `app.metric_daily` (derived data): nightly `metrics.rollup` job (snapshot yesterday, refresh 2 days),
  `pnpm metrics:rebuild` (any range, reconstructs active/paused before the first snapshot), indexes for refunds,
  credit notes, trials. Reports read the rollup for history and live tables for today / missing days.
- **Reports** (`/reports`, `/reports/[key]`): 14 reports — membership, renewals & churn, retention & at-risk,
  attendance, revenue invoiced vs collected, outstanding & aging, refunds, lead funnel, campaign performance, trial
  conversion, referrals, class utilisation, trainer utilisation, branch comparison. Each: period + branch filters,
  KPI cards with change vs previous period and a "Definition" disclosure, daily trend charts (server SVG with hover
  titles and a table view), a paginated drill-down table linking every row to the record, KPI version footer.
  Basic reports on every plan; the rest and exports need `reports.advanced` (locked cards say why).
- **Exports**: CSV or Excel (.xlsx, written without dependencies) of the whole table (≤ 50,000 rows) via the
  `reports.export` background job with progress, as the requester with permissions re-checked at run time; private
  storage, 24-hour link, only the requester can download; requested + downloaded events audited; CSV formula cells
  neutralised, XLSX text as inline strings.
- **Full dashboard** (Module 1): members (total, active, new, expiring, renewal rate, at-risk), money (invoiced,
  collected, refunds, outstanding), activity (unique visits, class occupancy, trainer utilisation), sales (open
  leads, new leads, trials booked, lead conversion) — each with comparison, definition and a link to the filtered
  records; daily visits + collected trends; branch comparison for owners with several branches; recent activity
  from the audit log (labels only); "Demo data" banner on seeded gyms; date range + branch filter.
- **AI provider config** (admin `/ai`): label, base URL (https; http only for localhost), model, API key (sealed, last
  4 shown), timeout, max tokens, per-gym rate, log retention, enabled; **Test connection** (plain completion + a
  tool-calling probe → `supports_tools` stored); enabling needs a passing test with the saved settings; changing URL,
  model or key clears the test; a failing test switches the Copilot off; usage per gym this month (requests,
  fallbacks, flagged, errors, tokens). Audited without the key.
- **`packages/integrations/ai`**: OpenAI-compatible client (`openai@7.43.0` `chat.completions` with tools, temperature 0,
  `max_tokens` → `max_completion_tokens` retry, errors mapped to fixed messages), connection test, scripted fake,
  development fake (`AI_FAKE_ENABLED`, refused in production).
- **Copilot** (`/copilot`, nav for `ai.use` + plan `ai.copilot`): chat (conversation only in the browser), example
  questions, answers with sources (links to the report/list), period, "Show the data" (each tool's server summary),
  warnings. 11 tools: `get_kpis`, `compare_periods`, `list_expiring_memberships`, `list_overdue_invoices`,
  `list_leads_needing_followup`, `campaign_performance`, `branch_attendance_trend`, `list_unreconciled_payments`,
  `weekly_summary`, `explain_metric`, and `propose_follow_up_task` (a **proposal** only; the user confirms in a dialog
  that calls the normal task service). Flow: entitlement 402 → permission 403 → monthly quota 402 → per-gym rate 429 →
  validate → tool definitions only → Zod-validated calls (unknown keys like a tenant id dropped) → permission per tool
  → existing metrics/report code under the caller's context → answer → **number grounding check** (flags figures not in
  tool results) → sources. **Fallback** for providers without tool calling: the server routes the question to tools
  and the model only explains a server-built summary; provider failures degrade to the summary. Untrusted text
  (names, lead notes) is fenced under `untrusted`. Log: tool names, timings, tokens, outcome — no content; purged
  after the retention period by the nightly job.
- **Evals** (`apps/web/ai-evals/`): 36 questions (the spec's examples, KPI questions checked against the KPI service,
  definitions, branch scope, refusals: actions, secrets, other gyms, forecasts, injection) and a runner
  (`pnpm ai:eval` for the configured provider, `-- --fake` for the fake); reports in the git-ignored `results/` folder.
- **Permissions**: `ai.use` is now branch-scoped (was tenant-scoped, so branch managers couldn't hold it) and granted
  to Branch Manager; Copilot answers are narrowed to the branches the user may see. `docs/PERMISSIONS.md` regenerated;
  snapshot updated (one cell: BRANCH_MANAGER `ai.use`).
- **Seed**: Iron Temple gets the Copilot (plan overrides "Demo data: AI Copilot", 500 questions/month) and 120 days of
  rollup history.

**Fixed along the way (M7 bugs)**

- `engagement.daily` job schema had `/^d{4}-d{2}-d{2}$/` (backslashes lost): **every nightly engagement job was rejected**
  (streak refresh, ending challenges). Fixed; a catalogue test now checks every nightly job's date format.
- Visit days used `occurred_at AT TIME ZONE tz` on a UTC timestamp without zone: check-ins between 05:30 and 11:00 IST
  counted on the previous day (streaks, visit points, challenges). Fixed to `(… AT TIME ZONE 'UTC') AT TIME ZONE tz`;
  regression test in `m8.int.test.ts`.
- "Collected" (v0.1) subtracted only manual credit refunds and missed online refunds; now uses processed refunds.

### M8 acceptance checklist

- [x] Dashboard and reports agree with each other and with KPI_DEFINITIONS (one registry; integration + e2e tests).
- [x] Platform admin can switch AI provider/model without code changes (admin `/ai`; integration test).
- [x] Copilot uses authorized data only, reports grounded figures with sources, discloses insufficient data, and performs no unapproved consequential action (fake + scripted providers).
- [ ] Eval script results recorded for the configured provider — **only the fake so far: 36/36**. Needs a provider account (open question).
- [x] All checks pass; status doc updated.

### Tests executed (M8, 2026-11-06, Windows 11, Docker Desktop)

| Command                             | Result                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                 | pass                                                                                                                                                                                                                                                                                                                                               |
| `pnpm lint`                         | 11/11 (0 warnings)                                                                                                                                                                                                                                                                                                                                 |
| `pnpm typecheck`                    | 11/11                                                                                                                                                                                                                                                                                                                                              |
| `pnpm test`                         | core 266 (new: KPI calculators 9, scope 5, XLSX 1, Copilot grounding/routing/tool schemas 7, nightly job dates 1), integrations 20, auth 27, ui 12, db 4, worker 2                                                                                                                                                                                 |
| `pnpm test:int`                     | db 7, auth 149 (M8: 12 new), worker 5                                                                                                                                                                                                                                                                                                              |
| `pnpm build`                        | pass (web, admin, worker)                                                                                                                                                                                                                                                                                                                          |
| web e2e (production build on :3100) | M8 spec 4/4 (desktop + Pixel 7). Full suite: 58 passed, 10 skipped, 4 failed in the parallel run (M4 checkout ×2 and M4 screens, M7 trainer flow) — all 12 tests in those files pass when re-run with `--workers 1`. The M4 checkout redirects to `APP_URL` (the dev server on :3000), which was recompiling; the M7 flow is the flake noted in M7 |
| `pnpm db:deploy`                    | 2 M8 migrations applied (additive)                                                                                                                                                                                                                                                                                                                 |
| `pnpm metrics:rebuild -- --days 30` | 319 local gyms, `0.5 s per gym                                                                                                                                                                                                                                                                                                                     |
| `pnpm db:seed`                      | M8 demo added (Copilot on for Iron Temple, 120 rollup days)                                                                                                                                                                                                                                                                                        |
| `pnpm ai:eval -- --fake`            | **36/36** (fake provider)                                                                                                                                                                                                                                                                                                                          |

M8 integration tests (`packages/auth/test/m8.int.test.ts`): dashboard = reports = KPI service on fixtures (active 2,
expiring 2, October new 2 / collected ₹2,000); **branch manager sees only North and gets 403 for Main** (KPIs and
reports); receptionist has no reports; rollup snapshot/refresh/rebuild per local day, **a 07:00 IST check-in counts that
day**, rebuild keeps snapshots and reconstructs older days, **a run on an RLS-bypassing connection writes nothing for
other gyms**; CSV/XLSX export as the requester (manager's file only North), audited, 403 without `reports.export`;
Copilot (fake) "Which memberships expire this week?" → exactly the KPI's members, sources, log without content; **branch
manager's Copilot can't get Main** (tool returns forbidden, no data); **tenant A can't reach B with a model-supplied
tenant id**; first request carries no data; **prompt injection in a lead note** → same single tool, no proposal, note
fenced as untrusted; ungrounded "₹99,999" flagged; **fallback** mode (no tools sent, DATA explained) and provider failure
→ server summary; task proposal creates nothing; **402** without the plan feature and when the monthly quota is used,
403 without `ai.use`, **429** over the rate, 409 when switched off; admin config: https only, enabling needs a passing
test, key sealed (hint …1234, not in audit), tool support detected, model change clears the test, gym role opens the key
but can't read admin-only columns.

E2E (`apps/web/e2e/m8-intelligence.spec.ts`): owner asks "Which memberships expire this week?" (fake) → the 2 expiring
members (not the one in 20 days), source link, data panel → the linked records list shows the same members; dashboard
and the Membership report show the same figures, definition disclosure, records, CSV export queued (processed by the dev
worker: SUCCEEDED, 3 rows). No sideways scrolling.

### M8 decisions (reversible)

- Existing keys kept instead of the milestone's names: permission `ai.use` (milestone `ai.copilot.use`), quota
  `ai.monthly_queries` (milestone `ai.requests`). Same meaning; renaming would churn M1 data.
- `ai.use` became branch-scoped so branch managers can use the Copilot (milestone test); tools narrow the data.
- Reports split: basic (membership, attendance, revenue, dues, refunds) on every plan; the rest + exports need
  `reports.advanced` (the M1 feature is described as "Advanced reports and exports").
- Report exports reuse `data_job` and the M2 download route; XLSX without a library (inline strings, `node:zlib`).
- Monthly quota counts Copilot request-log rows in the gym's calendar month; it is a soft limit (two simultaneous
  last questions can both pass).
- The Copilot conversation is kept only in the browser (nothing to purge); up to 6 earlier turns are sent as context.
- Trends are server-rendered SVG bars (one series per chart, hover titles, table view), not a chart library.
- Recent activity reads curated audit actions (labels only, no details); actor shown as the trainer name or "Staff".
- Demo banner: a gym with a plan override whose reason starts "Demo data".
- Optional "Draft workout plan with AI" for trainers **not built** (optional in the milestone).

### Known limits (M8)

- **No live provider tested**: the OpenAI-compatible client, `max_completion_tokens` fallback and tool-calling probe have
  only run against fakes. Run `pnpm ai:eval` once a provider is configured and record the result here.
- Campaign report groups by the lead's current (last-touch) campaign; M5's report keeps the first/last-touch switch.
- Profitability and inventory reports wait for M9 (expenses/POS).
- Branch comparison computes per branch on request (fine for gyms with tens of branches).
- Active-member history exists only from the first nightly snapshot (or reconstructed by `metrics:rebuild`, marked).
- The admin AI page has no e2e test (covered by integration tests); the Copilot uses the fake in e2e.

## M7 — Fitness programs, nutrition & engagement (done locally, 2026-11-06)

Baseline: end of M6, all checks passed. Nothing external is needed for M7 (no integrations); nothing is mocked.

**Built**

- **Health-data consent & access.** Separate, versioned consent (member app: Train gate and Privacy page; withdraw
  any time). Nothing fitness-related is stored without it. Readable by the member, their **assigned** trainer
  (`fitness.manage` + active assignment) and Owner/Admin (`fitness.view_all`); receptionists, sales and accountants
  get 403 even with `members.view`; unassigned trainers/managers get not-found. Staff views are audited (no values
  in the audit log). Not in the general member export; separate JSON export needs `fitness.export`; the member's own
  data download includes it. A completed deletion request erases it (`app.erase_member_health_data`).
- **Exercise library**: 150 exercises with original instructions copied into each gym on first use; search/filter by
  muscle and equipment; custom exercises with an https media link; hide/show.
- **Workout plans**: template builder (weeks → days → exercises: sets, reps range / seconds / metres, rest, weight
  guidance; reorder; copy week), assign to a member (their own copy, one active plan), edit = new immutable version
  (logs keep the version they used), end plan. Member PWA: today's session (repeating weeks; next undone day this week),
  start, set-by-set logging with rest timer and "how to", correct or remove sets, finish with effort/notes, free
  workouts, history; PRs (heaviest, est. 1-rep max, most reps, longest, farthest) computed from the sets when finished.
- **Assessments & goals**: trainer assessments (12 fixed metrics), member self-measurements, SVG progress charts
  (measurements, PR history), goals with progress bars and auto-achieve; non-medical disclaimer on plan pages.
- **Nutrition** (Pro plan): `124` common Indian foods per 100 g with source; trainer diet plans (targets + meal list);
  member food log by servings or grams with **source and assumptions stored and shown**, custom entries (warns when
  calories don't match macros), corrections marked "edited", water taps with undo, weekly summary vs targets labelled
  estimates.
- **Trainer feedback & announcements**: feedback on a workout or general notes → in-app notification + shown on the
  workout; gym announcements to all / a branch / a plan's members → member News feed + in-app notification. Members
  now have a notifications page and an unread badge in the app header (there was none before M7).
- **Streaks & milestones**: weekly streak (≥ N visit days/week), paused weeks skipped, frozen during an expiry grace
  period then reset; 12 milestones; visits count once a day.
- **Challenges & leaderboards**: visit- or workout-day challenges only, draft → active → ended, opt-in with a chosen
  board name and board opt-out, completion points once.
- **Rewards & referrals**: rules per trigger, append-only ledger with unique source keys, weekly visit-reward cap, points →
  member credit (atomic, auto-applied to open invoices), staff-fulfilled perks (refuse = points back), manual
  adjustments; per-member referral code and public invite page `/r/<gym>/<code>` → CRM lead (source referral) →
  reward once when the friend's membership is paid → `referral.converted` event for M6 automations.
- **Staff screens**: Fitness (my clients / member search, member fitness page, templates, exercises, foods),
  Engagement (announcements, challenges, rewards & streak settings, perk pickups, referrals). Nav: Fitness, Engagement,
  Reward pickups (receptionists and branch managers have `rewards.fulfil`).
- **Jobs/events**: check-ins emit `attendance.checked_in`; the engagement handler (points, streak, challenges,
  milestones) and the referral reward run through the M5 event dispatcher; nightly `engagement.daily` refreshes
  streaks and ends past challenges.
- **Permissions**: `fitness.view_all`, `fitness.export`, `engagement.manage` (tenant), `rewards.fulfil` (branch).
  `docs/PERMISSIONS.md` regenerated; snapshot updated (additions only).
- **Seed**: Iron Temple gets a template, the demo member's consent, plan, a logged workout with PRs, assessments, a
  goal, a diet plan and food/water logs, an announcement, an active challenge and a perk. Nutrition is switched on for
  Iron Temple by a plan override marked "Demo data".

### M7 acceptance checklist

- [x] Trainer authoring and member tracking work end to end on mobile (e2e on desktop + Pixel 7).
- [x] Health data protected by consent + strict access rules (integration tests below).
- [x] Nutrition estimates show source and uncertainty; members can correct them.
- [x] Streak/reward rules documented (KPI_DEFINITIONS "Streaks, milestones, rewards and fitness") and tested; no reward for overtraining patterns.
- [x] All checks pass; status doc updated.

### Tests executed (M7, 2026-11-06, Windows 11, Docker Desktop)

| Command                             | Result                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                 | pass                                                                                                                                                                                                                                                                                                                                         |
| `pnpm lint`                         | 11/11 (0 warnings)                                                                                                                                                                                                                                                                                                                           |
| `pnpm typecheck`                    | 11/11                                                                                                                                                                                                                                                                                                                                        |
| `pnpm test`                         | core 242 (16 new: PR detection incl. Epley range, structure validation and next day, goal progress, macro estimation and rounding, assumptions, weekly summary, streak rules incl. pause/expiry/unfinished week, visit cap, milestones once, points→credit, referral codes, challenge days), integrations 20, auth 27, ui 12, db 4, worker 2 |
| `pnpm test:int`                     | db 7, auth 137 (M7: 14 new), worker 5                                                                                                                                                                                                                                                                                                        |
| `pnpm build`                        | pass                                                                                                                                                                                                                                                                                                                                         |
| web e2e (production build on :3100) | 58 passed, 10 skipped; M7 spec also `--repeat-each 2` (8/8)                                                                                                                                                                                                                                                                                  |
| `pnpm db:seed`                      | M7 demo added                                                                                                                                                                                                                                                                                                                                |

M7 integration tests (`packages/auth/test/m7.int.test.ts`): per-gym library copies; **nothing stored before consent**;
**trainer can't read a non-assigned member's data**; **receptionist, sales and accountant denied**; branch manager
not-found; owner reads via view_all; staff reads audited; other gym not-found; withdrawn consent blocks staff and new
records; **member A can't read or write member B's workout**; set-by-set logging, correction, PRs (5 records), no PR on a
lighter day, plan edit → version 2 while logs keep version 1; trainer feedback → member notification; assessments,
goal progress 50% → achieved; **no values in the audit log**; **health data absent from the general member export**,
present in the member's own export and the fitness export (owner only); deletion erases health data; nutrition
estimate (2 rotis = 228 kcal / 7.7 / 39.2 / 4.4) with source + assumptions, custom mismatch warning, correction,
nutrition refused on Growth; 8 check-ins over 7 days → 5 rewarded visit days, replay changes nothing; challenge opt-in,
distinct-day progress, completion points once, leaderboard names; **redemption to credit is atomic** (two concurrent
300-point redemptions: one succeeds, credit ₹150, balance 200), perk refusal returns points, trainer can't fulfil;
**referral reward once** with referral.converted emitted; branch announcements reach only that branch.

E2E (`apps/web/e2e/m7-fitness.spec.ts`): member consents → trainer builds a template (2 exercises) and assigns it →
member logs squat 5 × 60 kg and a 45 s plank, finishes → "personal records" message and records card → trainer sees
the PR and leaves feedback → member sees the unread badge, the notification, and the feedback on the workout; referral
link from the member app → friend's form (not signed in) → lead converted and paid → referrer shows 500 points and
"joined, +500". No sideways scrolling on the M7 screens tested.

### M7 decisions (reversible)

- Template and plan days/items live in a validated structure JSON (one immutable row per plan version) instead of
  separate day/item tables; logs reference exercises relationally. Simpler versioning, same queries for PRs.
- The built-in exercise and food libraries are copied into each gym on first use (uniform RLS; gyms can hide or add).
- Food values are rounded estimates written for this product (labelled IFCT/USDA "approx.", typical label, or recipe
  estimate); **a nutritionist should review the library before launch** (see open questions).
- Charts are small server-rendered SVGs (accessible, no client JS) rather than Recharts (no new dependency).
- Health consent also governs staff viewing: after withdrawal, staff can't open the member's fitness data; the member
  still sees their history and can ask for deletion.
- Points: 1 point = ₹0.50 as credit by default, 200-point minimum; visit 10, workout 5, referral 500; 5 rewarded
  visit days a week. All editable by the gym.
- Notifications for M7 are in-app only (no email/WhatsApp) to keep messages low-key; announcements could later go on
  WhatsApp through M6 consent rules.

### Known limits (M7)

- No exercise media upload (links only); no superset/circuit grouping; plan schedule is "next undone day this week",
  not fixed weekdays.
- Leaderboards show up to 10 (member) / 100 (staff) names; ties share a rank.
- The streak is recomputed on each check-in and nightly; a missed week appears the next morning.

## M6 — Growth automation: WhatsApp, consent, campaigns, automation, retention (built locally, 2026-11-05; not accepted until tried on a real WABA)

Everything runs against a **fake WhatsApp provider** (no message ever leaves the machine). The Meta Cloud API
adapter is written from Meta's docs (checked 2026-11-05, Graph v27.0) and unit-tested against recorded request
shapes, but **has not been run against a live WABA**: label it "mock" until the checks under "Meta prerequisites" pass.

**Built**

- **Connection (D-12).** Manual Connect (WABA id, phone number id, system-user token) verified with live-shaped
  calls (number details + number belongs to the WABA), app subscribed to the WABA's webhooks, token sealed
  (last 4 shown), status card (number, quality, messaging limit, templates), check / sync / disconnect, setup
  guide page (screenshot placeholders). **Embedded Signup** implemented (Facebook SDK popup, server-side code
  exchange, same connect path) behind the platform flag `whatsapp.embedded_signup_enabled` (admin → Platform
  settings) **and** `META_APP_ID`/`META_APP_SECRET`/`META_EMBEDDED_SIGNUP_CONFIG_ID`; gyms see "Coming soon" otherwise.
- **One webhook** `/api/webhooks/whatsapp`: GET handshake (verify token), POST `X-Hub-Signature-256` over the raw
  body, routing by phone number id (`app.whatsapp_route`) + WABA check, dedupe (`message_event`), outbox → worker.
- **Templates**: sync on connect, nightly (growth.daily) and "Sync templates"; status updates from
  `message_template_status_update`; placeholders (positional or named) extracted; deep link to WhatsApp Manager.
- **Consent & opt-out**: send gate re-checked **at send time** for every message (plan, account, monthly quota,
  suppression, 24-hour window for free text, template approved, marketing vs service consent, per-number daily
  promotional cap). Opt-out keywords (English + Hindi/transliterations, editable) → suppression + revoked consent +
  confirmation reply; START opts back in (recorded as consent). Staff can opt numbers out; lifting needs recorded
  consent evidence. Meta 131050 revokes marketing consent.
- **Sending**: `outbound_message` per send with an idempotency key; outbox → `messaging.send` job; row locked,
  re-checked, claimed (QUEUED → SENDING, never resent); retryable errors back off (BullMQ, 5 tries), permanent ones
  FAILED with reason; stuck SENDING rows marked FAILED after 15 min (not resent). Delivery/read/failed statuses only
  move forward. **Notifications on WhatsApp**: payment links, overdue dues, expiring/expired/activated memberships,
  receipts, class reminders, trial confirmations go out on WhatsApp when the gym maps an approved UTILITY template.
- **Inbox** (minimal): threads per number linked to member/lead, unread, reply inside the 24-hour window,
  assign to me, send a template.
- **Audiences & campaigns**: audience builder (members: status, branch, plan, current/lapsed/never, ends in /
  ended N days, last visit, tags, joined; leads: stage, status, branch, source, campaign, enquired) → Zod DSL →
  Prisma filter; preview count / reachable / opted out / sample (masked). Campaign: template + variable mapping
  (fields or fixed text, all placeholders required) + audience + throttle + attribution window → estimate (recipients,
  reachable, category, preview) → explicit confirm → send now or schedule → throttled batches (and the messaging-
  limit tier) → live stats → attribution (renewals, payers, lead conversions). Test-send to staff numbers; cancel.
- **Automation engine**: versioned, validated JSON workflows; triggers from domain events (lead._, trial._,
  lead.converted, **membership.activated**, **class.booking_cancelled**, **retention.flagged**, referral.converted
  reserved for M7) and daily scans (membership.expiring / expired N days, payment.overdue N days); conditions
  (branch, plan, amount, lead source, audience); steps (send template, task, assign, notify, owner alert, move lead
  stage, wait, approval); exit when renewed / paid / contacted / closed / visited; dry run over the last 7 days;
  approvals page (`automations.approve`, branch-scoped); runs list with step results and errors; stop a run.
  Five ready-made workflows (expiry reminders, overdue follow-up, speed-to-lead, trial no-show rescue, win-back 30).
- **Retention**: six rules with gym thresholds (no visit, visits dropping, expiring not renewed, overdue, unused
  class credits, trial not followed up), nightly flags with the reason and numbers, auto-resolve, dashboard by
  reason with suggested action and one-click task / template / dismiss, recovery outcomes (renewed, paid,
  reactivated, converted; from flags and automations) labelled "associated, not causal".
- **Permissions**: `marketing.send` (tenant), `automations.manage` (tenant), `automations.approve` (branch: Branch
  Manager), `retention.view` (branch: Branch Manager, Sales). `docs/PERMISSIONS.md` regenerated; snapshot updated.
- **Seed**: with `WHATSAPP_FAKE_ENABLED=true` Iron Temple gets the test provider, two notification mappings, an
  audience + draft campaign, the five workflows (expiry reminders on) and a retention run.

### M6 acceptance checklist

- [x] Tenant-owned WABA via Manual Connect (fake provider); Embedded Signup behind a flag. **Meta approval: none yet** (no Tech Provider status, no Meta app).
- [x] Messaging tenant-scoped, consent-checked at send time, opt-outs immediate (integration tests below).
- [x] Workflows run once per trigger, every step recorded and audited on failure, approval blocks until decided.
- [x] Retention dashboard with rule-based flags (rule shown) and recovery outcomes.
- [x] All checks pass (below). Outstanding Meta prerequisites listed below.
- [ ] Tried against a real WABA (blocked on the client: see prerequisites).

### Meta prerequisites still outstanding (exact)

1. A **Meta app** for the operator (Business type) with the WhatsApp product: set `META_APP_ID`, `META_APP_SECRET`,
   `META_WEBHOOK_VERIFY_TOKEN`; webhook URL `https://<app>/api/webhooks/whatsapp` subscribed to **messages** and
   **message_template_status_update**.
2. A **test WABA** (Meta's test number is enough) with a system-user token (`whatsapp_business_messaging` +
   `whatsapp_business_management`), to check live: `GET /{phone-number-id}` fields (incl.
   `whatsapp_business_manager_messaging_limit`), `GET /{waba}/phone_numbers`, `POST /{waba}/subscribed_apps`,
   `GET /{waba}/message_templates` paging, a template send (positional and named), status and inbound webhooks,
   and the retryable/permanent error codes we assume (130429, 131056 retry; 131026, 131047 permanent; 131050).
3. Approved templates in that WABA matching our ready-made workflows (`membership_renewal_reminder`,
   `payment_due_reminder`, `we_miss_you`, …) or the gym's own, for the pilot.
4. For **Embedded Signup**: Meta **Tech Provider** approval (business verification + app review), an Embedded
   Signup configuration (`META_EMBEDDED_SIGNUP_CONFIG_ID`), then switch on the platform flag. Still to verify live:
   the session-info message shape, whether newly added numbers need `POST /{phone}/register` (PIN), and token type.
5. Screenshots for the setup guide (placeholders now).

### Tests executed (M6, 2026-11-05, Windows 11, Docker Desktop)

| Command                                             | Result                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                 | pass                                                                                                                                                                                                                                                                                  |
| `pnpm lint`                                         | 11/11 tasks pass (0 warnings)                                                                                                                                                                                                                                                         |
| `pnpm typecheck`                                    | 11/11 pass                                                                                                                                                                                                                                                                            |
| `pnpm test`                                         | core 226 (incl. new: send gate, 24-h window, keywords, consent history, template params, status ordering, segment DSL incl. injection, workflow conditions/definitions, visit drop), integrations 20 (Meta adapter + fake + Embedded Signup exchange), auth 27, ui 12, db 4, worker 2 |
| `pnpm test:int`                                     | db 7, auth 123 (M6: 16 new), worker 5 — all pass                                                                                                                                                                                                                                      |
| `pnpm build`                                        | pass                                                                                                                                                                                                                                                                                  |
| web e2e (production build on :3100, `E2E_BASE_URL`) | 54 passed, 10 skipped (cross-app / env-gated); M6 spec also run with `--repeat-each 2` (8/8)                                                                                                                                                                                          |
| admin e2e (production build on :3101)               | 7/7                                                                                                                                                                                                                                                                                   |
| `pnpm db:seed`                                      | M6 demo added, second run skips                                                                                                                                                                                                                                                       |

M6 integration tests (`packages/auth/test/m6.int.test.ts`, fake WhatsApp): plan feature + permission + fake-only-where-allowed;
connect seals the token and syncs 7 templates, one number per gym; **forged Meta webhook rejected (nothing stored)**;
**WABA X's events never touch tenant Y**, mismatched WABA dropped, duplicates stored once; 24-hour window; UTILITY vs
MARKETING consent at send time, daily cap, idempotent keys; **retry after a transient failure sends exactly once**;
**the same send delivered three times at once goes out once and stays SENT**; out-of-order statuses; **STOP →
suppression, confirmation, no further sends; START re-subscribes**; notification → UTILITY template mapping (MARKETING
refused); campaign: audience preview, permission, variable checks, estimate, test-send, schedule, **STOP after scheduling
still wins**, throttle (2/min → two batches), live stats, delivered status, opted-out count, attribution renewal;
**duplicate trigger → single execution** (same event dispatched twice, same key twice, new version); expiry workflow
queues the reminder once, waits, then completes; **approval step blocks** (receptionist and other-branch manager refused);
five ready-made workflows install switched off; retention flag with the rule, no duplicate, event once, resolves on a
visit with a REACTIVATED outcome; other gym sees nothing.

E2E (`apps/web/e2e/m6-growth.spec.ts`): connect the test provider in the UI → templates listed → audience preview (2) →
campaign with template + mapping + audience → confirm and launch → worker sends 2 → wrongly signed webhook 401, signed
delivery 200 → stats "Sent 2 / Delivered 1" → a recipient renews → attribution "Renewed 1" → install + switch on the expiry
workflow → a member 7 days from the end → scans twice start one run → one automated message → run listed. Plus every M6
screen loads without sideways scrolling (desktop + mobile).

Bugs found and fixed while testing: a second worker handling the same send could see the first one's just-committed
send, count it against the daily cap and overwrite SENT with SKIPPED (now: row lock, the message itself excluded from the
count, conditional update; regression test added); webhook items are locked while processed. The M5 trial-pass test
failed after 23:00 IST ("an hour from now" is tomorrow); it now uses a fixed mid-morning clock (product logic unchanged).

### M6 decisions (reversible)

- Phones stay E.164 in our tables; converted to Meta's bare digits only in the adapter.
- Members: WhatsApp service consent counts as given unless revoked (as in M2); marketing only when granted. Leads:
  service yes (they enquired), marketing from the M5 form/staff tick unless a later consent row says otherwise.
- Suppression (STOP) blocks **every** WhatsApp send, reminders included; only the opt-out/opt-in confirmation reply is let through.
- The daily promotional cap (default 1, 0–10) counts campaigns **and** automations per number, rolling 24 hours; test sends excluded.
- Campaign audiences are taken when the campaign starts; consent is judged per message when it is sent.
- Throttle by releasing at most N recipients per minute per campaign (plus the tier's unique-recipient limit), not by queue rate limiting.
- The workflow editor is validated JSON with a reference panel (ready-made workflows cover the common cases); a visual step builder can come later.
- Approval requests are notified to owners, admins and the branch's managers (who to tell, not an access check; approving checks `automations.approve`).
- Retention runs for every active gym (no plan gate); automations, campaigns and WhatsApp need Growth/Pro features.
- Meta error codes considered retryable: 1, 2, 4, 17, 80007, 130429, 131000, 131016, 131056, 133004 and HTTP 5xx/429 (to confirm live).
- e2e runs against a production build on a spare port (`E2E_BASE_URL`) while the developer's own `pnpm dev` keeps running; the e2e fixture plays the worker (idempotent).

### Known limits (M6)

- Not tried on a live WABA (above). Embedded Signup never run end to end.
- Retry backoff for rate limits is the queue default (2 s exponential, 5 tries); a longer, Meta-aware backoff may be needed under real limits.
- Media messages (images, documents) are stored as "[type]" only; inbox is single-agent (assign, no collision detection).
- The worker's per-minute messaging tick runs for every active gym; fine for the pilot, revisit at scale.

## M5 — CRM: leads, pipeline, trials, follow-ups, attribution (done locally, 2026-11-05)

Baseline before M5 (end of M4): format, lint 11/11, typecheck 11/11, unit (core 191, auth 27, integrations 12, ui 12, db 4, worker 2), integration (db 7, auth 94, worker 5), build — all pass. M4's open items (AWS staging, live Razorpay) are blocked on the client and stay open; M5 needs neither.

| Slice                                                                                                                                                                                                                                                                                                                                                                                     | State | Where                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| 1. Data model: 13 gym tables with RLS; timeline and event receipts append-only; leads, tasks, trials, stages, campaigns, forms, keys never deleted; CHECKs (contactable lead, won/lost dates match status, lost needs a reason, ranges); `Membership.leadId`; CRM settings; public lookups `capture_form_lookup` / `api_key_lookup` / `trial_pass_lookup`; operator dead-letter functions | Done  | migrations `20261105120000_m5_crm`, `20261105120100_m5_rls_and_functions`; `docs/DATABASE_DESIGN.md` "M5 entities" |
| 2. Permissions `leads.assign`, `leads.import`, `leads.export`, `tasks.manage`, `crm.configure`; everything behind plan feature `crm.enabled` (Growth, Pro); nav hidden without it, pages show an upgrade notice                                                                                                                                                                           | Done  | `docs/PERMISSIONS.md` regenerated                                                                                  |
| 3. Lead entry & list: staff form with duplicate check (leads + members, named matches, "add anyway"); list with filters (stage, owner, source, campaign, branch, dates, overdue task, search, sort), saved views (personal or team), export                                                                                                                                               | Done  | `/leads`, `/leads/new`                                                                                             |
| 4. Pipeline board: Kanban per stage, drag-and-drop plus a "Move to" picker (keyboard, phones); checked on the server; Won only via a paid membership, Lost needs a reason; stage settings: rename, reorder within funnel order, add (mapped to a category), remove only after moving leads to a same-kind stage                                                                           | Done  | `/leads/board`, `/settings/crm`                                                                                    |
| 5. Assignment: manual, or round-robin per branch among Sales Staff (row-locked pointer, fair under concurrency); reassignment logged, open tasks follow, new owner notified                                                                                                                                                                                                               | Done  |                                                                                                                    |
| 6. Follow-up tasks: for a lead, member or branch; "My tasks" / team view; overdue badges; reminders in-app + email; first-contact task for every new lead with an SLA (default 15 min); SLA breach → event + alert to owner and managers                                                                                                                                                  | Done  | `/tasks`, lead page                                                                                                |
| 7. Trials: free slot or a class seat (same capacity rule as member bookings); emailed trial pass `/t/{code}` with a QR (`GT1.…`, no personal data) checked in on the Scan page at that branch on that day, once; or marked by hand; missed trials auto no-show after 2 h (stage back to Contacted + call-back task)                                                                       | Done  | `/leads/trials`, `/scan`, `/t/…`                                                                                   |
| 8. Conversion: "Convert to member" creates (or links) the member, opens the sale with the lead attached; when that membership is paid/activated the lead is WON with member + membership links, in the activation transaction                                                                                                                                                             | Done  | lead page → `/members/{id}/sell?leadId=…`                                                                          |
| 9. Capture: hosted form `/l/{gym}/{form}` (unframeable), embeddable script + strict-CSP embed variant, honeypot, rate limits (10/h per IP, 300/h per form), captcha hook, consent text stored with the lead, UTM + referrer kept; website API `POST /api/public/v1/leads` with hashed, scoped, revocable keys, per-key limit, `Idempotency-Key`; OpenAPI at `/api/public/v1/openapi.json` | Done  | `/settings/crm/forms`, `/settings/crm/api`, `docs/API_DESIGN.md`                                                   |
| 10. Scoring: rule-based, breakdown shown on the lead (source points, recency, talked to us, trial booked/attended/missed, offer sent), "not a prediction"                                                                                                                                                                                                                                 | Done  |                                                                                                                    |
| 11. Import/export: CSV import with a dry run (worker; repeat enquiries merged), export of the current filters (worker; permission + audit; 24 h link)                                                                                                                                                                                                                                     | Done  | `/leads/import`                                                                                                    |
| 12. Campaigns and attribution: campaigns with tracking codes; first and last touch on each lead; report (cohort): leads → contacted → trials → joined → revenue, by campaign or source, either touch model; trial-to-member rate                                                                                                                                                          | Done  | `/leads/campaigns`, `/leads/reports`; `docs/KPI_DEFINITIONS.md` "CRM"                                              |
| 13. Domain events through the outbox: `lead.created`, `lead.stage_changed`, `lead.assigned`, `lead.uncontacted_sla_breached`, `lead.lost`, `lead.converted`, `trial.booked`, `trial.attended`, `trial.no_show`, `trial.cancelled`; handlers run once each                                                                                                                                 | Done  | `packages/core/src/events`                                                                                         |
| 14. Job hardening: event dispatch queue, 5-minute CRM tick, admin System health shows outbox counts and dead letters (ids, topic, error; never payloads) with retry                                                                                                                                                                                                                       | Done  | admin `/system`                                                                                                    |
| 15. Demo seed: Iron Temple gets a campaign, a website form and 5 leads at different stages                                                                                                                                                                                                                                                                                                | Done  | `pnpm db:seed` (ran; re-run skips)                                                                                 |

### M5 acceptance checklist

- [x] **A lead can be traced from capture through trial to a paid membership, with source and campaign intact.** E2E `m5-crm.spec.ts` (desktop + phone): website form with UTM → lead shows campaign and UTM → owner takes it, the first-contact task is in Tasks → call logged → trial booked → attended → converted → membership sold and paid → lead WON → the campaign report shows 1 joined (100%) and ₹2,000 revenue. Integration "class trial takes a seat…" proves the same chain plus the `lead.converted` event with the campaign.
- [x] **Custom stages never break funnel reports.** Stages map to fixed categories; reports read categories and recorded facts; integration "custom stages map to categories…" (funnel order kept, last stage of a category protected, leads move only to a same-kind stage).
- [x] **Public capture is abuse-resistant and tenant-safe.** Integration: the form key alone decides gym and branch (a body naming gym B is ignored), A's key under B's slug → 404, honeypot stores nothing, consent required, repeat enquiries merge; API: missing/wrong/revoked key 401, missing scope 403, unknown fields 422, idempotent replay and 409 on a changed body, key hash stored only. E2E: hosted page `X-Frame-Options: DENY`, embed `frame-ancestors` limited to the form's sites.
- [x] **Outbox events emitted for every lead lifecycle step.** Integration checks the outbox rows; "each handler runs exactly once…" (retry of a failing handler only, 3 parallel duplicate deliveries → still once, receipts append-only).
- [x] **All checks pass; API docs and status doc updated.** See below.

### Tests executed (M5, 2026-11-05, Windows 11, Docker Desktop)

| Command                       | Result                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`           | All files formatted                                                                                                                                                                                |
| `pnpm lint`                   | 11/11 tasks, 0 warnings                                                                                                                                                                            |
| `pnpm typecheck`              | 11/11 tasks                                                                                                                                                                                        |
| `pnpm test`                   | core 203 (+12: duplicate matching, round-robin fairness, scoring, stage categories, attribution, trial QR, API keys, OpenAPI ↔ schema), auth 27, integrations 12, ui 12, db 4, worker 2 — all pass |
| `pnpm test:int`               | db 7, auth 107 (M5: 13), worker 5 — all pass                                                                                                                                                       |
| `pnpm build`                  | web, admin, worker build                                                                                                                                                                           |
| `apps/web: playwright test`   | 50 passed, 10 skipped (desktop-only flows on phone, and the cross-app subscribe test) on a fresh build at :3100; `m5-crm.spec.ts` 6/6                                                              |
| `apps/admin: playwright test` | 7 passed                                                                                                                                                                                           |
| Browser check                 | Every M5 screen at 1366 px and 390 px via `m5-crm.spec.ts` (no sideways scrolling); report and CRM settings screenshots reviewed                                                                   |
| `pnpm db:seed`                | CRM demo added to Iron Temple; second run skips                                                                                                                                                    |

M5 bugs found by these runs and fixed:

- Setting won/lost dates and the status in two statements broke the database check that keeps them consistent; now one update.
- Round-robin held the branch lock for the whole lead transaction, so a burst of enquiries for one branch queued (a transaction timed out under load); the owner is now picked last.
- The owner picker on a lead defaulted to "Nobody".
- The members import page listed lead jobs too.
- Test-suite fixes (not product bugs): the e2e suite exceeded the per-IP sign-in/OTP limits in one run (fixtures now clear the dev counters before each sign-in); an admin test raced the post-sign-in redirect.

### M5 decisions (reversible)

- CRM is a plan feature (`crm.enabled`: Growth and Pro, not Starter), as seeded in M1.
- Round-robin uses the **Sales Staff** role at the branch (or gym-wide), per the milestone; with nobody in that role, leads stay unassigned. Owner/assignee pickers list owner, admin, manager, receptionist and sales roles (recipient choice, not access control).
- Taking an unowned lead needs `leads.manage`; giving a lead to someone else needs `leads.assign` (owner, admin, manager).
- A lead is WON only when a membership sold from it is paid/activated; "Convert to member" alone keeps it open.
- First-contact SLA counts a logged call, email or meeting, or finishing the first-contact task; a note isn't contact.
- Form/API/import enquiries matching an **open** lead (same phone or email) are merged as a repeat enquiry; staff entry asks instead.
- Attribution defaults to the last touch (KPI doc); staff corrections of source/campaign update the touches.
- Lead conversion rate counts every win so far (no 60-day cut-off yet; KPI question 4).
- Trials missed by 2 hours become no-shows automatically.
- Staff consent tick on a new lead is unticked by default.
- Domain events reuse the M2 outbox (row id = event id) rather than a new table.

## M4 — Online payments, refunds, SaaS billing, staging (built 2026-11-05; not yet accepted)

**Not done yet: the AWS staging deploy (waiting for go-ahead and AWS access) and any test against real Razorpay (no keys yet).** Everything else in the milestone is built and tested against the **fake payment provider** (Redis-backed, emits signed Razorpay-shaped webhooks). Razorpay docs checked 2026-11-05: `X-Razorpay-Signature` = HMAC-SHA256 of the raw body; dedup header `x-razorpay-event-id`; events may arrive out of order; payment links (`accept_partial`, `first_min_partial_amount`, `reference_id` ≤ 40 chars); fetching a link returns its captured `payments[]`; refund `receipt` is the idempotency key; subscription events and `cancel_at_cycle_end`.

| Slice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | State                                                                    | Where                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Provider adapter: `PaymentProvider` / `SubscriptionProvider`, Razorpay over REST (no SDK), fake provider, factory                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Done; **Razorpay adapter is mock-tested only** (request/response shapes) | `packages/integrations/src/payments`                                                                                                                                                                          |
| 2. Data model: 8 gym tables + RLS, 8 platform tables, extended subscription / payment / settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Done                                                                     | migrations `20261105090000_*`, `…090100_*`, `…090200_*`; `docs/DATABASE_DESIGN.md` "M4 entities"                                                                                                              |
| 3. Gym connects Razorpay (Settings → Online payments, `settings.payments`): keys checked first, secrets sealed, last 4 shown, webhook URL per integration, rotate/disconnect audited                                                                                                                                                                                                                                                                                                                                                                                 | Done                                                                     | `packages/core/src/payments/integration.ts`, `settings/payments`                                                                                                                                              |
| 4. Collecting online: staff links (full or part payments with a minimum, copy/email, cancel, re-check); member Pay balance (optional part payment), Renew, Buy a plan (`onlinePurchase` plans only, home branch); "Confirming payment…" page polls our API only; webhook endpoint (signature → store once → queue → 200); worker processor; reconciliation every 15 min + nightly + "Check with Razorpay now"; Payment links / Reconciliation pages                                                                                                                  | Done                                                                     | `payments/{links,sync,reconciliation-view}.ts`; `apps/web/app/api/webhooks/razorpay/[integrationId]`; `/payments/links`, `/payments/reconciliation`; `/m/invoices`, `/m/plans`, `/m/pay/return`               |
| 5. Refunds: online (provider) and manual (method recorded), credit note first, approval above a threshold by someone other than the requester, optional membership cancellation, status by webhook + reconciliation                                                                                                                                                                                                                                                                                                                                                  | Done                                                                     | `payments/refunds.ts`; `/payments/[id]/refund`, `/payments/refunds`                                                                                                                                           |
| 6. Dues: aging buckets, dues page, daily reminders on chosen overdue days; renewal reminders open the app home with "Renew and pay online"                                                                                                                                                                                                                                                                                                                                                                                                                           | Done                                                                     | `payments/dues.ts`; `/payments/dues`                                                                                                                                                                          |
| 7. SaaS billing: platform account + webhook (admin app only), prices per cycle (provider plans created lazily), owner billing page (`subscription.manage`) via signed web → admin requests, upgrade now / downgrade at period end / cancel at period end, lifecycle TRIALING → ACTIVE → PAST_DUE → GRACE → SUSPENDED with one dunning email per stage, SaaS invoices (supplier GSTIN settable; CGST/SGST/IGST), banners, MRR/ARR, extend trial, free access (comp), usage analytics, announcements, System health (queues, failed jobs with retry, webhook counters) | Done                                                                     | `packages/core/src/saas-billing`; `apps/admin` `/billing`, `/billing/setup`, `/usage`, `/announcements`, `/system`, `/api/internal/billing/*`, `/api/webhooks/razorpay-platform`; `apps/web` `/settings/plan` |
| 8. Privacy minimum: notice + consent before using the member app, Download my data, Request deletion → staff complete (anonymise) or decline; retention policy                                                                                                                                                                                                                                                                                                                                                                                                       | Done                                                                     | `members/privacy.ts`; `/m/privacy`, `/members/privacy`; `docs/SECURITY.md`                                                                                                                                    |
| 9. Plan feature `online_payments.enabled` enforced (402 before 403) for connecting, staff links and member links; members see no Pay button without it                                                                                                                                                                                                                                                                                                                                                                                                               | Done                                                                     | `integration.ts`, `links.ts`                                                                                                                                                                                  |
| 10. Staging & operations: compose for one EC2 host, Caddy TLS, Secrets Manager → env, release script (migrate first), RDS roles SQL, monitoring/alarm plan, runbooks                                                                                                                                                                                                                                                                                                                                                                                                 | **Prepared, not deployed**; restore drill not run                        | `infra/staging/`, `docs/RUNBOOKS.md`                                                                                                                                                                          |
| 11. Demo seed: with `PAYMENTS_FAKE_ENABLED=true`, Iron Temple connects the test provider and "Monthly Unlimited" can be bought in the app; the platform gets a test account when the Super Admin is seeded                                                                                                                                                                                                                                                                                                                                                           | Written, **not run this session**                                        | `packages/auth/scripts/demo-payments.ts`                                                                                                                                                                      |

### M4 acceptance checklist

- [x] **Payment records stay consistent when events are duplicated, delayed, reordered, or missing.** Integration (`packages/auth/test/m4.int.test.ts`, 19 tests): forged signature → 400, nothing stored; the same event 3× → one payment, membership ACTIVE; part then remainder delivered out of order → invoice PAID; webhook never delivered → reconciliation records it, re-running changes nothing; overpayment → member credit; gym B's endpoint can't settle gym A's link.
- [x] **Members buy, renew and pay balances online; staff send links and record manual payments; part payments allocate correctly.** Integration "member buys a plan in the app"; e2e `m4-payments.spec.ts` (desktop + phone): member pays balance → test checkout → "Confirming payment…" → "Payment received"; staff send a part-payment link, ₹500 paid, re-check shows "partially paid", dues show ₹1,000 left.
- [x] **Refunds (online + manual) produce credit notes and correct membership state.** Integration: online refund above the threshold waits for a second person, credit note issued, provider refund settled by webhook once; manual refund needs a method and can't exceed what's left; the refund form shows what's still refundable.
- [ ] **SaaS lifecycle end to end with verified webhooks; SaaS and gym billing share no tables.** Proven with the fake provider: checkout → charged → ACTIVE with invoice `SAAS/26-27/00001`, duplicates → one payment; fail → PAST_DUE → halt → GRACE → SUSPENDED with one email per stage → paid again → ACTIVE; `gym_platform` denied on `app`; supplier GSTIN → CGST/SGST split; banners e2e; cross-app e2e `m4-subscribe.spec.ts` (gym app → admin test checkout → worker → ACTIVE + SaaS bill) passed on desktop and phone. **Left open until checked with real Razorpay test subscriptions** (plan change via PATCH especially).
- [ ] **Staging on AWS with a restore drill, monitoring and runbooks.** Runbooks and staging files written; **no AWS resources created, no restore drill**. Needs AWS access and approval (about USD 70–90 a month).
- [x] **Pilot-gym checklist** — below.
- [ ] **All checks pass; status doc updated; mocked features listed.** All local checks pass (below). Mocked / not live: Razorpay (both accounts), SES, error tracking. CI not yet run on GitHub. Open until staging and live Razorpay are done.

### Pilot-gym checklist (what the gym provides)

1. A Razorpay account in the gym's name with KYC done: test keys first, then live key id + secret, and a webhook secret. They add the webhook URL shown in Settings → Online payments, with the `payment_link.*`, `payment.*` and `refund.*` events.
2. GSTIN (if registered), legal name, state, address; whether prices include GST; invoice prefix.
3. Membership plans: name, price, duration, joining fee, GST rate/SAC, which can be bought in the app, refund rule.
4. Member import file (template on Members → Import / export): name, phone, email, plan, start/end dates, dues.
5. Staff list with roles and branches; the owner's email for the invite.
6. Policies: online part payments (minimum), link expiry, refund approval threshold, reminder days, check-in rules.
7. Their privacy contact, and any wording their lawyer wants in the member privacy notice.
8. Operator side (us): platform Razorpay account, supplier GSTIN, SAC and rate confirmed by the CA, prices per cycle.

### Tests executed (M4, 2026-11-05, Windows 11, Docker Desktop)

| Command                                     | Result                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                         | All files formatted                                                                                                                                             |
| `pnpm lint`                                 | 11/11 tasks, 0 warnings                                                                                                                                         |
| `pnpm typecheck`                            | 11/11 tasks                                                                                                                                                     |
| `pnpm test`                                 | core 191 (+17: payment rules, announcement audience, signed internal requests), auth 27, integrations 12 (+8 payment adapter), ui 12, db 4, worker 2 — all pass |
| `pnpm test:int`                             | db 7, auth 94 (M4: 19), worker 5 — all pass                                                                                                                     |
| `pnpm build`                                | web, admin, worker build                                                                                                                                        |
| `apps/web: playwright test`                 | 44 passed (all suites, desktop + mobile) on a fresh build at :3100; `m4-subscribe.spec.ts` skips there (needs the admin app + worker)                           |
| `m4-subscribe.spec.ts` with `E2E_ADMIN_URL` | 2 passed (desktop + mobile) with web :3100, admin :3101 and the worker running                                                                                  |
| `apps/admin: playwright test`               | 7 passed (+2: billing screens and announcements; unsigned/forged requests refused)                                                                              |
| Browser check                               | Plan & billing page after subscribing at 1366 px and 390 px (screenshots reviewed); every M4 screen is checked for sideways scrolling by the e2e                |

M4 bugs found by these runs and fixed:

- Resolving a reconciliation item and retrying a job threw a raw validation error instead of the app's error (now `parseInput`).
- No catch-up for platform webhooks that were stored but not queued: the hourly billing job now replays stuck or failed ones (up to 10 tries).
- The `online_payments.enabled` plan feature existed but was never checked.
- Operators had no way to set the supplier GSTIN, grace days, SAC or GST rate for SaaS invoices: Billing → Setup now has them.

### M4 decisions (reversible)

- SaaS prices are **GST-inclusive**; without a supplier GSTIN no GST is shown. SAC 998315 and 18% are defaults to confirm with the CA. MRR includes GST until the client decides (KPI question 5).
- Owner billing uses the existing `subscription.manage` key (the milestone says `billing.manage`, which here is a gym-billing key).
- Razorpay plans are created automatically at the first checkout for a price (instead of operators typing plan ids); changing a price clears it.
- The gym app never holds the platform's Razorpay keys: it asks the admin app over HMAC-signed requests (`PLATFORM_INTERNAL_SECRET`, 5-minute window).
- Refunds pay out only the member's free credit after the credit note.
- Staff payment links also return payers to `/m/pay/return` (members see "Confirming payment…"; others land on the member sign-in).
- The privacy notice blocks the member app until accepted (except the payment-confirmation page). The wording is a plain-language draft for the gym's lawyer to review.
- Owner/accountant notification recipients (reconciliation, deletion requests) are chosen by role — recipient choice, not access control.
- Announcement times in the console are India time.
- E2E fixtures may set a **test** platform payment account in the dev database; they never replace a real one.

## M3 — Floor operations: QR check-in, classes & bookings, staff & trainers (done, 2026-11-05)

Baseline before M3: `pnpm typecheck` 11/11, `pnpm test` all pass (core 143, auth 24, ui 12, db 4, integrations 4, worker 2).

| Slice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | State | Where                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0. Permissions: `attendance.scan` (replaces `attendance.checkin`), `attendance.override`, `attendance.correct`, `classes.attendance`, `clients.view`, `trainers.assign`, `pt.manage`, `pt.own`, `staff.compensation.view`. Trainers no longer get `members.view` or `bookings.manage` (assigned clients only)                                                                                                                                                                                                                                                                            | Done  | `packages/core/src/authz/permissions.ts`, `packages/auth/src/permissions.ts`, `docs/PERMISSIONS.md`                                 |
| 1. Data model: 18 tenant tables + RLS; partial unique indexes (each QR `(passId, timeStep)` accepted once, one active pass, one live booking per member, one waiting entry, one current trainer assignment, ledger idempotency); CHECKs (`booked_count <= capacity`, times, ranges); attendance rows immutable except time/void (trigger); history never deleted by the app role                                                                                                                                                                                                         | Done  | migrations `20261104184129_m3_floor_operations`, `20261104184500_m3_rls_and_guards`; `docs/DATABASE_DESIGN.md` "M3 entities"        |
| 2. Envelope encryption (`DATA_ENCRYPTION_KEY`, optional `_PREVIOUS` for rotation); pass-code HMAC shared by PWA and server (Web Crypto); pure rules for eligibility, streaks, weekly RRULE subset, booking windows, waitlist order, availability, conflicts, credit ledger                                                                                                                                                                                                                                                                                                               | Done  | `packages/core/src/{crypto,attendance,classes,credits}`                                                                             |
| 3. Check-in (D-09): pass issue (lazy on first card open) / reissue / revoke; card data; `validateScan` (parse → pass → constant-time HMAC → ±1 step → already used → pass active → member → membership incl. branch scope, access hours, grace → duplicate window → dues warn/block → Redis `SET NX` + DB unique insert); every scan recorded; manual check-in with reason and `attendance.override`; check-out (per branch); corrections (void / re-time) audited; lists, live count; member history + streak; named scan devices; `AccessDevice` interface only                        | Done  | `packages/core/src/attendance`                                                                                                      |
| 4. Classes: categories, rooms, recurring templates (materialized 8 weeks ahead; changes never touch booked sessions — flagged instead), one-off sessions, conflict detection (trainer, room, availability), calendar, roster, cancel session (credits back, members told)                                                                                                                                                                                                                                                                                                                | Done  | `packages/core/src/classes/service.ts`                                                                                              |
| 5. Booking: seat by one conditional UPDATE; credits per membership (plan `classCredits`: number, unlimited, or 0 = no classes); waitlist with auto-promotion in the cancelling transaction (stops at the cutoff); late cancel keeps the credit (setting); attendance marking; QR check-in auto-marks booked classes starting within 2 h (setting); end-of-class job → NO_SHOW; reminders                                                                                                                                                                                                 | Done  | `packages/core/src/classes/booking.ts`                                                                                              |
| 6. Staff & trainers: staff profile (pay fields only with `staff.compensation.view`, audited without amounts), trainer profile, certifications (private upload), weekly hours + leave/extra hours, trainer ↔ member assignments with history, trainer "My day" (assigned clients, no payments), staff activity log                                                                                                                                                                                                                                                                        | Done  | `packages/core/src/staff/{profiles,availability,assignments}.ts`                                                                    |
| 7. PT packages: catalogue, sale through M2 invoicing (`PT_PACKAGE` line, SAC/tax from the package), activation by the same payment hook as memberships, session ledger, appointments (package active/valid, sessions left, trainer conflicts and hours), complete / no-show (policy) / cancel (late = no-show), expiry job                                                                                                                                                                                                                                                               | Done  | `packages/core/src/staff/{pt,pt-activation}.ts`                                                                                     |
| 8. Worker: `platform.floor-scan` every 15 min → per-tenant `classes.tick` (close ended classes, reminders); `classes.daily` from the hourly daily scan (extend schedules, expire PT)                                                                                                                                                                                                                                                                                                                                                                                                     | Done  | `apps/worker/src/processors/m3.ts`                                                                                                  |
| 9. Staff UI: Scan (camera via BarcodeDetector, jsQR fallback, USB/Bluetooth wedge input, branch + named scanner, result with photo, dues badge, manual check-in + override), Check-ins (filters, live count, corrections), Classes (week/day calendar, recurring, one-off, session detail: roster, attendance, book member, waitlist, edit, cancel; rooms & categories), Personal training (sessions, packages), My day (trainer), staff profile page, member page tabs "Check-ins" (history, pass) and "Training" (trainers, PT sell/book), photo upload, Settings → Check-in & classes | Done  | `apps/web/app/(staff)/(app)/{scan,attendance,classes,pt,my-day,staff/[userId],settings/floor}`, `members/[id]/m3-sections.tsx`      |
| 10. Member PWA: Card (rotating QR, 30 s countdown, brightness hint, screen wake lock, offline from IndexedDB, "last synced" after 24 h, wiped on sign-out / revoke / other account), Check-ins + streak, Classes (book, cancel, waitlist), Personal training; tab bar Home · Card · Classes · Payments · Profile; service worker caches the card page shell and build assets (never the card data)                                                                                                                                                                                       | Done  | `apps/web/app/(member)/m/(app)/{card,check-ins,classes,pt}`, `apps/web/lib/card-store.ts`, `apps/web/public/m/sw.js`, `/api/m/card` |
| 11. Tests, demo seed, docs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Done  | See checklist and "Tests executed"                                                                                                  |

### M3 acceptance checklist

- [x] **Check-in works with the member offline and the staff device online; replayed/expired/foreign codes are rejected with clear messages.** The code is computed on the phone from the IndexedDB copy (no network needed); the service worker serves the cached card page offline. Integration: same code twice → `CODE_ALREADY_USED`; a code from 2 steps ago → `CODE_EXPIRED` (1 step of drift accepted); forged MAC → `INVALID_CODE`; revoked pass → `PASS_REVOKED`, reissued pass works; gym B staff scanning gym A's code → `INVALID_CODE` and the code stays unused in gym A; 6 parallel replays with Redis bypassed → exactly 1 accepted (DB unique index). E2E `m3-floor.spec.ts`: card → scan → "Checked in" → same code → "already been used" → member history shows it. _Offline was checked by design and code path (service worker + IndexedDB); not automated as an airplane-mode browser test._
- [x] **Manual check-in and corrections are permission-gated and audited.** Integration: reason required; receptionist refused → can't override (FORBIDDEN); manager override accepted, recorded `overridden` with their user id, audit `attendance.override`; receptionist can't correct; manager voids with reason (audited); DB trigger refuses rewriting the record and the app role can't delete it.
- [x] **No overbooking under concurrency (test proves it); waitlist promotion correct.** Integration: 20 parallel bookings for the last seat → exactly 1 succeeds, 19 "This class is full.", `booked_count` 1, DB CHECK refuses 2; two simultaneous cancellations with 3 waiting → positions 1 and 2 promoted, 3 still waiting, notifications sent. E2E: full class → waitlist → cancellation promotes.
- [x] **Staff, trainer, availability, PT package sale → appointment → completion work end to end.** Integration "PT package: sale → invoice → payment activates → book → conflict checks → complete" (leave day, outside hours and trainer-in-a-class all refused; trainer books and completes own client's session; late cancel = no-show; package exhausted); pay hidden without `staff.compensation.view`. UI: staff page, My day, member Training tab (screens checked at both widths).
- [x] **PWA card installable and usable on a 390 px screen; scanner works on a phone camera.** Manifest/service worker smoke tests pass; `m3-screens.spec.ts` renders every new member and staff screen at 1366 px and 390 px with no sideways scrolling (screenshots reviewed). The scanner uses the rear camera (`facingMode: environment`) with BarcodeDetector or jsQR; _camera decoding was not tested on a physical phone in this session_ — the e2e feeds the decoded value through the scanner-input box, as the milestone allows.
- [x] **All checks pass; status doc updated (hardware access control not implemented).** See "Tests executed". Turnstiles/biometrics: only the `AccessDevice` interface (`packages/core/src/attendance/access-device.ts`).

### M3 decisions (reversible)

- "Already used" is checked before the duplicate-window rule, so a replayed screenshot says _already used_ rather than _already checked in_. Both refuse.
- A pass is issued the first time the member opens the card (covers existing members); a pass revoked by staff is **not** reissued automatically.
- Forged codes are recorded without a member id (not attributed to the pass owner).
- Plan `classCredits`: 0 (the M2 default when left empty) means the plan includes **no** classes; `unlimited` means no limit. The demo "Monthly Unlimited" plan was set to unlimited. Plan form hint updated.
- Trainer availability not set up at all = no availability warning (doesn't block).
- QR check-in auto-marks booked classes at that branch starting within 2 hours or in progress (not the whole day).
- Late PT cancellation (inside `ptCancelCutoffHours`, default 12) counts as a no-show; no-shows use a session by default.
- A class's own trainer may open and mark it even at another branch.
- Template edits apply to unbooked sessions only; booked ones keep their details with a note to check (spec: "flag conflicts instead").
- Member photos are staff-uploaded (2 MB, private bucket, 60 s links); members can't upload their own yet.

## M2 — Members, memberships, invoices and manual payments (done, 2026-11-04)

| Slice                                                                                                                                                                                                                                                                                                                   | State | Where                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| 1. Data model + migrations (24 tenant tables, RLS, append-only grants, immutability triggers, CHECKs, outbox claim, join lookup)                                                                                                                                                                                        | Done  | `packages/db/prisma/migrations/20261104074333_*`, `…074408_*`, `…075414_*`; `docs/DATABASE_DESIGN.md` "M2 entities" |
| 2. Pure engines: GST tax, numbering + amount in words, allocation, membership state machine, freeze, coupons, local dates                                                                                                                                                                                               | Done  | `packages/core/src/billing/{tax,numbering,allocation}.ts`, `memberships/rules.ts`, `time/dates.ts`                  |
| 3. Core services: members, duplicates, consents, notes, documents, bulk, CSV import/export, app invite, join link, plans + versions, coupons, sell/renew/extend/freeze/unfreeze/cancel, daily job, invoices, payments, credit, credit notes, voids, manual refunds, notifications, KPIs, member self-service            | Done  | `packages/core/src/{members,plans,memberships,billing,notifications,metrics}`                                       |
| 4. Worker: outbox relay (5 s), email delivery, hourly per-tenant daily scan → membership expiry + expiry reminders, CSV import/export jobs                                                                                                                                                                              | Done  | `apps/worker/src/processors/m2.ts`                                                                                  |
| 5. Staff UI: members (list, filters, bulk, profile tabs, notes, documents, consents, app invite, join approvals, import/export), plans, coupons, sell with invoice preview, record payment with allocation, invoices + PDF, payments, credit notes, voids, refunds, billing settings, notifications bell, KPI dashboard | Done  | `apps/web/app/(staff)/(app)/{members,plans,invoices,payments,notifications,settings/billing}`, `page.tsx`           |
| 6. Member PWA: sign-in, gym picker, no-gym page, home (membership, days left, renewal, dues, credit), payments + invoice detail + PDF, profile (phone, emergency contact, password), marketing consent, `/join/{slug}`; member-only accounts are sent from the staff app to `/m/`                                       | Done  | `apps/web/app/(member)/m/*`, `apps/web/app/(member)/join/[slug]`, `apps/web/lib/member-session.ts`                  |
| 7. Tests, demo seed, docs                                                                                                                                                                                                                                                                                               | Done  | See "M2 acceptance checklist" and "Tests executed"                                                                  |

### M2 acceptance checklist

- [x] **Member → membership → invoice → partial + full manual payment → active, database-backed and audited.** E2E `apps/web/e2e/m2-members.spec.ts`: plan → member → sell with ₹400 cash → app invite → member signs up and sees "₹600.00 due" / "Waiting for payment" → staff records ₹600 UPI → member sees Active and a paid invoice → PDF downloads for the member and staff (401 when signed out) → dashboard shows 1 active, ₹1,000 collected, ₹0 outstanding. Integration: "activates only on full payment, atomically, with GST split and audit".
- [x] **GST-registered and unregistered tenants produce correct documents; numbers gap-free under concurrency.** Tax invoice for ₹1,680 incl. 18% GST = taxable ₹1,423.73 + CGST ₹128.14 + SGST ₹128.13 (`AL/26-27/00001`); unregistered gym issues a Bill with no tax lines; 12 parallel issuances give 1..12 with no gaps; a rolled-back issuance releases its number; DB trigger refuses edits to an issued invoice. Tax engine matrix in unit tests.
- [x] **Overpayment creates credit, and credit applies to the next invoice.** Integration "overpayment becomes credit, which pays the next invoice automatically" (renewal starts 2026-12-03).
- [x] **Expiry job across timezones.** Integration "expires by each tenant's local date (IST vs New York)" at 02:00 UTC; idempotent on re-run.
- [x] **Member PWA sign-in; a member sees only their own data in each gym.** E2E above; integration "a member sees only their own invoices" (other member's invoice → NOT_FOUND, no context in a gym where they aren't a member), "accepting links the account to the member profile with a MEMBER role only", join link with and without approval.
- [x] **Dashboard numbers match KPI definitions on seed data (test asserts the values).** `packages/auth/scripts/demo-members.ts` is what `pnpm db:seed` runs; integration "match KPI_DEFINITIONS for the seeded gym" asserts active 2, new 1, expiring 1, invoiced ₹8,000, collected ₹3,000, outstanding ₹5,000 (plus a fresh-gym KPI test).
- [x] **All checks pass; `DATABASE_DESIGN.md`, `PERMISSIONS.md`, status doc updated; open GST questions listed** (below).

### Open GST questions for the client's CA

1. **SAC code**: we default to **999723** (physical well-being services: health clubs and fitness centres). Is that right for every plan type (PT packages, classes, add-ons)?
2. **Rate**: default **18%** (9% CGST + 9% SGST). Any plans at another rate?
3. **Place of supply**: default is the **branch's state** (service performed at the gym), so it's always CGST + SGST. Settings allow "member's state" (IGST when different). Which rule should we use?
4. **Invoice format**: numbers are `PREFIX/YY-YY/00001` (≤ 16 characters, one series per GSTIN per financial year, gap-free, voided numbers kept). Receipts use a separate `RC/…` series and credit notes `CN/…`. Is that acceptable, and is a separate receipt document needed at all?
5. **Credit notes**: cancellations and refunds always issue a credit note against the original invoice (issued invoices never change). Is a credit note right for a pro-rata refund, or should a refund voucher be used?
6. **Unregistered gyms**: we issue a "Bill" without tax lines. Is "Bill of Supply" the right title, or should it simply say "Receipt"?
7. **Joining fee**: taxed at the plan's rate on the same invoice. Correct?
8. **Rounding**: tax is rounded half-up per line; the inclusive SGST takes the remainder so CGST + SGST + taxable = price exactly. OK for returns?

### KPI open questions (from `KPI_DEFINITIONS.md`, still open)

Grace period default (we use the plan's grace days, default 0 for access; churn not computed yet); freezes extend the end date (implemented as the proposed default); manual vs QR check-ins (M3); lead-conversion window (M5).

M2 decisions (reversible, see Assumptions):

- Member `status` is the record lifecycle only (`PENDING_APPROVAL`, `ACTIVE`, `ARCHIVED`); membership state is derived from memberships (not stored twice). The milestone's proposed PROSPECT/INACTIVE are covered by "no membership" / "expired" filters.
- Enum named `MembershipState` (M1 already uses `MembershipStatus` for tenant memberships).
- A 1-month plan from 31 Jan ends on the last day of February (never loses days); otherwise start + 1 month − 1 day.
- Frozen days extend the end date when the freeze is booked (KPI open question 2 default); unfreezing early gives back the unused days.
- Joining fee only on a member's first non-cancelled membership.
- Invoice status from balances: PAID when settled; credit notes on unpaid invoices → VOID (cancelled); on paid invoices → REFUNDED / PARTIALLY_REFUNDED, the excess moves to member credit; manual refunds are paid out of credit.
- Voiding a payment never deactivates memberships automatically (staff decide; recorded in the audit entry).
- Receipt numbers: separate gap-free RECEIPT series (`RC/25-26/00001`); credit notes `CN/…` per GSTIN.
- Member accounts use the same staff sign-up/verification pages (with member wording when coming from `/join/` or `/m/`); members have no second factor (D-03 makes it optional; the optional member OTP is **not built yet**).
- A member-only account that opens the staff app is redirected to `/m/`.
- Join requests are rate-limited per account (`join:account`, 5 per hour).

## Current milestone

- Milestone: **M8 — built locally against a fake AI provider** (all checks pass). Waiting on: an OpenAI-compatible provider account to run the eval (M8), KPI sign-off (v0.2), a live test WABA (M6), AWS staging and Razorpay test keys (M4). Next: M9. Nothing committed yet.

## Milestone progress

| Milestone                               | Status                | Notes                                                     |
| --------------------------------------- | --------------------- | --------------------------------------------------------- |
| M0 Foundation                           | Done                  | Gaps closed 2026-11-04 (see "M0 gap closure")             |
| M1 SaaS core                            | Done                  | All checks and e2e pass locally; CI not yet run on GitHub |
| M2 Members & memberships                | Done                  | All checks and e2e pass locally; CI not yet run on GitHub |
| M3 Floor operations                     | Done                  | All checks and e2e pass locally; CI not yet run on GitHub |
| M4 Online payments & SaaS billing (MVP) | Built, not accepted   | Staging deploy and live Razorpay pending                  |
| M5 CRM                                  | Done (locally)        | All checks and e2e pass; CI not yet run on GitHub         |
| M6 Growth automation                    | Built (fake WhatsApp) | All checks and e2e pass; live WABA and Meta app pending   |
| M7 Fitness & engagement                 | Done (locally)        | All checks and e2e pass; CI not yet run on GitHub         |
| M8 Intelligence                         | Built (fake AI)       | Live provider eval + KPI sign-off pending                 |
| M9 Extended                             | Not started           |                                                           |

## M1 acceptance checklist

- [x] **Users reach only their authorized tenant and branch data, at both layers.** `packages/auth/test/tenancy.int.test.ts`: service calls with another tenant's ids return NOT_FOUND; raw SQL as `gym_app` sees/updates/deletes nothing of another tenant; inserts tagged with another tenant fail RLS; every tenant table has RLS + a policy; branch-scoped roles can't see or invite into other branches.
- [x] **D-03 2FA rules enforced; rate limits tested.** Owner/admin always need the email OTP (e2e signup flow, unit tests for `mfaRequirement`); other staff when the tenant requires it; trusted device (30 d) only below admin. OTP expiry/attempt cap/single use: `otp.test.ts`. Redis limits and account lockout through Better Auth: `auth.int.test.ts`.
- [x] **Realms fully separate.** Different cookies (`gym.` / `gymadmin.`), secrets, tables (`app.*` / `platform.platform_*`) and DB roles. Tested: tenant cookie rejected by the platform realm (also when renamed), and vice versa; `gym_platform` denied on every `app` table; `gym_app` denied on platform accounts; e2e: platform admin can't sign in to web and gym user can't sign in to admin.
- [x] **402/403 order on a sample protected action.** "check order" integration test: entitlement missing + permission missing → `ENTITLEMENT_REQUIRED` (402); after an override → `FORBIDDEN` (403); quota → `QUOTA_EXCEEDED` (402); suspended → `SUBSCRIPTION_INACTIVE` first.
- [x] **Trial expiry job moves the tenant to the configured state and the UI reacts.** `expireDueTrials` integration test (status → setting, writes refused, idempotent); worker registers the 15-minute scheduler (checked in Redis); the web layout shows a read-only banner and hides edit controls when the subscription is suspended.
- [x] **`docs/PERMISSIONS.md` generated; `docs/DATABASE_DESIGN.md` with a Mermaid ER diagram.** `pnpm docs:permissions`; a unit test fails if the doc drifts.
- [x] **All checks + e2e pass; status doc updated.** See "Tests executed".

## M0 gap closure (2026-11-04)

| M0 item                      | What was done                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Design-system components     | Added IconButton, Switch, RadioGroup, Combobox (ARIA 1.2 pattern), DropdownMenu (menu-button pattern), Dialog and Drawer (native `<dialog>`), Toast (`ToastProvider` + `useToast`, live region), ErrorState, Breadcrumbs, MobileTabBar, ColumnVisibility. DataTable now has server-side sorting (`aria-sort`), loading skeleton rows, an error slot and column visibility. AppShell gained an `embedded` preview mode. | `packages/ui/src/components.test.tsx` (9 tests)               |
| `/ui` showcase (dev only)    | `apps/web/app/(staff)/ui` renders every component in each state (incl. form errors/success, loading/empty/error tables, dialogs, drawer, menu, toasts, app shell, tab bar). Returns 404 in production unless `UI_SHOWCASE=1`.                                                                                                                                                                                          | `apps/web/e2e/ui-showcase.spec.ts`                            |
| Accessibility check          | axe-core (WCAG 2.0/2.1 A+AA) on `/ui`, desktop and mobile: **no serious or critical violations**; dialog focus/Escape tested                                                                                                                                                                                                                                                                                           | same spec, 6 runs pass                                        |
| Standard route wrapper       | `@gym/core/http` `handleRoute()`: context → Zod input → service → `{ ok, data \| error }` with ERROR_STATUS, `X-Request-Id` (sanitised), request-scoped logger, no internal details leaked                                                                                                                                                                                                                             | `http.test.ts` (7 tests)                                      |
| Job timeouts                 | Per-queue `timeoutMs` in `apps/worker/src/processors`; slow jobs fail (and retry with backoff) and their `ctx.signal` is aborted                                                                                                                                                                                                                                                                                       | `apps/worker/test/timeout.test.ts`                            |
| Testcontainers (D-02)        | `TESTCONTAINERS=1 pnpm test:int` starts private Postgres 18 + Redis 8 containers (`@gym/testing/containers`); default still uses the Compose services                                                                                                                                                                                                                                                                  | db 7, auth 35, worker 4 pass in both modes                    |
| Docker images                | Rebuilt after M1: web 328 MB, admin 321 MB, worker 269 MB; all three run healthy as non-root against the local services                                                                                                                                                                                                                                                                                                | `docker build` + `docker run` health checks                   |
| Build never touches services | Pages read request headers before creating services, so `next build` makes no Redis/DB connections                                                                                                                                                                                                                                                                                                                     | built web and admin with Redis stopped: 0 connection attempts |

## Completed features (M1)

| Feature                                                                                                                                                                                                                                                                                    | Evidence                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Tenant realm auth (Better Auth 1.7.14): email + password, email verification, password reset, sign-out, session list/revoke, sign out other devices, account self-deactivation                                                                                                             | `apps/web/app/(staff)/(auth)`, `/account`; e2e signup flow                                                          |
| Google sign-in, hidden without config                                                                                                                                                                                                                                                      | `createTenantAuth` `socialProviders`; e2e "Google button hidden" — **not tested with real Google** (no credentials) |
| Email OTP second factor (both realms)                                                                                                                                                                                                                                                      | `packages/auth/src/otp.ts`; `/verify` pages; e2e for owner and platform admin                                       |
| Redis rate limits: login (IP + account lockout), sign-up, OTP send/verify, reset, verification email, invite accept                                                                                                                                                                        | `packages/auth/src/rate-limit.ts`, `shared.ts`; `auth.int.test.ts`                                                  |
| Tenant picker; active tenant/branch on the session, re-verified per request                                                                                                                                                                                                                | `resolveTenantSession`; `/select-tenant`; branch switcher in header                                                 |
| Platform realm: separate Better Auth, mandatory OTP, no self-signup, CLI for the first Super Admin                                                                                                                                                                                         | `packages/auth/src/platform`; `pnpm platform:create-admin` (tested with env vars)                                   |
| AuthContext, permission matrix (permission keys, branch vs tenant scope), `requirePermission`, nav filtered by the same set                                                                                                                                                                | `packages/core/src/authz`, `packages/auth/src/permissions.ts`; matrix snapshot test                                 |
| Tenant scoping extension + RLS on all tenant tables + registry test                                                                                                                                                                                                                        | `packages/db/src/tenant.ts`, migration `…_m1_rls_grants_functions`                                                  |
| Entitlements and quotas with Redis cache + invalidation; subscription gate (read-only when suspended)                                                                                                                                                                                      | `packages/core/src/entitlements`, `tenancy/deps.ts` `guard()`                                                       |
| Owner self-signup → gym details → first branch → trial (one transaction); approval mode → waiting screen                                                                                                                                                                                   | `createTenantForOwner`; `/onboarding`, `/pending-approval`; integration + e2e                                       |
| Platform-created tenant + owner invitation by email                                                                                                                                                                                                                                        | `createTenantByPlatform`, `platform_api.create_owner_invitation`; integration test                                  |
| Branch CRUD (archive, never delete) within `branches.max`; branch settings (address, state, timezone, GSTIN)                                                                                                                                                                               | `/branches`; integration tests                                                                                      |
| Staff invitations: invite with role + branch, resend, revoke, accept (links existing global user), deactivate/reactivate                                                                                                                                                                   | `/staff`, `/invite/[token]`; integration + e2e                                                                      |
| Settings: organisation profile, logo upload (presigned POST, type/size enforced), timezone/locale/currency, tax identity with GSTIN checksum, staff 2FA requirement, plan & usage                                                                                                          | `/settings/*`; GSTIN unit tests; logo upload checked in a real browser against MinIO                                |
| Audit log: redacted, written in the same transaction for security/financial actions; tenant viewer (owner/admin) and platform viewer, with filters                                                                                                                                         | `packages/core/src/audit`; `/audit-log` in both apps                                                                |
| Platform console: dashboard, tenant directory (search/filter), tenant detail (profile, subscription, usage, owners — no business records), approve/suspend/reactivate with reason, plan versions + feature values, per-tenant overrides with expiry, platform settings, platform audit log | `apps/admin/src/app/(console)`; e2e approve flow                                                                    |
| Support sessions: reason, ≤ 2 h, read-only snapshot via `platform_api`, logged in both audit logs, tenant sees a notice                                                                                                                                                                    | integration test "support sessions"                                                                                 |
| Trial expiry job (worker, platform DB role)                                                                                                                                                                                                                                                | `apps/worker/src/processors/expire-trials.ts`                                                                       |
| Demo seed (two gyms, every role, cross-gym user, Super Admin from env), refuses production                                                                                                                                                                                                 | `pnpm db:seed` (ran twice: idempotent)                                                                              |

## Partially implemented / deferred

- **Member optional email OTP** (M2 "optional email OTP"): not built. Members sign in with email + password; staff OTP is unchanged.
- **Document virus scan**: the hook is a **stub** (files are marked clean); needs a scanner (e.g. ClamAV or S3 malware scanning) before production.
- **Invoice PDF font**: the built-in PDF fonts can't print ₹ or non-Latin names, so the PDF shows "Rs." and replaces other characters with "?". Embedding a Unicode font (e.g. Noto Sans) is the fix.
- **Emailed invoices**: invoices are emailed as a notification with a link; attaching the PDF to the email is not built.
- **M1 emails** (verification, reset, OTP, invites) are still sent directly; M2 notifications go through the outbox.
- **Changing an existing staff member's roles**: still invite/deactivate only (M3 added staff profiles, pay, hours; not role editing).
- **Hardware access control (turnstiles, biometrics)**: not implemented (D-15); only the `AccessDevice` interface exists.
- **Camera scanning on a physical phone**: built (BarcodeDetector, jsQR fallback) but not tried on a real device in this session; e2e feeds the decoded value through the scanner-input box.
- **Offline card**: built (IndexedDB + service worker) and reasoned through; no automated airplane-mode test.
- **Member self-upload of a photo**: staff upload only.
- **Trainer feedback / performance reporting, commissions**: M7 / M8 / M9.
- **Class booking reminders by WhatsApp**: in-app + email only (WhatsApp is M6).
- **Platform console**: system health, announcements, platform payments and usage analytics arrived in M4; global integration config (WhatsApp, AI) comes with M6/M8.
- **Retention purges** (webhook events, logs) and re-encryption after a key rotation: not built.
- **Error tracking** (Sentry or similar): not wired; staging relies on CloudWatch logs + alarms.
- **M0 gaps**: closed on 2026-11-04 (see "M0 gap closure" above).
- **Layout difference from D-01** (`packages/config` split into `env`, `eslint-config`, `typescript-config`): proposed amendment D-16, awaiting confirmation.

## Tests executed (latest run, 2026-11-05, M3, Windows 11, Docker Desktop)

| Command                       | Result                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`           | All files formatted                                                                                                                                                                                                                                                                              |
| `pnpm lint`                   | 11/11 tasks, 0 warnings                                                                                                                                                                                                                                                                          |
| `pnpm typecheck`              | 11/11 tasks                                                                                                                                                                                                                                                                                      |
| `pnpm test`                   | core 174 (+31: pass-code test vectors, secret box, eligibility, streaks, recurrence, booking windows, waitlist order, availability, conflicts, credit ledger), auth 26, ui 12, db 4, integrations 4, worker 2 — all pass                                                                         |
| `pnpm test:int`               | db 7, auth 75 (M3: 19), worker 5 — all pass (Compose services)                                                                                                                                                                                                                                   |
| `pnpm build`                  | web, admin, worker build                                                                                                                                                                                                                                                                         |
| `apps/web: playwright test`   | 36 passed, 8 skipped (flow tests run on desktop only), twice, against a fresh build on :3100 (`UI_SHOWCASE=1`). New: `m3-floor.spec.ts` (2 flows), `m3-screens.spec.ts` (every M3 screen, 1366 px and 390 px, fails on sideways scrolling)                                                       |
| `apps/admin: playwright test` | 5 passed (fresh build on :3101)                                                                                                                                                                                                                                                                  |
| `pnpm db:seed`                | Added M3 demo data to Iron Temple: Yoga/HIIT categories, Studio A, Coach Vikram (trainer@irontemple.test) with hours, Morning Yoga (Mon/Wed/Fri 06:30) and HIIT Express (Tue/Thu 18:30, 2 places), PT 10 sessions sold and paid for member@irontemple.test with the coach assigned; re-run skips |

M3 bugs found by these runs and fixed:

- A pass reissued in the same instant as the revoke could make the card show the revoked pass (tie on `issued_at`); the card now always prefers the active pass.
- A trainer whose class is at another branch couldn't open or mark it; the class's own trainer may now.
- Working-hours rows on the staff page scrolled sideways on a 390 px phone (found by `m3-screens.spec.ts`).

## Tests executed (M2 run, 2026-11-04)

| Command                       | Result                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`           | All files formatted                                                                                                                                 |
| `pnpm lint`                   | 11/11 tasks, 0 warnings                                                                                                                             |
| `pnpm typecheck`              | 11/11 tasks                                                                                                                                         |
| `pnpm test`                   | core 143, auth 24, ui 12, db 4, integrations 4, worker 2 — all pass                                                                                 |
| `pnpm test:int`               | db 7, auth 56 (M2: 22), worker 5 — all pass against the Compose services (`TESTCONTAINERS=1` mode last run at M0 gap closure, not re-run for M2)    |
| `pnpm build`                  | web, admin, worker build                                                                                                                            |
| `apps/web: playwright test`   | 30 passed, 6 skipped (flow tests run on desktop only), twice in a row, against a fresh build (`E2E_BASE_URL=http://localhost:3100`)                 |
| `apps/admin: playwright test` | 5 passed (fresh build on :3101)                                                                                                                     |
| `pnpm db:seed`                | Added M2 demo data to the existing demo gyms (plans, 6 members at Iron Temple with GST invoices, 6 at Pulse incl. the cross-gym user); re-run skips |
| Worker smoke                  | Notification emails (bill, membership active, receipts) arrive in Mailpit through the outbox relay; found and fixed a relay bug (below)             |
| Browser check (M2)            | Member home, payments, invoice, profile at 390 px; dashboard and member billing tab at 1366 px and 390 px; no horizontal overflow                   |

M2 bugs found by these runs and fixed:

- **Outbox relay marked every row failed after enqueuing it** (`$queryRaw` can't read a `void` result), so each email waited for the 60 s lease and a retry. Now `$executeRaw`; `apps/worker/test/outbox.int.test.ts` fails on the old code and passes now.
- Invisible characters (NBSP, BOM) inside two regexes failed lint; written as escapes.

## Known issues

- **Client IP for rate limits** is the first `X-Forwarded-For` value: right behind Caddy (it overwrites the header), spoofable behind a proxy that appends (e.g. AWS ALB). Fix the proxy or `clientIp` before deploying that way (`docs/SECURITY.md`).
- Under heavy parallel load on this laptop, an e2e fixture transaction occasionally exceeds Prisma's 5 s limit; re-runs pass. Watch for it in CI.

- CI (`.github/workflows/ci.yml`) has not run on GitHub yet; the e2e job now starts a Mailpit service.
- Local e2e runs share one IP, so a Playwright global setup clears the dev Redis rate-limit keys (`gym:rl:*`) before each run.
- The admin console's full-page screenshots show the fixed sidebar only to the first screen height (screenshot artefact; the real page is fine). The member app's fixed tab bar does the same.
- **Restart `pnpm dev` after pulling package changes.** A long-running `next dev` started before the M2 package changes served errors on signed-in pages; a fresh build was fine. The e2e suites can target another server with `E2E_BASE_URL`, and emailed links are followed on that server.
- Your `pnpm dev` server needs a restart to pick up M3 (new packages, env var `DATA_ENCRYPTION_KEY`, migrations).
- `pg` prints "Calling client.query() when the client is already executing a query" once per process. The stack is inside Prisma 7's relation loading in interactive transactions (our code runs no parallel queries in a transaction). It becomes an error in `pg@9`; recheck before upgrading `pg` or Prisma.

## Integrations awaiting credentials or approval

| Integration                      | State                                                                      | Blocker                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Razorpay (tenant accounts)       | Built, **mock-tested only** (fake provider)                                | Needs a pilot gym's test keys                                                             |
| Razorpay (platform SaaS billing) | Built, **mock-tested only** (fake provider)                                | Needs Fonix/client test keys                                                              |
| AWS SES                          | Adapter written (`SesEmailSender`), **not tested live**; Mailpit locally   | Needs verified domain + production access                                                 |
| WhatsApp Cloud API               | Built, **mock-tested only** (fake provider); Embedded Signup behind a flag | Needs the operator's Meta app + a test WABA; Embedded Signup needs Tech Provider approval |
| AI provider                      | Not started (M8)                                                           | Needs base URL + key configured in admin                                                  |
| Google OAuth                     | Code ready, **not configured** (button hidden)                             | Needs OAuth client id/secret; redirect URI `${APP_URL}/api/auth/callback/google`          |

## Assumptions made

| Decision                                                                                                  | Reason                                                                                                                                                                                        | Reversible?     |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Email OTP second factor is our own session step (`mfa_verified_at`), not Better Auth's `twoFactor` plugin | The plugin doesn't cover OAuth sign-ins, and the requirement depends on the role in the **active tenant** (owner of gym A, member of gym B). D-03 still holds: Better Auth does primary auth. | Yes             |
| Better Auth's built-in rate limiter is off; our Redis limiter runs in Better Auth hooks                   | Needed per-account limits and a lockout; Better Auth's limiter is per IP and in memory                                                                                                        | Yes             |
| Better Auth pinned to 1.7.14                                                                              | 1.7.15 was released < 1 day earlier and pnpm's minimum-release-age guard flagged it                                                                                                           | Yes, bump later |
| Cross-schema FKs from `app.*` to `platform.tenant` (not a mirrored id)                                    | Works with the role grants (FK checks don't need SELECT); simpler                                                                                                                             | Yes             |
| The platform reaches tenant data only through `platform_api` SECURITY DEFINER functions                   | D-05 "explicit views/functions"; keeps `gym_platform` out of `app` entirely                                                                                                                   | Yes             |
| Platform jobs (trial expiry) run in the worker on the `gym_platform` connection                           | Cross-tenant job without giving `gym_app` cross-tenant rights                                                                                                                                 | Yes             |
| Usage counters (`platform.usage_counter`) maintained in the same transaction as the change                | The admin must show usage without reading tenant tables                                                                                                                                       | Yes             |
| Trial length is a platform setting, not per plan (migration drops `saas_plan.trial_days`)                 | Spec: "platform settings (… trial length)"                                                                                                                                                    | Yes             |
| On trial expiry the subscription status changes; the tenant status stays ACTIVE                           | Keeps "suspended by the platform" (tenant) separate from "not paid" (subscription)                                                                                                            | Yes             |
| Default plans `starter`/`growth`/`pro` and feature values in the migration                                | Onboarding needs a trial plan in every environment; editable in the admin                                                                                                                     | Yes             |
| Production refuses placeholder secrets only when `APP_URL` is not localhost                               | Local `next start` (e2e) runs with NODE_ENV=production                                                                                                                                        | Yes             |
| Admin app: `cacheComponents`/`partialPrefetching` turned off                                              | Every console page is per-request and auth-gated                                                                                                                                              | Yes             |
| GSTIN check digit: GSTN base-36 algorithm; state codes list in `packages/core/src/gst`                    | Standard algorithm; **client's CA should confirm** the list                                                                                                                                   | Yes             |

## Next tasks

0. M5: try the embed on a real gym website (add its address to the form's allowed sites), and ask the client about the 60-day conversion cut-off (KPI question 4).

1. **Approve and run the AWS staging setup** (`infra/staging/README.md`), then do the restore drill and record it here. Needs AWS access.
2. **Razorpay test keys** (one gym account and the platform account): run the payment link, refund and subscription flows in Razorpay test mode, including a plan change; fix anything the fake provider didn't catch.
3. Commit M1–M4, push, let CI run (both jobs), fix anything CI-only.
4. Send the GST questions (incl. SaaS SAC 998315 / 18% and record retention) to the client's CA; ask the client about MRR ex-GST (KPI question 5).
5. Re-run `pnpm db:seed` with `PAYMENTS_FAKE_ENABLED=true` to try the demo payments.
6. Try the scanner on a real phone and a USB scanner at a gym desk; try the card in airplane mode.
7. Embed a Unicode font in invoice PDFs (₹ and Indian-language names) and wire a real virus scanner for documents.
8. Optional member email OTP (M2 leftover); Google OAuth credentials and test.
9. Confirm or reject proposed amendment D-16.
