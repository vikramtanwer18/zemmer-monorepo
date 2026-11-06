import type { TenantTransaction } from "@gym/db";
import { addDays, diffDays } from "../time/dates";
import * as calc from "./calc";
import * as load from "./loaders";
import type { KpiScope } from "./scope";

/**
 * The KPI registry: every KPI in docs/KPI_DEFINITIONS.md, implemented once. Dashboard cards,
 * reports, exports and the AI Copilot all read figures from here, so they always agree.
 * Bump KPI_VERSION (and the doc) whenever a definition changes; the UI footer shows it.
 */
export const KPI_VERSION = "0.2";

export type KpiUnit = "count" | "money" | "ratio" | "number";

export type KpiValue = {
  value: number | null;
  numerator?: number;
  denominator?: number;
  /** The window this figure depends on hasn't closed yet (churn, cohort conversion). */
  inProgress?: boolean;
  /** Extra figures behind the value (aging buckets, raw vs unique...). */
  detail?: Record<string, number>;
  note?: string;
};

export type KpiSettings = {
  /** Renewal/churn/reactivation grace (tenant setting `kpi_grace_days`, default 7). */
  graceDays: number;
  /** "Expiring" window in days (default 7). */
  expiringDays: number;
  /** Lead-conversion cohort window (default 60). */
  leadWindowDays: number;
};

export const DEFAULT_KPI_SETTINGS: KpiSettings = {
  graceDays: 7,
  expiringDays: 7,
  leadWindowDays: 60,
};

export type KpiEnv = {
  tx: TenantTransaction;
  scope: KpiScope;
  settings: KpiSettings;
  now: Date;
};

export type KpiDefinition = {
  label: string;
  unit: KpiUnit;
  /** "point" = measured now (the period only matters for the comparison); "period" = over [from, to). */
  kind: "point" | "period";
  /** Money figures need reports.financial (dashboard: billing.view). */
  financial: boolean;
  /** Module the figure belongs to (plan entitlement), if any. */
  module?: "classes" | "crm" | "pt";
  definition: string;
  numerator?: string;
  denominator?: string;
  /** For the comparison arrow colour. null = neutral. */
  higherIsBetter: boolean | null;
  compute(env: KpiEnv): Promise<KpiValue>;
};

const value = (v: number): KpiValue => ({ value: v });
const ratioOf = (
  numerator: number,
  denominator: number,
  extra: Partial<KpiValue> = {},
): KpiValue => ({
  value: calc.ratio(numerator, denominator),
  numerator,
  denominator,
  ...extra,
});

export const KPIS = {
  "members.total": {
    label: "Total members",
    unit: "count",
    kind: "point",
    financial: false,
    definition:
      "Member records that are active (not archived, awaiting approval or anonymised), with or without a current membership, by home branch, now.",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      return value(await load.totalMembers(tx, scope));
    },
  },
  "members.active": {
    label: "Active members",
    unit: "count",
    kind: "point",
    financial: false,
    definition:
      "Distinct members with at least one ACTIVE (not paused) membership that has started, today.",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      if (scope.period.to <= scope.today) {
        // A past period: the snapshot taken at its last day (nightly rollup), if there is one.
        const v = await load.activeOnDay(
          tx,
          scope,
          addDays(scope.period.to, -1),
        );
        return v === null
          ? { value: null, note: "No snapshot for that day." }
          : value(v);
      }
      return value(await load.activeMembersNow(tx, scope));
    },
  },
  "members.paused": {
    label: "Paused members",
    unit: "count",
    kind: "point",
    financial: false,
    definition: "Distinct members whose only current membership is PAUSED.",
    higherIsBetter: null,
    async compute({ tx, scope }) {
      return value(await load.pausedMembersNow(tx, scope));
    },
  },
  "members.new": {
    label: "New members",
    unit: "count",
    kind: "period",
    financial: false,
    definition:
      "Members whose first-ever membership started in the period. Re-joins count as reactivated, not new.",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      return value((await load.newMemberIds(tx, scope)).length);
    },
  },
  "members.reactivated": {
    label: "Reactivated members",
    unit: "count",
    kind: "period",
    financial: false,
    definition:
      "Members who started a membership in the period after their previous one had ended more than the grace period earlier.",
    higherIsBetter: true,
    async compute({ tx, scope, settings }) {
      const rows = await load.membershipHistory(tx, scope, settings.graceDays);
      return value(
        calc.reactivatedMembers(
          rows,
          scope.period,
          settings.graceDays,
          inBranches(scope),
        ).length,
      );
    },
  },
  "memberships.expiring": {
    label: "Expiring soon",
    unit: "count",
    kind: "point",
    financial: false,
    definition:
      "ACTIVE memberships whose end date is within the next N days (default 7) with no renewal already bought.",
    higherIsBetter: null,
    async compute({ tx, scope, settings }) {
      return {
        value: await load.expiringCount(tx, scope, settings.expiringDays),
        detail: { days: settings.expiringDays },
      };
    },
  },
  "memberships.renewal_rate": {
    label: "Renewal rate",
    unit: "ratio",
    kind: "period",
    financial: false,
    definition:
      "Memberships that ended in the period and were followed by another membership starting within the grace period after the end ÷ memberships that ended in the period. Cancelled memberships are excluded.",
    numerator: "Renewed within the grace period",
    denominator: "Memberships that ended",
    higherIsBetter: true,
    async compute({ tx, scope, settings }) {
      const rows = await load.membershipHistory(tx, scope, settings.graceDays);
      const r = calc.renewalOutcome(
        rows,
        scope.period,
        settings.graceDays,
        inBranches(scope),
      );
      const open = addDays(scope.period.to, settings.graceDays) > scope.today;
      return ratioOf(r.numerator, r.denominator, { inProgress: open });
    },
  },
  "members.churned": {
    label: "Churned members",
    unit: "count",
    kind: "period",
    financial: false,
    definition:
      "Members whose last membership ended in the period and who started nothing within the grace period. Final only once the grace window after the period has closed.",
    higherIsBetter: false,
    async compute({ tx, scope, settings }) {
      const rows = await load.membershipHistory(tx, scope, settings.graceDays);
      const c = calc.churnOutcome(
        rows,
        scope.period,
        settings.graceDays,
        scope.today,
        inBranches(scope),
      );
      return { value: c.count, inProgress: c.inProgress };
    },
  },
  "revenue.invoiced": {
    label: "Invoiced",
    unit: "money",
    kind: "period",
    financial: true,
    definition:
      'Invoice totals (incl. GST) for invoices issued in the period, minus credit notes issued in the period. "Booked" revenue.',
    higherIsBetter: true,
    async compute({ tx, scope }) {
      const r = await load.invoicedMinor(tx, scope);
      return {
        value: r.net,
        detail: { invoicedMinor: r.gross, creditNotesMinor: r.credited },
      };
    },
  },
  "revenue.net_ex_tax": {
    label: "Net revenue (ex-GST)",
    unit: "money",
    kind: "period",
    financial: true,
    definition:
      "Invoiced revenue without the GST components: taxable value of invoices issued in the period minus the taxable value of credit notes issued in it.",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      return value((await load.invoicedMinor(tx, scope, "taxable_minor")).net);
    },
  },
  "revenue.collected": {
    label: "Collected",
    unit: "money",
    kind: "period",
    financial: true,
    definition:
      "Successful payments (online + manual) received in the period, minus refunds processed in the period. Cash view.",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      const payments = await load.paymentsMinor(tx, scope);
      const refunds = await load.refundsMinor(tx, scope);
      return {
        value: payments - refunds,
        detail: { paymentsMinor: payments, refundsMinor: refunds },
      };
    },
  },
  "revenue.refunds": {
    label: "Refunds",
    unit: "money",
    kind: "period",
    financial: true,
    definition:
      "Refunds processed in the period (online and manual), plus direct refunds of member credit recorded in it.",
    higherIsBetter: false,
    async compute({ tx, scope }) {
      return value(await load.refundsMinor(tx, scope));
    },
  },
  "dues.outstanding": {
    label: "Outstanding dues",
    unit: "money",
    kind: "point",
    financial: true,
    definition:
      "Sum over open invoices of (total − allocated payments − credit notes), now. Void invoices excluded.",
    higherIsBetter: false,
    async compute({ tx, scope }) {
      return value(await load.outstandingMinor(tx, scope));
    },
  },
  "dues.overdue": {
    label: "Overdue dues",
    unit: "money",
    kind: "point",
    financial: true,
    definition:
      "Outstanding on invoices past their due date, now, bucketed by days overdue: 0–30, 31–60, 61–90, 90+.",
    higherIsBetter: false,
    async compute({ tx, scope }) {
      const rows = await load.overdueInvoices(tx, scope);
      const a = calc.agingTotals(rows, scope.today);
      return {
        value: a.overdue,
        detail: {
          ...a.totals,
          invoices: rows.filter((r) => r.outstandingMinor > 0).length,
        },
      };
    },
  },
  "dues.collection_rate": {
    label: "Collection rate",
    unit: "ratio",
    kind: "period",
    financial: true,
    definition:
      "Payments allocated to invoices due in the period ÷ the amount due on those same invoices (total less credit notes). Both sides use the same invoice set.",
    numerator: "Paid on invoices due in the period",
    denominator: "Due on those invoices",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      const r = calc.collectionRate(await load.invoicesDueIn(tx, scope));
      return ratioOf(r.numerator, r.denominator);
    },
  },
  "credit.balance": {
    label: "Member credit balance",
    unit: "money",
    kind: "point",
    financial: true,
    definition:
      "Sum of the member credit ledger, now. A liability (owed to members), not revenue.",
    higherIsBetter: null,
    async compute({ tx, scope }) {
      return value(await load.creditBalanceMinor(tx, scope));
    },
  },
  "attendance.check_ins": {
    label: "Check-ins",
    unit: "count",
    kind: "period",
    financial: false,
    definition:
      "Accepted check-ins (QR and manual, including overrides) in the period. Refused scans and voided check-ins don't count.",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      const c = await load.checkIns(tx, scope);
      return {
        value: c.raw,
        detail: { uniqueVisits: c.unique, members: c.members },
      };
    },
  },
  "attendance.unique_visits": {
    label: "Unique visits",
    unit: "count",
    kind: "period",
    financial: false,
    definition:
      "Accepted check-ins counted once per member per branch per day (gym timezone).",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      return value((await load.checkIns(tx, scope)).unique);
    },
  },
  "attendance.avg_visits": {
    label: "Visits per active member",
    unit: "number",
    kind: "period",
    financial: false,
    definition:
      "Unique visits in the period ÷ the average number of active members over the period (daily snapshots).",
    numerator: "Unique visits",
    denominator: "Average active members",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      const visits = (await load.checkIns(tx, scope)).unique;
      const snap = await load.averageActiveFromRollup(tx, scope);
      const includesToday =
        scope.period.from <= scope.today && scope.today < scope.period.to;
      let avg = snap.average;
      let note: string | undefined;
      if (includesToday) {
        const now = await load.activeMembersNow(tx, scope);
        avg = avg === null ? now : (avg * snap.days + now) / (snap.days + 1);
      }
      const totalDays = diffDays(scope.period.from, scope.period.to);
      if (avg === null)
        return {
          value: null,
          numerator: visits,
          note: "No active-member snapshots for this period.",
        };
      if (snap.days + (includesToday ? 1 : 0) < totalDays)
        note = "Average active members from the days with a snapshot.";
      const denominator = Math.round(avg * 10) / 10;
      return {
        value: calc.ratio(visits, avg),
        numerator: visits,
        denominator,
        note,
      };
    },
  },
  "classes.occupancy": {
    label: "Class occupancy",
    unit: "ratio",
    kind: "period",
    financial: false,
    module: "classes",
    definition:
      "Booked-and-attended places ÷ capacity, over class sessions held in the period. Cancelled sessions are excluded.",
    numerator: "Attended",
    denominator: "Capacity of sessions held",
    higherIsBetter: true,
    async compute({ tx, scope, now }) {
      const o = calc.occupancy(await load.heldSessions(tx, scope, now));
      return ratioOf(o.numerator, o.denominator);
    },
  },
  "classes.no_show_rate": {
    label: "No-show rate",
    unit: "ratio",
    kind: "period",
    financial: false,
    module: "classes",
    definition:
      "Bookings not attended and not cancelled before the cut-off ÷ bookings still expected (attended + no-show + late cancellations), for sessions held in the period.",
    numerator: "No-shows and late cancellations",
    denominator: "Bookings expected to attend",
    higherIsBetter: false,
    async compute({ tx, scope, now }) {
      const r = calc.noShow(await load.bookingOutcomes(tx, scope, now));
      return ratioOf(r.numerator, r.denominator);
    },
  },
  "leads.new": {
    label: "New leads",
    unit: "count",
    kind: "period",
    financial: false,
    module: "crm",
    definition: "Leads created in the period.",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      return value(await load.leadsCreated(tx, scope));
    },
  },
  "leads.open": {
    label: "Open leads",
    unit: "count",
    kind: "point",
    financial: false,
    module: "crm",
    definition: "Leads still open (not won or lost) now: the sales pipeline.",
    higherIsBetter: null,
    async compute({ tx, scope }) {
      const p = await load.openLeadsByStage(tx, scope);
      return { value: Object.values(p).reduce((a, b) => a + b, 0), detail: p };
    },
  },
  "trials.booked": {
    label: "Trials booked",
    unit: "count",
    kind: "period",
    financial: false,
    module: "crm",
    definition:
      "Trial sessions scheduled to start in the period, not cancelled (attended, no-show or still to come).",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      return value(await load.trialsBooked(tx, scope));
    },
  },
  "leads.won": {
    label: "Leads won",
    unit: "count",
    kind: "period",
    financial: false,
    module: "crm",
    definition:
      "Leads whose membership was paid and activated (status WON) in the period.",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      return value(await load.leadsWon(tx, scope));
    },
  },
  "leads.conversion_rate": {
    label: "Lead conversion",
    unit: "ratio",
    kind: "period",
    financial: false,
    module: "crm",
    definition:
      "Leads created in the period that were won (paid membership) within 60 days of being created ÷ leads created in the period. Cohort-based: in progress until 60 days after the period ends.",
    numerator: "Won within 60 days",
    denominator: "Leads created",
    higherIsBetter: true,
    async compute({ tx, scope, settings }) {
      const c = await load.leadCohort(tx, scope, settings.leadWindowDays);
      return ratioOf(c.won, c.leads, {
        inProgress:
          addDays(scope.period.to, settings.leadWindowDays) > scope.today,
      });
    },
  },
  "leads.trial_to_member": {
    label: "Trial to member",
    unit: "ratio",
    kind: "period",
    financial: false,
    module: "crm",
    definition:
      "Trials attended in the period whose lead was won within 30 days of the trial ÷ trials attended in the period.",
    numerator: "Won within 30 days",
    denominator: "Trials attended",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      const t = await load.trialOutcomes(tx, scope);
      return ratioOf(t.converted, t.attended, {
        inProgress: addDays(scope.period.to, 30) > scope.today,
      });
    },
  },
  "trainers.utilization": {
    label: "Trainer utilisation",
    unit: "ratio",
    kind: "period",
    financial: false,
    definition:
      "Booked PT and class minutes ÷ available scheduled minutes (weekly availability plus extra slots, minus time off), for staff with availability set up.",
    numerator: "Booked minutes",
    denominator: "Available minutes",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      const { byTrainer, bookedBy } = await load.trainerLoad(tx, scope);
      let available = 0;
      let booked = 0;
      for (const [trainerId, t] of byTrainer) {
        available += calc.availableMinutes(t.slots, scope.period);
        booked += bookedBy.get(trainerId) ?? 0;
      }
      return ratioOf(booked, available, {
        detail: { trainers: byTrainer.size },
      });
    },
  },
  "members.at_risk": {
    label: "At-risk members",
    unit: "count",
    kind: "point",
    financial: false,
    definition:
      "Members with an open retention flag, now: a gym rule fired (no visit in N days, visits dropping, expiring without renewal, payment overdue, unused credits). Rule-based, never a prediction.",
    higherIsBetter: false,
    async compute({ tx, scope }) {
      return value(await load.atRiskMembers(tx, scope));
    },
  },
  "referrals.joined": {
    label: "Referral joins",
    unit: "count",
    kind: "period",
    financial: false,
    definition:
      "Referred friends whose membership was paid and activated in the period (referral link → lead → won).",
    higherIsBetter: true,
    async compute({ tx, scope }) {
      const r = await load.referralCounts(tx, scope);
      return { value: r.joined, detail: { referralLeads: r.created } };
    },
  },
} satisfies Record<string, KpiDefinition>;

export type KpiKey = keyof typeof KPIS;
export const KPI_KEYS = Object.keys(KPIS) as KpiKey[];
export const isKpiKey = (k: string): k is KpiKey => k in KPIS;

/** The branch filter applied to the membership being counted (renewal / churn / reactivation). */
function inBranches(scope: KpiScope): calc.InScope {
  if (!scope.branchIds) return () => true;
  const ids = new Set(scope.branchIds);
  return (m) => !m.branchId || ids.has(m.branchId);
}

/** Definition text + how the figure was built (numerator / denominator), for "explain" UIs and the Copilot. */
export function explainKpi(key: KpiKey, result?: KpiValue) {
  const def: KpiDefinition = KPIS[key];
  return {
    key,
    label: def.label,
    unit: def.unit,
    kind: def.kind,
    definition: def.definition,
    numeratorLabel: def.numerator ?? null,
    denominatorLabel: def.denominator ?? null,
    numerator: result?.numerator ?? null,
    denominator: result?.denominator ?? null,
    inProgress: result?.inProgress ?? false,
    version: KPI_VERSION,
  };
}
