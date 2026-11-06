# KPI Definitions (draft v0.2 — needs client sign-off)

Every dashboard card, report, and AI Copilot answer must use these definitions. Each KPI is implemented once
in `packages/core/src/metrics/` and unit-tested with fixed fixtures. When a definition changes, bump the
version here and note it in the report UI footer.

**Version history.** v0.1 (M2–M7). **v0.2 (M8, 2026-11-06):** the KPI registry (`metrics/kpis.ts`,
`KPI_VERSION = "0.2"`) implements the table below for the dashboard, every report, exports and the Copilot;
changes from v0.1 are listed under "M8: the KPI registry". Client sign-off is still pending: v0.2 uses the
proposed answers to the open questions at the end (grace period 7 days, 60-day lead window).

Conventions: all periods are half-open `[start, end)` in the **tenant timezone**, converted to UTC for queries.
"Branch filter" restricts by the record's branch. Money is in paise; display divides by 100.

| KPI | Definition | Notes |
|---|---|---|
| **Active members** (point in time) | Distinct members with ≥1 membership in status `ACTIVE` (not `PAUSED`) at instant *t* | Paused members are reported separately |
| **Paused members** | Distinct members whose only current membership is `PAUSED` | |
| **New members** (period) | Members whose **first-ever** membership started in the period | Re-joins are "Reactivated", not new |
| **Reactivated members** | Members starting a membership in the period whose previous membership ended > grace period earlier | |
| **Expiring memberships** (next N days) | Memberships `ACTIVE` with `endDate` in `[today, today+N)` and no renewal already purchased | |
| **Renewal rate** (period) | Memberships that ended in the period **and** were followed by a new/renewed membership starting ≤ grace days after end ÷ memberships that ended in the period | Excludes memberships cancelled with refund |
| **Churned members** (period) | Members whose last membership ended in the period and who had no active membership by end of period + grace days | Reported only after grace window closes |
| **Invoiced revenue** (period) | Sum of invoice totals (incl. tax) for invoices **issued** in the period, minus credit notes issued in the period | "Booked" revenue |
| **Net revenue (ex-tax)** | Invoiced revenue minus GST components | For profitability |
| **Collected** (period) | Sum of successful payments (online + manual) with `paidAt` in the period, minus refunds with `refundedAt` in the period | Cash view |
| **Outstanding dues** (point in time) | Sum over open invoices of (total − allocated payments − credit notes) | Excludes `VOID` |
| **Overdue dues** | Outstanding on invoices past `dueDate` | Bucketed 0–30, 31–60, 61–90, 90+ days |
| **Collection rate** (period) | Payments allocated to invoices **due** in the period ÷ total of invoices **due** in the period | Both sides restricted to the same invoice set |
| **Member credit balance** | Sum of member credit ledger | Liability, not revenue |
| **Check-ins** (period) | Count of accepted check-in events (QR + manual), one per member per branch per day for "unique visits" | Raw count and unique-visit count both shown |
| **Avg visits per active member** | Unique visits in period ÷ average active members over period | |
| **Class occupancy** | Booked-and-attended ÷ capacity, over sessions held in period | Cancelled sessions excluded |
| **No-show rate** | Bookings not attended and not cancelled before cutoff ÷ bookings for sessions held | |
| **Lead conversion rate** (cohort) | Leads **created** in period that converted to a paid membership within 60 days ÷ leads created in period | Cohort-based; shown only after 60-day window, with "in progress" label before |
| **Trial-to-member rate** | Trials attended in period that converted within 30 days ÷ trials attended in period | |
| **Campaign-attributed members** | Paid memberships whose lead's first-touch or last-touch campaign = X (model stated in UI) | Last-touch default |
| **Trainer utilization** | Booked PT + class hours ÷ available scheduled hours | |
| **Estimated profitability** | Net revenue (ex-tax) − recorded expenses in period | Always labelled "estimate"; list included expense categories |
| **At-risk member** (rule-based) | Active member matching any enabled rule: no visit in N days; visits down ≥X% vs prior 4 weeks; expiring in N days without renewal; overdue invoice | Show which rule fired; never call it a prediction |

## M8: the KPI registry (v0.2)

Code: `packages/core/src/metrics/` — `calc.ts` (pure rules, fixture tests), `loaders.ts` (SQL), `kpis.ts`
(registry: label, definition text, unit, numerator/denominator, `explain()`), `scope.ts` (who/what/when),
`rollup.ts` (daily rollup). Reports, the dashboard, CSV/XLSX exports and every Copilot tool call the registry.

**Scope.** Every KPI takes `{ tenantId, branchIds, period, timezone }`. The tenant always comes from the
signed-in context; branches are narrowed to those where the caller holds the permission (a branch manager
asking for another branch gets 403). Money KPIs need `reports.financial` (dashboard: `billing.view`) for
**every** branch in scope, otherwise they're hidden; class and CRM KPIs are hidden on plans without the module.

**Periods.** Presets: today, yesterday, this week (Mon–today), last week, last 7/30/90 days, this month
(1st–today), last month, this year; or custom dates. Half-open `[from, to)`, at most two years.
**Comparison:** the same-length period just before. Period KPIs are compared directly; point-in-time KPIs
are not, except *Active members*, compared with the nightly snapshot on the previous period's last day.

| Key | Definition (v0.2) | Change from v0.1 |
|---|---|---|
| `members.total` | Member records in status ACTIVE (not archived, awaiting approval or anonymised), by home branch, now | New |
| `members.active` | Distinct members with an ACTIVE membership that has started, now. For a past period: the nightly snapshot on its last day (none → "not available") | Same; history added |
| `members.paused` | Distinct members whose only current membership is PAUSED | Same |
| `members.new` | First-ever activated membership started in the period (by its branch) | Same |
| `members.reactivated` | Started a membership in the period; their previous one ended more than **grace** days earlier (counted at the new membership's branch) | Grace now a setting (below) |
| `memberships.expiring` | ACTIVE, end date in `[today, today+7)`, no later membership active/paused/awaiting payment | Same |
| `memberships.renewal_rate` | Ended in the period (not cancelled) and followed by any membership starting ≤ end + 1 + **grace** days ÷ ended in the period. "In progress" until the grace window after the period closes | Grace setting; cancelled excluded |
| `members.churned` | Last membership ended in the period (counted at its branch), nothing continuing within grace. "In progress" until period end + grace | Same rule, now computed |
| `revenue.invoiced` | Invoice totals incl. GST issued in the period (not void) − credit notes issued in the period | Same |
| `revenue.net_ex_tax` | Taxable value of those invoices − taxable value of those credit notes (no GST) | Now computed |
| `revenue.collected` | Successful, not voided payments received in the period − `revenue.refunds` | **Refunds changed** (below) |
| `revenue.refunds` | Refunds with status PROCESSED and `processed_at` in the period (online + manual, at the payment's branch) + direct credit refunds recorded without a refund request (member's home branch) | **v0.1 subtracted only manual credit refunds, missing online refunds** |
| `dues.outstanding` | Open invoices: total − allocated payments − credit notes, now (void excluded) | Same |
| `dues.overdue` | Outstanding on ISSUED / PARTIALLY_PAID invoices past their due date, now; buckets 0–30, 31–60, 61–90, 90+ days overdue (due today is not overdue) | Same |
| `dues.collection_rate` | Payments allocated to invoices **due** in the period ÷ amount due on those invoices (total − credit notes); allocation capped at the invoice total | Denominator nets credit notes |
| `credit.balance` | Member credit ledger total, by home branch, now (a liability) | Same |
| `attendance.check_ins` | Accepted, not voided check-ins in the period (QR, manual, overrides) | Same |
| `attendance.unique_visits` | One per member × branch × local day (gym timezone) | Same; local day fixed (see note) |
| `attendance.avg_visits` | Unique visits ÷ average of the daily active-member snapshots in the period (today: live count). Notes when snapshots are missing | Denominator defined |
| `classes.occupancy` | Attended ÷ capacity over sessions that started in the period, have ended, and weren't cancelled | "Held" = ended, not cancelled |
| `classes.no_show_rate` | (No-shows + late cancellations) ÷ (attended + no-shows + late cancellations), same sessions; on-time cancellations count on neither side | Defined |
| `leads.new` / `leads.won` | Leads created in the period / leads that became WON (paid, activated membership) in the period | New |
| `leads.open` | Open leads now, by fixed stage category | New |
| `leads.conversion_rate` | Leads created in the period won **within 60 days of creation** ÷ leads created; in progress until 60 days after the period | **The 60-day cut-off is applied here.** The M5 lead report (`attributionReport`) still counts every win so far; both are labelled |
| `leads.trial_to_member` | Trials attended in the period whose lead was won ≤ 30 days after the trial ÷ trials attended; in progress for 30 days | Same as M5 |
| `trials.booked` | Trials scheduled to start in the period, not cancelled | New |
| `trainers.utilization` | Booked minutes (PT not cancelled + classes not cancelled, started in the period) ÷ available minutes (weekly availability + extra slots − time off, per local day), over trainer profiles that have availability; branch-specific slots only for that branch | Defined; trainers without availability are excluded (shown in the report note) |
| `members.at_risk` | Distinct members with an OPEN or ACTIONED retention flag, now (M6 rules) | Now from M6 flags |
| `referrals.joined` | Referred friends whose membership was paid/activated in the period (lead's branch) | New |

**Grace period setting.** `tenant_settings.kpi_grace_days` (default **7**, 0–90): renewal, churn and
reactivation use it. It is separate from a plan's own grace days and the streak grace (M7).

**Note on local days (M8 fix).** Timestamps are stored as UTC without a time zone. Local days are computed as
`(ts AT TIME ZONE 'UTC') AT TIME ZONE <gym tz>`. M7's visit-day query applied only the second step, which
put check-ins between 05:30 and 11:00 IST on the previous day (streaks, visit points, challenges); fixed in M8
with a regression test.

**Daily rollup (derived data).** `app.metric_daily`: per branch per local day — active and paused (nightly
snapshot of the live state), new members, check-ins, unique visits, invoiced (net of credit notes), payments,
refunds. The nightly `metrics.rollup` job snapshots yesterday and refreshes the two days before it; `pnpm
metrics:rebuild` recomputes any range (days with a nightly snapshot keep it; earlier days get active/paused
reconstructed from membership dates and freezes, flagged `reconstructed`). Reports read the rollup for
history and live tables for today and for any day the rollup doesn't have yet.

**Not yet built (M9):** estimated profitability (needs expenses), inventory. Campaign-attributed members
by first touch: the campaign report groups by the lead's current (last-touch) campaign; the M5 report keeps
the first/last-touch switch.

## CRM (M5)

Computed in `packages/core/src/crm/campaigns.ts` (`attributionReport`, `trialToMemberRate`). Reports work on
the fixed **stage categories** (NEW, CONTACTED, TRIAL_SCHEDULED, TRIAL_ATTENDED, OFFER_SENT, WON, LOST) and on
recorded facts, never on custom stage names, so renaming or adding stages can't break them.

| KPI | Definition | Notes |
|---|---|---|
| **Lead cohort** | Leads **created** in `[from, to)` (tenant timezone), optionally one branch | The report's rows are always a cohort |
| **Contacted** | Cohort leads with a first contact recorded (a logged call, email or meeting, or the first-contact task done) | |
| **Trials booked / attended** | Cohort leads with ≥1 trial not cancelled / with ≥1 trial ATTENDED | |
| **Won (joined)** | Cohort leads with status WON: a membership sold from the lead was **paid and activated** | Converting to a member record alone is not a win |
| **Lead conversion rate** (cohort) | Won ÷ cohort leads | Shown as "in progress" until 60 days after the cohort ends. **Differs from the definition above:** M5 counts every win so far, including after 60 days (no cut-off yet; decide with question 4) |
| **Trial-to-member rate** | Trials ATTENDED in `[from, to)` whose lead was won within 30 days of the trial ÷ trials attended in the period | |
| **Campaign / source attribution** | Group by the campaign (or source) of the lead's **last touch** (default; latest enquiry) or **first touch** (first enquiry), as chosen in the report | Staff corrections of a lead's source/campaign update the latest touch (and the first while there was only one enquiry). Leads with none: "No campaign"/"No source" |
| **Attributed revenue** | For won cohort leads, the sum of the converting membership's invoices (not void), incl. tax, less credit notes on them | Needs `reports.financial` |
| **Cost per member** | Campaign budget ÷ won leads in the cohort | Shown only when a budget is set; the budget isn't prorated to the period |
| **First-contact SLA breach** | An open lead still not contacted `leadFirstContactMinutes` after it arrived (setting, default 15) | Recorded once per lead; fires `lead.uncontacted_sla_breached` |

## Messaging, campaigns, retention and recovery (M6)

Computed in `packages/core/src/growth/campaign-send.ts` (`campaignStats`, `campaignAttributionTx`) and
`packages/core/src/retention/service.ts` (`retentionHitsTx`, `runRetentionTx`, `retentionDashboard`).
Everything below is **associated, not causal**: the screens say so next to the numbers.

| KPI | Definition | Notes |
|---|---|---|
| **Campaign recipients** | People matched by the audience **when the campaign started** (one per phone number; members win over leads) | A scheduled campaign takes its audience at start time, not at launch |
| **Sent / delivered / read / failed** | Recipients whose message reached that WhatsApp status (from Meta's status webhooks; statuses only move forward) | "Sent" includes delivered and read; "delivered" includes read |
| **Skipped** | Recipients not sent to, with the reason checked **at send time**: no marketing consent, opted out, daily promotional cap, template not approved, account disconnected, plan limit, cancelled | Shown grouped by reason |
| **Opted out since** | Recipients whose number was suppressed after the campaign was launched | Any opt-out, not only replies to this campaign |
| **Campaign attribution** | Among recipients whose message was SENT, within the campaign's attribution window (default 14 days) after **their** send: members who started a membership (activated), members who paid (sum of successful payments), leads who became members (won) | Each person counts once per measure. A recipient who would have renewed anyway still counts: associated, not causal |
| **At-risk member flag** | A member/lead matching an enabled retention rule (below), recorded with the rule and the numbers behind it | Computed nightly (tenant local date); one open flag per person per rule |
| — No visit | Current (ACTIVE) membership, no accepted check-in for ≥ N days (default 14); members who never visited count from their membership start | |
| — Visits dropping | Visits in the last 14 days are ≥ X% (default 50) below half the visits in the 28 days before; needs ≥ 4 visits in those 28 days | Same-length comparison (14 vs 28 ÷ 2) |
| — Expiring, not renewed | ACTIVE membership ends within N days (default 7) and no later membership is active, paused or awaiting payment | |
| — Payment overdue | An unpaid invoice (issued / partly paid, outstanding > 0) whose due date was ≥ N days ago (default 7); one flag per member (oldest invoice) | |
| — Unused class credits | ≥ N class credits left (default 3) on an ACTIVE membership that ends within 14 days | Credits not yet granted count as the plan's full allowance |
| — Trial not followed up | A lead's trial ATTENDED ≥ N days ago (default 2, at most 30), lead still OPEN, no contact logged after the trial | |
| **Flag resolved** | The rule no longer fires for that person at the nightly run | Dismissed flags don't come back while the rule keeps firing |
| **Renewals after a flag** | A membership activated within 30 days after an expiring / no-visit / visit-drop / unused-credits flag was raised | One recovery per membership (`RecoveryOutcome` unique per kind + membership) |
| **Overdue amount recovered** | Sum of successful payments by the member within 30 days after an overdue flag | Counted once per flag |
| **Reactivated members** | A no-visit / visit-drop flag followed by an accepted check-in within 30 days | Once per flag |
| **Conversions after a flag or automation** | A lead won within 30 days after a trial follow-up flag, or after an automation ran for that lead | |
| **Recovered after an automation** | Renewals within 30 days after an automation execution started for that member; lead wins after an automation ran for that lead | Recorded nightly from the last 3 days; a renewal already credited to a flag gets the execution added, never counted twice |

The dashboard shows the last 30 days of recoveries by when they happened, and how many flags raised in
those 30 days ended with a recovery.

## Streaks, milestones, rewards and fitness (M7)

Computed in `packages/core/src/engagement/rules.ts` (pure, unit-tested) and `engagement/hooks.ts`. Designed so
nothing rewards overtraining: a visit counts once a day, streaks count weeks (not days in a row), and visit
points stop after a weekly cap so rest days cost nothing.

| KPI / rule | Definition | Notes |
|---|---|---|
| **Visit day** | A local date (gym timezone) with at least one accepted, not voided check-in | Two check-ins the same day = one visit day |
| **Week** | Monday–Sunday in the gym's timezone | |
| **Counting week** | A week with ≥ N visit days (setting `streak_visits_per_week`, default 2) | |
| **Weekly streak** | Consecutive counting weeks up to last week, plus the current week once it counts. The current, unfinished week never breaks it | Shown as "N wk"; longest streak kept |
| **Paused membership** | A week with 4+ frozen days (membership freeze) is skipped: neither counts nor breaks the streak. Frozen today → status "frozen" | |
| **Expired membership** | Nothing current: the streak is frozen for `streak_grace_days` (default 14) after the last membership's end date, then resets to 0 | Renewing within the grace period keeps it |
| **Visit points** | `VISIT` rule points (default 10) once per visit day, only for the first `reward_visit_weekly_cap` visit days of the week (default 5) | Day 6 and 7 of a week earn nothing: no incentive to skip rest days |
| **Workout points** | `WORKOUT_COMPLETED` points (default 5) once per day with a completed workout | A second workout the same day earns nothing |
| **Milestones** | Visit days 10/25/50/100, completed workouts 1/10/50, personal records 1/10, longest streak 4/12 weeks, challenges completed 1. Each earned once, with its own points | Gym can change points or switch each off |
| **Challenge progress** | Distinct visit days (or days with a completed workout) between start and end date. Completed when progress ≥ target; points once | Attendance/workout only; never body weight. Leaderboard shows the member's chosen name, opt-out per member |
| **Referral reward** | `REFERRAL_CONVERTED` points (default 500) to the referrer once, when the referred lead's membership is paid and activated (`lead.converted`) | Self-referral rejected; one referrer per lead (first link wins) |
| **Points balance** | Sum of the member's ledger (earn +, redeem −, refused perk returned +, staff adjustments ±) | Never negative |
| **Points → credit** | points × `reward_point_value_minor` paise (default 50 = ₹0.50/point), min `reward_min_redeem_points` (default 200). Becomes member credit (kind REWARD) and is auto-applied to open invoices when that setting is on | Atomic with the ledger entry |
| **Personal record** | A completed workout's set that beats the member's best for that exercise and kind: heaviest weight (reps ≥ 1), estimated 1-rep max (Epley, sets of 1–12 reps, shown as an estimate), most reps (bodyweight), longest time, farthest distance | Strictly greater; first ever counts; detected when the workout is finished |
| **Nutrition estimate** | Library value per 100 g × portion grams, rounded to 0.1 (kcal, protein, carbs, fat). Source and assumptions stored with every entry; member corrections marked "edited" | Always labelled "estimate" |
| **Weekly nutrition summary** | Averages over days with any food or water log this week (unlogged days aren't zeros), and % of the diet plan's targets | |

## Platform KPIs (operator console, M4)

Computed in `packages/core/src/saas-billing/service.ts` (`billingOverview`, `monthlyEquivalent`) from `platform` tables only.

| KPI | Definition | Notes |
|---|---|---|
| **MRR** (point in time) | Sum over subscriptions in `ACTIVE`, `PAST_DUE` or `GRACE` **with a provider subscription** of the monthly equivalent of their current price: monthly = price, every 6 months = price ÷ 6, yearly = price ÷ 12 (rounded to the paisa) | Trials, comps (free access, no provider subscription), suspended and cancelled are excluded. Prices are **GST-inclusive**, so MRR includes GST (see question 5) |
| **ARR** | MRR × 12 | |
| **Paying gyms** | Subscriptions in `ACTIVE` | `PAST_DUE`/`GRACE`/`SUSPENDED` shown together as "payment problems" |
| **Trials ending** | `TRIALING` subscriptions whose trial ends within 7 days | |

Open questions for the client:
1. Grace period default for renewal/churn (proposed 7 days)? — *v0.2 uses 7, editable per gym (`kpi_grace_days`).*
2. Should a frozen/paused period extend the membership end date automatically? (proposed yes)
3. Does a manual staff check-in count the same as a QR check-in for streaks and KPIs? (proposed yes) — *M3 implements the proposal: accepted QR and manual check-ins (including overrides) count; refused scans and check-ins removed by a correction don't. Check-outs never count. The Check-ins page shows the raw count and distinct members per day.*
4. Lead-conversion window — 60 days acceptable? — *v0.2 applies 60 days in the registry (dashboard, reports, Copilot).*
6. (M8) Collection rate: is "amount due" the invoice total less credit notes (v0.2), or the original total?
7. (M8) Should members with only a paused membership count in "Visits per active member"'s denominator? v0.2: no.
5. Should MRR/ARR be reported excluding GST (taxable value only)? M4 reports the GST-inclusive price.
