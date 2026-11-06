# KPI Definitions (draft v0.1 — needs client sign-off)

Every dashboard card, report, and AI Copilot answer must use these definitions. Each KPI is implemented once
in `packages/core/src/metrics/` and unit-tested with fixed fixtures. When a definition changes, bump the
version here and note it in the report UI footer.

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

Open questions for the client:
1. Grace period default for renewal/churn (proposed 7 days)?
2. Should a frozen/paused period extend the membership end date automatically? (proposed yes)
3. Does a manual staff check-in count the same as a QR check-in for streaks and KPIs? (proposed yes)
4. Lead-conversion window — 60 days acceptable?
