import { Prisma, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "../authz";
import { AppError } from "../errors";
import {
  isFeatureEnabled,
  type BooleanFeature,
  type Entitlements,
} from "../entitlements";
import { toCsv } from "../members/csv";
import {
  computeKpisTx,
  kpiSettingsTx,
  REPORTS_AUDIENCE,
  type KpiReport,
} from "../metrics";
import { KPI_VERSION, type KpiKey, type KpiSettings } from "../metrics/kpis";
import * as load from "../metrics/loaders";
import {
  branchFilter,
  periodUtc,
  resolveScope,
  scopeInputSchema,
  type KpiScope,
} from "../metrics/scope";
import {
  entitlementsFor,
  guard,
  inTenant,
  nowOf,
  type CoreDeps,
} from "../tenancy/deps";
import { addDays, fromDbDate, toDbDate } from "../time/dates";
import { parseInput } from "../validation";
import * as t from "./tables";
import { toXlsx, XLSX_CONTENT_TYPE, type Cell } from "./xlsx";

export * from "./dashboard";
export * from "./tables";
export { toXlsx, XLSX_CONTENT_TYPE } from "./xlsx";

/**
 * Reports (M8): each one is a set of registry KPIs (with the previous period), a drill-down table
 * of the records behind them, and optionally a daily trend. Basic reports come with every plan;
 * the rest, and exports, need the `reports.advanced` entitlement (plan: "Advanced reports and exports").
 */

type Trend = "members" | "visits" | "money";

type ReportDef = {
  title: string;
  description: string;
  group: "Members" | "Money" | "Activity" | "Growth" | "Branches";
  advanced: boolean;
  /** The whole report is about money: needs reports.financial. */
  financial: boolean;
  module?: BooleanFeature;
  kpis: KpiKey[];
  trend?: Trend;
  table(env: t.TableEnv): Promise<t.ReportTable>;
};

export const REPORTS = {
  membership: {
    title: "Membership",
    description:
      "Active, paused, new and reactivated members, and memberships started in the period.",
    group: "Members",
    advanced: false,
    financial: false,
    kpis: [
      "members.active",
      "members.paused",
      "members.new",
      "members.reactivated",
      "memberships.expiring",
    ],
    trend: "members",
    table: t.membershipsStarted,
  },
  renewals: {
    title: "Renewals & churn",
    description:
      "Memberships that ended in the period: renewed within the grace period or not.",
    group: "Members",
    advanced: true,
    financial: false,
    kpis: [
      "memberships.renewal_rate",
      "members.churned",
      "members.reactivated",
      "memberships.expiring",
    ],
    table: t.renewals,
  },
  retention: {
    title: "Retention & at-risk",
    description:
      "Members flagged by the gym's retention rules, churn and win-backs.",
    group: "Members",
    advanced: true,
    financial: false,
    kpis: ["members.at_risk", "members.churned", "members.reactivated"],
    table: t.retentionFlags,
  },
  attendance: {
    title: "Attendance",
    description:
      "Check-ins and unique visits per day, and visits per active member.",
    group: "Activity",
    advanced: false,
    financial: false,
    kpis: [
      "attendance.check_ins",
      "attendance.unique_visits",
      "attendance.avg_visits",
    ],
    trend: "visits",
    table: t.attendanceByDay,
  },
  revenue: {
    title: "Revenue: invoiced vs collected",
    description:
      "Booked revenue (invoices issued) against cash collected (payments less refunds).",
    group: "Money",
    advanced: false,
    financial: true,
    kpis: [
      "revenue.invoiced",
      "revenue.net_ex_tax",
      "revenue.collected",
      "revenue.refunds",
    ],
    trend: "money",
    table: t.paymentsReceived,
  },
  dues: {
    title: "Outstanding & aging",
    description:
      "What members owe now, by how long it's been overdue, and the collection rate.",
    group: "Money",
    advanced: false,
    financial: true,
    kpis: [
      "dues.outstanding",
      "dues.overdue",
      "dues.collection_rate",
      "credit.balance",
    ],
    table: (env) => t.openInvoices(env),
  },
  refunds: {
    title: "Refunds",
    description: "Refunds processed in the period.",
    group: "Money",
    advanced: false,
    financial: true,
    kpis: ["revenue.refunds"],
    table: t.refundsList,
  },
  leads: {
    title: "Lead funnel & conversion",
    description:
      "Leads created in the period by source: contacted, trial attended, joined.",
    group: "Growth",
    advanced: true,
    financial: false,
    module: "crm.enabled",
    kpis: [
      "leads.new",
      "leads.won",
      "leads.conversion_rate",
      "leads.trial_to_member",
    ],
    table: (env) => t.leadCohortBy(env, "source"),
  },
  campaigns: {
    title: "Campaign performance",
    description: "Leads and paid memberships by campaign (last touch).",
    group: "Growth",
    advanced: true,
    financial: false,
    module: "crm.enabled",
    kpis: ["leads.new", "leads.won", "leads.conversion_rate"],
    table: (env) => t.leadCohortBy(env, "campaign"),
  },
  trials: {
    title: "Trial conversion",
    description:
      "Trials attended in the period and whether the lead joined within 30 days.",
    group: "Growth",
    advanced: true,
    financial: false,
    module: "crm.enabled",
    kpis: ["leads.trial_to_member"],
    table: t.trialsAttended,
  },
  referrals: {
    title: "Referral performance",
    description:
      "Friends who signed up through members' referral links, and who joined.",
    group: "Growth",
    advanced: true,
    financial: false,
    kpis: ["referrals.joined"],
    table: t.referralsList,
  },
  classes: {
    title: "Class utilisation",
    description: "Occupancy and no-shows for classes held in the period.",
    group: "Activity",
    advanced: true,
    financial: false,
    module: "classes.enabled",
    kpis: ["classes.occupancy", "classes.no_show_rate"],
    table: t.classSessions,
  },
  trainers: {
    title: "Trainer utilisation",
    description:
      "Booked PT and class hours against each trainer's available hours.",
    group: "Activity",
    advanced: true,
    financial: false,
    kpis: ["trainers.utilization"],
    table: t.trainerUtilization,
  },
  branches: {
    title: "Branch comparison",
    description: "The main KPIs side by side for each branch.",
    group: "Branches",
    advanced: true,
    financial: false,
    kpis: [],
    table: t.branchComparison,
  },
} satisfies Record<string, ReportDef>;

export type ReportKey = keyof typeof REPORTS;
export const REPORT_KEYS = Object.keys(REPORTS) as ReportKey[];
export const isReportKey = (k: string): k is ReportKey => k in REPORTS;

export type ReportLock = "PLAN" | "PERMISSION" | null;

function lockOf(
  ctx: AuthContext,
  ent: Entitlements,
  def: ReportDef,
): ReportLock {
  if (def.financial && !hasPermission(ctx, "reports.financial"))
    return "PERMISSION";
  if (def.advanced && !isFeatureEnabled(ent, "reports.advanced")) return "PLAN";
  if (def.module && !isFeatureEnabled(ent, def.module)) return "PLAN";
  return null;
}

/** The report catalogue for this caller, with what's locked and why. */
export async function listReports(deps: CoreDeps, ctx: AuthContext) {
  requirePermission(ctx, "reports.view");
  const ent = await entitlementsFor(deps, ctx.tenantId);
  return REPORT_KEYS.map((key) => {
    const def: ReportDef = REPORTS[key];
    return {
      key,
      title: def.title,
      description: def.description,
      group: def.group,
      advanced: def.advanced,
      lock: lockOf(ctx, ent, def),
    };
  });
}

/** Money columns only when the caller has reports.financial for every branch in the scope. */
function moneyVisible(ctx: AuthContext, scope: KpiScope) {
  const allowed = allowedBranchIds(ctx, "reports.financial");
  if (allowed === "ALL") return true;
  return (
    scope.branchIds !== null &&
    scope.branchIds.every((id) => allowed.includes(id))
  );
}

async function reportGuard(deps: CoreDeps, ctx: AuthContext, key: string) {
  if (!isReportKey(key))
    throw new AppError("NOT_FOUND", "That report doesn't exist.");
  const def: ReportDef = REPORTS[key];
  const ent = await guard(deps, ctx, {
    permission: def.financial ? "reports.financial" : "reports.view",
    entitlement: def.advanced ? "reports.advanced" : undefined,
  });
  if (def.module && !isFeatureEnabled(ent, def.module))
    throw new AppError(
      "ENTITLEMENT_REQUIRED",
      "Your plan doesn't include this report. Upgrade to use it.",
      {
        details: { feature: def.module },
      },
    );
  return { def, ent };
}

export const PAGE_SIZE = 50;
const runSchema = scopeInputSchema.extend({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
});

export type TrendPoint = {
  day: string;
  activeMembers: number | null;
  newMembers: number;
  checkIns: number;
  uniqueVisits: number;
  invoicedMinor: number;
  collectedMinor: number;
};

export type ReportResult = {
  key: ReportKey;
  title: string;
  description: string;
  version: string;
  kpis: KpiReport;
  table: t.ReportTable;
  page: number;
  pageSize: number;
  trend: TrendPoint[] | null;
  trendKind: Trend | null;
  showMoney: boolean;
  canExport: boolean;
};

/** One report for the caller's scope: KPIs vs previous period, a page of records, the trend. */
export async function runReport(
  deps: CoreDeps,
  ctx: AuthContext,
  key: string,
  raw: unknown,
): Promise<ReportResult> {
  const { def, ent } = await reportGuard(deps, ctx, key);
  const input = parseInput(runSchema, raw ?? {});
  const scope = resolveScope(
    deps,
    ctx,
    input,
    def.financial ? "reports.financial" : "reports.view",
    "this_month",
  );
  const now = nowOf(deps);
  const pageNo = input.page ?? 1;
  const showMoney = moneyVisible(ctx, scope);
  return inTenant(deps, ctx, async (tx) => {
    const settings = await kpiSettingsTx(tx, ctx.tenantId);
    const kpis = await computeKpisTx(tx, ctx, ent, scope, def.kpis, {
      audience: REPORTS_AUDIENCE,
      compare: true,
      now,
    });
    const table = await def.table({
      tx,
      scope,
      settings,
      now,
      showMoney,
      limit: PAGE_SIZE,
      offset: (pageNo - 1) * PAGE_SIZE,
    });
    const trend = def.trend ? await dailySeries(tx, scope) : null;
    return {
      key: key as ReportKey,
      title: def.title,
      description: def.description,
      version: KPI_VERSION,
      kpis,
      table,
      page: pageNo,
      pageSize: PAGE_SIZE,
      trend,
      trendKind: def.trend ?? null,
      showMoney,
      canExport:
        hasPermission(ctx, "reports.export") &&
        isFeatureEnabled(ent, "reports.advanced"),
    };
  });
}

/**
 * Per-day series for charts: rollup rows for past days (history), live tables for today and for
 * any day the rollup doesn't have yet. Active members exist only where a snapshot does.
 */
export async function dailySeries(
  tx: TenantTransaction,
  scope: KpiScope,
): Promise<TrendPoint[]> {
  const days: string[] = [];
  for (
    let d = scope.period.from;
    d < scope.period.to && d <= scope.today;
    d = addDays(d, 1)
  )
    days.push(d);
  const rolled = await tx.$queryRaw<
    {
      day: Date;
      active: bigint;
      new_members: bigint;
      check_ins: bigint;
      unique_visits: bigint;
      invoiced: bigint;
      payments: bigint;
      refunds: bigint;
    }[]
  >`
    SELECT day, sum(active_members) AS active, sum(new_members) AS new_members, sum(check_ins) AS check_ins,
           sum(unique_visits) AS unique_visits, sum(invoiced_minor) AS invoiced, sum(payments_minor) AS payments,
           sum(refunds_minor) AS refunds
      FROM app.metric_daily
     WHERE day >= ${toDbDate(scope.period.from)}::date AND day < ${toDbDate(scope.today)}::date
       AND day < ${toDbDate(scope.period.to)}::date ${branchFilter("branch_id", scope)}
     GROUP BY day`;
  const byDay = new Map(rolled.map((r) => [fromDbDate(r.day), r]));
  const missing = days.filter((d) => !byDay.has(d));
  const live = missing.length
    ? await liveDaily(tx, {
        ...scope,
        period: { from: missing[0]!, to: addDays(missing.at(-1)!, 1) },
      })
    : new Map();
  const activeToday = days.includes(scope.today)
    ? await load.activeMembersNow(tx, scope)
    : null;
  return days.map((day) => {
    const r = byDay.get(day);
    if (r)
      return {
        day,
        activeMembers: Number(r.active),
        newMembers: Number(r.new_members),
        checkIns: Number(r.check_ins),
        uniqueVisits: Number(r.unique_visits),
        invoicedMinor: Number(r.invoiced),
        collectedMinor: Number(r.payments) - Number(r.refunds),
      };
    const l = live.get(day);
    return {
      day,
      activeMembers: day === scope.today ? activeToday : null,
      newMembers: l?.newMembers ?? 0,
      checkIns: l?.checkIns ?? 0,
      uniqueVisits: l?.uniqueVisits ?? 0,
      invoicedMinor: l?.invoicedMinor ?? 0,
      collectedMinor: l?.collectedMinor ?? 0,
    };
  });
}

/** Live per-day figures (same rules as the rollup) for days without a rollup row. */
async function liveDaily(tx: TenantTransaction, scope: KpiScope) {
  const { fromUtc, toUtc } = periodUtc(scope);
  const tz = scope.timezone;
  const localDay = (col: string) =>
    Prisma.sql`to_char(((${Prisma.raw(col)} AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date, 'YYYY-MM-DD')`;
  const out = new Map<
    string,
    {
      newMembers: number;
      checkIns: number;
      uniqueVisits: number;
      invoicedMinor: number;
      collectedMinor: number;
    }
  >();
  const at = (day: string) => {
    let v = out.get(day);
    if (!v)
      out.set(
        day,
        (v = {
          newMembers: 0,
          checkIns: 0,
          uniqueVisits: 0,
          invoicedMinor: 0,
          collectedMinor: 0,
        }),
      );
    return v;
  };
  for (const r of await load.visitsByDay(tx, scope)) {
    at(r.day).checkIns += r.raw;
    at(r.day).uniqueVisits += r.unique;
  }
  const pay = await tx.$queryRaw<{ day: string; v: bigint }[]>`
    SELECT ${localDay("received_at")} AS day, sum(amount_minor) AS v FROM app.gym_payment
     WHERE status = 'SUCCEEDED' AND voided_at IS NULL AND received_at >= ${fromUtc} AND received_at < ${toUtc}
       ${branchFilter("branch_id", scope)} GROUP BY 1`;
  for (const r of pay) at(r.day).collectedMinor += Number(r.v);
  const ref = await tx.$queryRaw<{ day: string; v: bigint }[]>`
    SELECT ${localDay("r.processed_at")} AS day, sum(r.amount_minor) AS v
      FROM app.refund r JOIN app.gym_payment p ON p.id = r.payment_id AND p.tenant_id = r.tenant_id
     WHERE r.status = 'PROCESSED' AND r.processed_at >= ${fromUtc} AND r.processed_at < ${toUtc}
       ${branchFilter("p.branch_id", scope)} GROUP BY 1`;
  for (const r of ref) at(r.day).collectedMinor -= Number(r.v);
  const inv = await tx.$queryRaw<{ day: Date; v: bigint }[]>`
    SELECT issue_date AS day, sum(total_minor) AS v FROM app.gym_invoice
     WHERE voided_at IS NULL AND status <> 'VOID'
       AND issue_date >= ${toDbDate(scope.period.from)}::date AND issue_date < ${toDbDate(scope.period.to)}::date
       ${branchFilter("branch_id", scope)} GROUP BY 1`;
  for (const r of inv) at(fromDbDate(r.day)).invoicedMinor += Number(r.v);
  const cn = await tx.$queryRaw<{ day: Date; v: bigint }[]>`
    SELECT c.issue_date AS day, sum(c.total_minor) AS v
      FROM app.credit_note c JOIN app.gym_invoice i ON i.id = c.invoice_id AND i.tenant_id = c.tenant_id
     WHERE c.issue_date >= ${toDbDate(scope.period.from)}::date AND c.issue_date < ${toDbDate(scope.period.to)}::date
       ${branchFilter("i.branch_id", scope)} GROUP BY 1`;
  for (const r of cn) at(fromDbDate(r.day)).invoicedMinor -= Number(r.v);
  const newm = await tx.$queryRaw<{ day: Date; n: bigint }[]>`
    SELECT start_date AS day, count(*) AS n FROM (
      SELECT DISTINCT ON (member_id) member_id, start_date, branch_id FROM app.membership
       WHERE activated_at IS NOT NULL ORDER BY member_id, start_date, created_at) f
     WHERE start_date >= ${toDbDate(scope.period.from)}::date AND start_date < ${toDbDate(scope.period.to)}::date
       ${branchFilter("branch_id", scope)} GROUP BY 1`;
  for (const r of newm) at(fromDbDate(r.day)).newMembers += Number(r.n);
  return out;
}

// --- exports ------------------------------------------------------------------------------------

export const EXPORT_MAX_ROWS = 50_000;

const exportRequestSchema = z.object({
  report: z.string().refine(isReportKey, "Pick a report."),
  format: z.enum(["csv", "xlsx"]).default("csv"),
  scope: z.unknown().optional(),
});

/** Saved with the job: the resolved period and branches, so the file matches what was on screen. */
export const exportParamsSchema = z.object({
  report: z.string().refine(isReportKey),
  format: z.enum(["csv", "xlsx"]),
  from: z.string(),
  to: z.string(),
  branchIds: z.array(z.uuid()).nullable(),
});

/** Queue an export (reports.export + the advanced-reports plan feature). Audited. */
export async function requestReportExport(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const input = parseInput(exportRequestSchema, raw);
  await reportGuard(deps, ctx, input.report);
  await guard(deps, ctx, {
    permission: "reports.export",
    entitlement: "reports.advanced",
    write: true,
  });
  const def: ReportDef = REPORTS[input.report as ReportKey];
  const scope = resolveScope(
    deps,
    ctx,
    input.scope ?? {},
    def.financial ? "reports.financial" : "reports.view",
    "this_month",
  );
  const params = {
    report: input.report,
    format: input.format,
    from: scope.period.from,
    to: scope.period.to,
    branchIds: scope.branchIds,
  } satisfies z.infer<typeof exportParamsSchema>;
  return inTenant(deps, ctx, async (tx) => {
    const job = await tx.dataJob.create({
      data: {
        tenantId: ctx.tenantId,
        kind: "REPORT_EXPORT",
        createdById: ctx.userId,
        params: params as Prisma.InputJsonValue,
      },
    });
    await recordAudit(tx, ctx, {
      action: "reports.export_requested",
      entityType: "DataJob",
      entityId: job.id,
      meta: {
        report: params.report,
        format: params.format,
        from: params.from,
        to: params.to,
        branches: params.branchIds?.length ?? "all",
      },
    });
    return job;
  });
}

export async function listReportExports(deps: CoreDeps, ctx: AuthContext) {
  requirePermission(ctx, "reports.export");
  return inTenant(deps, ctx, (tx) =>
    tx.dataJob.findMany({
      where: { kind: "REPORT_EXPORT", createdById: ctx.userId },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  );
}

function exportCell(
  value: string | number | null | undefined,
  type: t.ColumnType,
): Cell {
  if (value === null || value === undefined) return null;
  if (type === "money" && typeof value === "number")
    return Math.round(value) / 100;
  if (type === "ratio" && typeof value === "number")
    return Math.round(value * 1000) / 10;
  if (type === "datetime" && typeof value === "string")
    return value.replace("T", " ");
  return value;
}

function exportHeader(c: t.Column, currency: string) {
  if (c.type === "money") return `${c.label} (${currency})`;
  if (c.type === "ratio") return `${c.label} (%)`;
  return c.label;
}

/**
 * Builds the export file as the requesting user (permissions re-checked by the caller: the job
 * runs with a fresh AuthContext). Reads the table page by page and reports progress.
 */
export async function buildReportExport(
  deps: CoreDeps,
  ctx: AuthContext,
  rawParams: unknown,
  onProgress: (pct: number) => Promise<void>,
) {
  const p = exportParamsSchema.parse(rawParams);
  requirePermission(ctx, "reports.export");
  const { def } = await reportGuard(deps, ctx, p.report);
  const scope = resolveScope(
    deps,
    ctx,
    {
      from: p.from,
      to: p.to,
      ...(p.branchIds ? { branchIds: p.branchIds } : { branchId: "all" }),
    },
    def.financial ? "reports.financial" : "reports.view",
  );
  const showMoney = moneyVisible(ctx, scope);
  const now = nowOf(deps);
  const batch = 500;
  const { columns, rows, total, currency } = await inTenant(
    deps,
    ctx,
    async (tx) => {
      const settings: KpiSettings = await kpiSettingsTx(tx, ctx.tenantId);
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { currency: true },
      });
      const all: t.Row[] = [];
      let first: t.ReportTable | null = null;
      for (let offset = 0; offset < EXPORT_MAX_ROWS; offset += batch) {
        const part = await def.table({
          tx,
          scope,
          settings,
          now,
          showMoney,
          limit: batch,
          offset,
        });
        first ??= part;
        all.push(...part.rows);
        await onProgress(
          Math.min(
            95,
            Math.round(
              ((offset + part.rows.length) /
                Math.max(1, Math.min(part.total, EXPORT_MAX_ROWS))) *
                95,
            ),
          ),
        );
        if (part.rows.length < batch) break;
      }
      return {
        columns: first!.columns,
        rows: all,
        total: first!.total,
        currency: tenant?.currency ?? "INR",
      };
    },
  );
  const header = columns.map((c) => exportHeader(c, currency));
  const body = rows.map((r) =>
    columns.map((c) => exportCell(r[c.key], c.type)),
  );
  const base = `${p.report}_${p.from}_${addDays(p.to, -1)}`;
  const file =
    p.format === "xlsx"
      ? {
          bytes: toXlsx(def.title, header, body),
          contentType: XLSX_CONTENT_TYPE,
          filename: `${base}.xlsx`,
        }
      : {
          bytes: toCsv([header, ...body]),
          contentType: "text/csv",
          filename: `${base}.csv`,
        };
  return {
    ...file,
    rows: rows.length,
    truncated: total > EXPORT_MAX_ROWS,
    version: KPI_VERSION,
  };
}
