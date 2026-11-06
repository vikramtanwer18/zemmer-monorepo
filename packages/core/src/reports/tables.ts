import { Prisma, type TenantTransaction } from "@gym/db";
import * as calc from "../metrics/calc";
import { KPIS, type KpiKey, type KpiSettings } from "../metrics/kpis";
import * as load from "../metrics/loaders";
import { branchFilter, periodUtc, type KpiScope } from "../metrics/scope";
import {
  addDays,
  diffDays,
  fromDbDate,
  toDbDate,
  utcToLocalDateTime,
} from "../time/dates";

/**
 * Drill-down tables behind each report: the records a figure is made of. Same scope and rules as
 * the KPI registry (shared loaders/calculators), paginated on screen, unpaginated for exports.
 */

export type ColumnType =
  "text" | "date" | "datetime" | "money" | "count" | "ratio" | "number";
export type Column = { key: string; label: string; type: ColumnType };
export type Row = { [key: string]: string | number | null } & {
  _href?: string | null;
};
export type ReportTable = {
  title: string;
  columns: Column[];
  rows: Row[];
  total: number;
  note?: string;
};

export type TableEnv = {
  tx: TenantTransaction;
  scope: KpiScope;
  settings: KpiSettings;
  now: Date;
  /** Money columns are left out without reports.financial. */
  showMoney: boolean;
  limit: number;
  offset: number;
};

const num = (v: bigint | number | null | undefined) =>
  v === null || v === undefined ? null : Number(v);
const d = toDbDate;
const page = (env: TableEnv) =>
  Prisma.sql`LIMIT ${env.limit} OFFSET ${env.offset}`;
const totalOf = (rows: { total?: bigint | number }[]) =>
  Number(rows[0]?.total ?? 0);
const paged = <T>(all: T[], env: TableEnv) =>
  all.slice(env.offset, env.offset + env.limit);
const name = Prisma.sql`concat_ws(' ', mp.first_name, mp.last_name)`;
const money = (env: TableEnv, cols: Column[]) => (env.showMoney ? cols : []);

// --- members ------------------------------------------------------------------------------------

export async function membershipsStarted(env: TableEnv): Promise<ReportTable> {
  const { tx, scope } = env;
  const rows = await tx.$queryRaw<
    {
      id: string;
      member_id: string;
      code: string;
      name: string;
      plan: string;
      branch: string;
      start_date: Date;
      end_date: Date;
      status: string;
      price: bigint;
      total: bigint;
    }[]
  >`
    SELECT ms.id::text, mp.id::text AS member_id, mp.member_code AS code, ${name} AS name, p.name AS plan, b.name AS branch,
           ms.start_date, ms.end_date, ms.status::text, (ms.price_minor - ms.discount_minor) AS price, count(*) OVER () AS total
      FROM app.membership ms
      JOIN app.member_profile mp ON mp.id = ms.member_id AND mp.tenant_id = ms.tenant_id
      JOIN app.membership_plan p ON p.id = ms.plan_id AND p.tenant_id = ms.tenant_id
      JOIN app.branch b ON b.id = ms.branch_id AND b.tenant_id = ms.tenant_id
     WHERE ms.status <> 'PENDING_PAYMENT'
       AND ms.start_date >= ${d(scope.period.from)}::date AND ms.start_date < ${d(scope.period.to)}::date
       ${branchFilter("ms.branch_id", scope)}
     ORDER BY ms.start_date DESC, name ${page(env)}`;
  return {
    title: "Memberships started in the period",
    columns: [
      { key: "member", label: "Member", type: "text" },
      { key: "code", label: "Code", type: "text" },
      { key: "plan", label: "Plan", type: "text" },
      { key: "branch", label: "Branch", type: "text" },
      { key: "start", label: "Start", type: "date" },
      { key: "end", label: "End", type: "date" },
      { key: "status", label: "Status", type: "text" },
      ...money(env, [{ key: "price", label: "Price", type: "money" }]),
    ],
    rows: rows.map((r) => ({
      member: r.name,
      code: r.code,
      plan: r.plan,
      branch: r.branch,
      start: fromDbDate(r.start_date),
      end: fromDbDate(r.end_date),
      status: r.status,
      ...(env.showMoney ? { price: num(r.price) } : {}),
      _href: `/members/${r.member_id}`,
    })),
    total: totalOf(rows),
  };
}

async function membershipDetails(tx: TenantTransaction, ids: string[]) {
  if (!ids.length)
    return new Map<
      string,
      {
        member_id: string;
        name: string;
        code: string;
        plan: string;
        branch: string;
      }
    >();
  const rows = await tx.$queryRaw<
    {
      id: string;
      member_id: string;
      name: string;
      code: string;
      plan: string;
      branch: string;
    }[]
  >`
    SELECT ms.id::text, mp.id::text AS member_id, ${name} AS name, mp.member_code AS code, p.name AS plan, b.name AS branch
      FROM app.membership ms
      JOIN app.member_profile mp ON mp.id = ms.member_id AND mp.tenant_id = ms.tenant_id
      JOIN app.membership_plan p ON p.id = ms.plan_id AND p.tenant_id = ms.tenant_id
      JOIN app.branch b ON b.id = ms.branch_id AND b.tenant_id = ms.tenant_id
     WHERE ms.id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

export async function renewals(env: TableEnv): Promise<ReportTable> {
  const { tx, scope, settings } = env;
  const all = await load.membershipHistory(tx, scope, settings.graceDays);
  const ids = scope.branchIds ? new Set(scope.branchIds) : null;
  const r = calc.renewalOutcome(
    all,
    scope.period,
    settings.graceDays,
    (m) => !ids || !m.branchId || ids.has(m.branchId),
  );
  const ended = all
    .filter((m) => r.endedIds.includes(m.id))
    .sort((a, b) => (a.endDate < b.endDate ? 1 : -1));
  const slice = paged(ended, env);
  const info = await membershipDetails(
    tx,
    slice.map((m) => m.id),
  );
  return {
    title: "Memberships that ended in the period",
    note: `A membership counts as renewed when the next one starts within ${settings.graceDays} days of the end.`,
    columns: [
      { key: "member", label: "Member", type: "text" },
      { key: "plan", label: "Plan", type: "text" },
      { key: "branch", label: "Branch", type: "text" },
      { key: "end", label: "Ended", type: "date" },
      { key: "outcome", label: "Outcome", type: "text" },
    ],
    rows: slice.map((m) => {
      const i = info.get(m.id);
      const windowOpen =
        addDays(m.endDate, 1 + settings.graceDays) > scope.today;
      return {
        member: i?.name ?? "",
        plan: i?.plan ?? "",
        branch: i?.branch ?? "",
        end: m.endDate,
        outcome: r.renewedIds.has(m.id)
          ? "Renewed"
          : windowOpen
            ? "Not yet (grace period open)"
            : "Not renewed",
        _href: i ? `/members/${i.member_id}` : null,
      };
    }),
    total: ended.length,
  };
}

// --- attendance ---------------------------------------------------------------------------------

export async function attendanceByDay(env: TableEnv): Promise<ReportTable> {
  const rows = await load.visitsByDay(env.tx, env.scope);
  const branches = await branchNames(env.tx);
  const sorted = [...rows].sort((a, b) =>
    a.day < b.day ? 1 : a.day > b.day ? -1 : 0,
  );
  return {
    title: "Check-ins per day",
    columns: [
      { key: "day", label: "Day", type: "date" },
      { key: "branch", label: "Branch", type: "text" },
      { key: "checkIns", label: "Check-ins", type: "count" },
      { key: "members", label: "Members", type: "count" },
    ],
    rows: paged(sorted, env).map((r) => ({
      day: r.day,
      branch: branches.get(r.branchId) ?? "",
      checkIns: r.raw,
      members: r.unique,
      _href: `/attendance?date=${r.day}&branchId=${r.branchId}`,
    })),
    total: sorted.length,
  };
}

// --- money --------------------------------------------------------------------------------------

export async function paymentsReceived(env: TableEnv): Promise<ReportTable> {
  const { tx, scope } = env;
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<
    {
      id: string;
      receipt: string;
      received_at: Date;
      method: string;
      amount: bigint;
      member_id: string;
      name: string;
      branch: string;
      total: bigint;
    }[]
  >`
    SELECT gp.id::text, gp.receipt_number AS receipt, gp.received_at, gp.method::text, gp.amount_minor AS amount,
           mp.id::text AS member_id, ${name} AS name, b.name AS branch, count(*) OVER () AS total
      FROM app.gym_payment gp
      JOIN app.member_profile mp ON mp.id = gp.member_id AND mp.tenant_id = gp.tenant_id
      JOIN app.branch b ON b.id = gp.branch_id AND b.tenant_id = gp.tenant_id
     WHERE gp.status = 'SUCCEEDED' AND gp.voided_at IS NULL AND gp.received_at >= ${fromUtc} AND gp.received_at < ${toUtc}
       ${branchFilter("gp.branch_id", scope)}
     ORDER BY gp.received_at DESC ${page(env)}`;
  return {
    title: "Payments received",
    note: "Refunds processed in the period are listed in the Refunds report and subtracted from Collected.",
    columns: [
      { key: "receivedAt", label: "Received", type: "datetime" },
      { key: "receipt", label: "Receipt", type: "text" },
      { key: "member", label: "Member", type: "text" },
      { key: "method", label: "Method", type: "text" },
      { key: "branch", label: "Branch", type: "text" },
      { key: "amount", label: "Amount", type: "money" },
    ],
    rows: rows.map((r) => ({
      receivedAt: utcToLocalDateTime(r.received_at, scope.timezone),
      receipt: r.receipt,
      member: r.name,
      method: r.method.replace(/_/g, " ").toLowerCase(),
      branch: r.branch,
      amount: num(r.amount),
      _href: `/members/${r.member_id}`,
    })),
    total: totalOf(rows),
  };
}

const outstandingExpr = Prisma.sql`greatest(0, i.total_minor
  - coalesce((SELECT sum(a.amount_minor) FROM app.payment_allocation a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0)
  - coalesce((SELECT sum(c.total_minor) FROM app.credit_note c WHERE c.invoice_id = i.id), 0))`;

/** Open invoices with something owed: overdue first (oldest due date), then not yet due. */
export async function openInvoices(
  env: TableEnv,
  onlyOverdue = false,
): Promise<ReportTable> {
  const { tx, scope } = env;
  const rows = await tx.$queryRaw<
    {
      id: string;
      number: string;
      issue_date: Date;
      due_date: Date;
      total_minor: bigint;
      outstanding: bigint;
      member_id: string;
      name: string;
      branch: string;
    }[]
  >`
    SELECT * FROM (
      SELECT i.id::text, i.number, i.issue_date, i.due_date, i.total_minor, ${outstandingExpr} AS outstanding,
             mp.id::text AS member_id, ${name} AS name, b.name AS branch
        FROM app.gym_invoice i
        JOIN app.member_profile mp ON mp.id = i.member_id AND mp.tenant_id = i.tenant_id
        JOIN app.branch b ON b.id = i.branch_id AND b.tenant_id = i.tenant_id
       WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID') AND i.voided_at IS NULL
         ${onlyOverdue ? Prisma.sql`AND i.due_date < ${d(scope.today)}::date` : Prisma.empty}
         ${branchFilter("i.branch_id", scope)}
    ) x
     WHERE x.outstanding > 0
     ORDER BY x.due_date, x.number ${page(env)}`;
  return {
    title: onlyOverdue ? "Overdue invoices" : "Open invoices",
    columns: [
      { key: "number", label: "Invoice", type: "text" },
      { key: "member", label: "Member", type: "text" },
      { key: "branch", label: "Branch", type: "text" },
      { key: "issued", label: "Issued", type: "date" },
      { key: "due", label: "Due", type: "date" },
      { key: "daysOverdue", label: "Days overdue", type: "count" },
      { key: "bucket", label: "Bucket", type: "text" },
      { key: "outstanding", label: "Outstanding", type: "money" },
    ],
    rows: rows.map((r) => {
      const due = fromDbDate(r.due_date);
      const days = Math.max(0, diffDays(due, scope.today));
      return {
        number: r.number,
        member: r.name,
        branch: r.branch,
        issued: fromDbDate(r.issue_date),
        due,
        daysOverdue: days,
        bucket: calc.agingBucketOf(days) ?? "Not due",
        outstanding: num(r.outstanding),
        _href: `/invoices/${r.id}`,
      };
    }),
    total: await countOpen(tx, scope, onlyOverdue),
  };
}

async function countOpen(
  tx: TenantTransaction,
  scope: KpiScope,
  onlyOverdue: boolean,
) {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM app.gym_invoice i
     WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID') AND i.voided_at IS NULL AND ${outstandingExpr} > 0
       ${onlyOverdue ? Prisma.sql`AND i.due_date < ${d(scope.today)}::date` : Prisma.empty}
       ${branchFilter("i.branch_id", scope)}`;
  return Number(rows[0]?.n ?? 0);
}

export async function refundsList(env: TableEnv): Promise<ReportTable> {
  const { tx, scope } = env;
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<
    {
      at: Date;
      kind: string;
      amount: bigint;
      member_id: string;
      name: string;
      branch: string | null;
      source: string;
      total: bigint;
    }[]
  >`
    SELECT x.*, count(*) OVER () AS total FROM (
      SELECT r.processed_at AS at, r.kind::text AS kind, r.amount_minor AS amount, mp.id::text AS member_id, ${name} AS name,
             b.name AS branch, 'Refund request' AS source
        FROM app.refund r
        JOIN app.gym_payment p ON p.id = r.payment_id AND p.tenant_id = r.tenant_id
        JOIN app.member_profile mp ON mp.id = r.member_id AND mp.tenant_id = r.tenant_id
        JOIN app.branch b ON b.id = p.branch_id AND b.tenant_id = p.tenant_id
       WHERE r.status = 'PROCESSED' AND r.processed_at >= ${fromUtc} AND r.processed_at < ${toUtc}
         ${branchFilter("p.branch_id", scope)}
      UNION ALL
      SELECT e.created_at, 'MANUAL', -e.amount_minor, mp.id::text, ${name}, b.name, 'Credit refund'
        FROM app.member_credit_entry e
        JOIN app.member_profile mp ON mp.id = e.member_id AND mp.tenant_id = e.tenant_id
        JOIN app.branch b ON b.id = mp.home_branch_id AND b.tenant_id = mp.tenant_id
       WHERE e.kind = 'MANUAL_REFUND' AND e.payment_id IS NULL AND e.created_at >= ${fromUtc} AND e.created_at < ${toUtc}
         ${branchFilter("mp.home_branch_id", scope)}
    ) x ORDER BY x.at DESC ${page(env)}`;
  return {
    title: "Refunds processed",
    columns: [
      { key: "at", label: "Processed", type: "datetime" },
      { key: "member", label: "Member", type: "text" },
      { key: "kind", label: "Type", type: "text" },
      { key: "source", label: "Recorded as", type: "text" },
      { key: "branch", label: "Branch", type: "text" },
      { key: "amount", label: "Amount", type: "money" },
    ],
    rows: rows.map((r) => ({
      at: utcToLocalDateTime(r.at, scope.timezone),
      member: r.name,
      kind: r.kind === "ONLINE" ? "Online" : "Manual",
      source: r.source,
      branch: r.branch ?? "",
      amount: num(r.amount),
      _href: `/members/${r.member_id}`,
    })),
    total: totalOf(rows),
  };
}

// --- growth -------------------------------------------------------------------------------------

/** Lead cohort (created in the period) by the lead's current source or campaign (last touch). */
export async function leadCohortBy(
  env: TableEnv,
  by: "source" | "campaign",
): Promise<ReportTable> {
  const { tx, scope, settings } = env;
  const { fromUtc, toUtc } = periodUtc(scope);
  const join =
    by === "source"
      ? Prisma.sql`LEFT JOIN app.lead_source g ON g.id = l.source_id AND g.tenant_id = l.tenant_id`
      : Prisma.sql`LEFT JOIN app.campaign g ON g.id = l.campaign_id AND g.tenant_id = l.tenant_id`;
  const rows = await tx.$queryRaw<
    {
      key: string | null;
      label: string | null;
      leads: bigint;
      contacted: bigint;
      trials: bigint;
      won: bigint;
      won_window: bigint;
      revenue: bigint | null;
    }[]
  >`
    SELECT g.id::text AS key, g.name AS label, count(*) AS leads,
           count(*) FILTER (WHERE l.first_contacted_at IS NOT NULL) AS contacted,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM app.trial_booking t WHERE t.lead_id = l.id AND t.status = 'ATTENDED')) AS trials,
           count(*) FILTER (WHERE l.status = 'WON') AS won,
           count(*) FILTER (WHERE l.status = 'WON' AND l.won_at <= l.created_at + make_interval(days => ${settings.leadWindowDays}::int)) AS won_window,
           sum((SELECT coalesce(sum(i.total_minor), 0) - coalesce((SELECT sum(c.total_minor) FROM app.credit_note c
                                                                   JOIN app.gym_invoice ci ON ci.id = c.invoice_id
                                                                  WHERE ci.membership_id = l.converted_membership_id), 0)
                  FROM app.gym_invoice i WHERE i.membership_id = l.converted_membership_id AND i.voided_at IS NULL AND i.status <> 'VOID')
           ) FILTER (WHERE l.status = 'WON') AS revenue
      FROM app.lead l ${join}
     WHERE l.created_at >= ${fromUtc} AND l.created_at < ${toUtc} ${branchFilter("l.branch_id", scope)}
     GROUP BY g.id, g.name
     ORDER BY leads DESC`;
  const label = by === "source" ? "Source" : "Campaign";
  const inProgress =
    addDays(scope.period.to, settings.leadWindowDays) > scope.today;
  return {
    title: `Leads created in the period, by ${by}`,
    note: `Grouped by the lead's current ${by} (last touch). Conversion = won within ${settings.leadWindowDays} days${inProgress ? "; still in progress for this period" : ""}.`,
    columns: [
      { key: "group", label, type: "text" },
      { key: "leads", label: "Leads", type: "count" },
      { key: "contacted", label: "Contacted", type: "count" },
      { key: "trials", label: "Trial attended", type: "count" },
      { key: "won", label: "Joined", type: "count" },
      { key: "conversion", label: "Conversion", type: "ratio" },
      ...money(env, [{ key: "revenue", label: "Revenue", type: "money" }]),
    ],
    rows: paged(rows, env).map((r) => ({
      group: r.label ?? (by === "source" ? "No source" : "No campaign"),
      leads: num(r.leads),
      contacted: num(r.contacted),
      trials: num(r.trials),
      won: num(r.won),
      conversion: calc.ratio(Number(r.won_window), Number(r.leads)),
      ...(env.showMoney ? { revenue: num(r.revenue) ?? 0 } : {}),
      _href: by === "campaign" ? "/leads/campaigns" : "/leads/reports",
    })),
    total: rows.length,
  };
}

export async function trialsAttended(env: TableEnv): Promise<ReportTable> {
  const { tx, scope } = env;
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<
    {
      lead_id: string;
      name: string;
      attended_at: Date;
      branch: string;
      status: string;
      won_at: Date | null;
      total: bigint;
    }[]
  >`
    SELECT l.id::text AS lead_id, concat_ws(' ', l.first_name, l.last_name) AS name, t.attended_at, b.name AS branch,
           l.status::text, l.won_at, count(*) OVER () AS total
      FROM app.trial_booking t
      JOIN app.lead l ON l.id = t.lead_id AND l.tenant_id = t.tenant_id
      JOIN app.branch b ON b.id = t.branch_id AND b.tenant_id = t.tenant_id
     WHERE t.status = 'ATTENDED' AND t.attended_at >= ${fromUtc} AND t.attended_at < ${toUtc}
       ${branchFilter("t.branch_id", scope)}
     ORDER BY t.attended_at DESC ${page(env)}`;
  const day = 86_400_000;
  return {
    title: "Trials attended",
    columns: [
      { key: "attended", label: "Attended", type: "datetime" },
      { key: "lead", label: "Lead", type: "text" },
      { key: "branch", label: "Branch", type: "text" },
      { key: "outcome", label: "Outcome", type: "text" },
    ],
    rows: rows.map((r) => {
      const won =
        r.status === "WON" &&
        r.won_at &&
        r.won_at.getTime() - r.attended_at.getTime() <= 30 * day;
      const open = env.now.getTime() - r.attended_at.getTime() < 30 * day;
      return {
        attended: utcToLocalDateTime(r.attended_at, scope.timezone),
        lead: r.name,
        branch: r.branch,
        outcome: won
          ? "Joined within 30 days"
          : r.status === "LOST"
            ? "Lost"
            : open
              ? "Open"
              : "Not joined in 30 days",
        _href: `/leads/${r.lead_id}`,
      };
    }),
    total: totalOf(rows),
  };
}

export async function retentionFlags(env: TableEnv): Promise<ReportTable> {
  const { tx, scope } = env;
  const rows = await tx.$queryRaw<
    { kind: string; open: bigint; members: bigint }[]
  >`
    SELECT kind::text, count(*) AS open, count(DISTINCT member_id) AS members
      FROM app.retention_flag
     WHERE status IN ('OPEN', 'ACTIONED') ${branchFilter("branch_id", scope)}
     GROUP BY kind ORDER BY open DESC`;
  return {
    title: "Open retention flags by rule",
    note: "Rule-based flags from the nightly retention run; not predictions.",
    columns: [
      { key: "rule", label: "Rule", type: "text" },
      { key: "open", label: "Open flags", type: "count" },
      { key: "members", label: "Members", type: "count" },
    ],
    rows: paged(rows, env).map((r) => ({
      rule: r.kind.replace(/_/g, " ").toLowerCase(),
      open: num(r.open),
      members: num(r.members),
      _href: `/retention?kind=${r.kind}`,
    })),
    total: rows.length,
  };
}

export async function referralsList(env: TableEnv): Promise<ReportTable> {
  const { tx, scope } = env;
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<
    {
      referrer_id: string;
      referrer: string;
      friend: string | null;
      status: string;
      created_at: Date;
      joined_at: Date | null;
      total: bigint;
    }[]
  >`
    SELECT mp.id::text AS referrer_id, ${name} AS referrer, concat_ws(' ', l.first_name, l.last_name) AS friend,
           r.status::text, r.created_at, r.joined_at, count(*) OVER () AS total
      FROM app.referral r
      JOIN app.member_profile mp ON mp.id = r.referrer_member_id AND mp.tenant_id = r.tenant_id
      LEFT JOIN app.lead l ON l.id = r.lead_id AND l.tenant_id = r.tenant_id
     WHERE ((r.created_at >= ${fromUtc} AND r.created_at < ${toUtc}) OR (r.joined_at >= ${fromUtc} AND r.joined_at < ${toUtc}))
       ${branchFilter("l.branch_id", scope)}
     ORDER BY r.created_at DESC ${page(env)}`;
  return {
    title: "Referrals",
    columns: [
      { key: "referrer", label: "Referred by", type: "text" },
      { key: "friend", label: "Friend", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "created", label: "Signed up", type: "date" },
      { key: "joined", label: "Joined", type: "date" },
    ],
    rows: rows.map((r) => ({
      referrer: r.referrer,
      friend: r.friend ?? "",
      status: r.status.toLowerCase(),
      created: utcToLocalDateTime(r.created_at, scope.timezone).slice(0, 10),
      joined: r.joined_at
        ? utcToLocalDateTime(r.joined_at, scope.timezone).slice(0, 10)
        : null,
      _href: `/members/${r.referrer_id}`,
    })),
    total: totalOf(rows),
  };
}

// --- classes & trainers -------------------------------------------------------------------------

export async function classSessions(env: TableEnv): Promise<ReportTable> {
  const { tx, scope, now } = env;
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<
    {
      id: string;
      name: string;
      starts_at: Date;
      branch: string;
      trainer: string | null;
      capacity: number;
      booked: bigint;
      attended: bigint;
      no_show: bigint;
      total: bigint;
    }[]
  >`
    SELECT s.id::text, s.name, s.starts_at, b.name AS branch, t.display_name AS trainer, s.capacity,
           count(k.id) FILTER (WHERE k.status <> 'CANCELLED') AS booked,
           count(k.id) FILTER (WHERE k.status = 'ATTENDED') AS attended,
           count(k.id) FILTER (WHERE k.status = 'NO_SHOW' OR (k.status = 'CANCELLED' AND k.late_cancel)) AS no_show,
           count(*) OVER () AS total
      FROM app.class_session s
      JOIN app.branch b ON b.id = s.branch_id AND b.tenant_id = s.tenant_id
      LEFT JOIN app.trainer_profile t ON t.id = s.trainer_id AND t.tenant_id = s.tenant_id
      LEFT JOIN app.booking k ON k.session_id = s.id AND k.tenant_id = s.tenant_id
     WHERE s.status <> 'CANCELLED' AND s.starts_at >= ${fromUtc} AND s.starts_at < ${toUtc} AND s.ends_at <= ${now}
       ${branchFilter("s.branch_id", scope)}
     GROUP BY s.id, b.name, t.display_name
     ORDER BY s.starts_at DESC ${page(env)}`;
  return {
    title: "Classes held",
    columns: [
      { key: "startsAt", label: "When", type: "datetime" },
      { key: "name", label: "Class", type: "text" },
      { key: "branch", label: "Branch", type: "text" },
      { key: "trainer", label: "Trainer", type: "text" },
      { key: "capacity", label: "Capacity", type: "count" },
      { key: "booked", label: "Booked", type: "count" },
      { key: "attended", label: "Attended", type: "count" },
      { key: "noShow", label: "No-shows", type: "count" },
      { key: "occupancy", label: "Occupancy", type: "ratio" },
    ],
    rows: rows.map((r) => ({
      startsAt: utcToLocalDateTime(r.starts_at, scope.timezone),
      name: r.name,
      branch: r.branch,
      trainer: r.trainer ?? "",
      capacity: r.capacity,
      booked: num(r.booked),
      attended: num(r.attended),
      noShow: num(r.no_show),
      occupancy: calc.ratio(Number(r.attended), r.capacity),
      _href: `/classes/${r.id}`,
    })),
    total: totalOf(rows),
  };
}

export async function trainerUtilization(env: TableEnv): Promise<ReportTable> {
  const { byTrainer, bookedBy } = await load.trainerLoad(env.tx, env.scope);
  const rows = [...byTrainer.entries()]
    .map(([id, t]) => {
      const available = calc.availableMinutes(t.slots, env.scope.period);
      const booked = bookedBy.get(id) ?? 0;
      return {
        id,
        name: t.name,
        available,
        booked,
        utilization: calc.ratio(booked, available),
      };
    })
    .sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1));
  return {
    title: "Trainer utilisation",
    note: "Staff without availability set up aren't included (their utilisation can't be measured).",
    columns: [
      { key: "trainer", label: "Trainer", type: "text" },
      { key: "availableHours", label: "Available hours", type: "number" },
      { key: "bookedHours", label: "Booked hours", type: "number" },
      { key: "utilization", label: "Utilisation", type: "ratio" },
    ],
    rows: paged(rows, env).map((r) => ({
      trainer: r.name,
      availableHours: Math.round(r.available / 6) / 10,
      bookedHours: Math.round(r.booked / 6) / 10,
      utilization: r.utilization,
      _href: "/pt",
    })),
    total: rows.length,
  };
}

// --- branch comparison ---------------------------------------------------------------------------

export const BRANCH_COMPARISON_KPIS: KpiKey[] = [
  "members.active",
  "members.new",
  "memberships.renewal_rate",
  "attendance.unique_visits",
  "attendance.avg_visits",
  "revenue.invoiced",
  "revenue.collected",
  "dues.outstanding",
  "members.at_risk",
];

export async function branchComparison(env: TableEnv): Promise<ReportTable> {
  const { tx, scope } = env;
  const branches = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT id::text, name FROM app.branch WHERE status = 'ACTIVE' ${scope.branchIds ? Prisma.sql`AND id = ANY(${scope.branchIds}::uuid[])` : Prisma.empty}
     ORDER BY name`;
  const keys = BRANCH_COMPARISON_KPIS.filter(
    (k) => env.showMoney || !KPIS[k].financial,
  );
  const rows: Row[] = [];
  for (const b of paged(branches, env)) {
    const row: Row = {
      branch: b.name,
      branchId: b.id,
      _href: `/reports/branches?branchId=${b.id}`,
    };
    for (const k of keys) {
      const v = await KPIS[k].compute({
        tx,
        scope: { ...scope, branchIds: [b.id] },
        settings: env.settings,
        now: env.now,
      });
      row[k] = v.value;
    }
    rows.push(row);
  }
  const typeOf = (k: KpiKey): ColumnType => {
    const u = KPIS[k].unit;
    return u === "money"
      ? "money"
      : u === "ratio"
        ? "ratio"
        : u === "number"
          ? "number"
          : "count";
  };
  return {
    title: "Branch comparison",
    columns: [
      { key: "branch", label: "Branch", type: "text" },
      ...keys.map((k) => ({ key: k, label: KPIS[k].label, type: typeOf(k) })),
    ],
    rows,
    total: branches.length,
  };
}

async function branchNames(tx: TenantTransaction) {
  const rows = await tx.branch.findMany({ select: { id: true, name: true } });
  return new Map(rows.map((b) => [b.id, b.name]));
}
