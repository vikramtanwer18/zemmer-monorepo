import { Prisma, type TenantTransaction } from "@gym/db";
import {
  addDays,
  diffDays,
  startOfDayUtc,
  toDbDate,
  type LocalDate,
} from "../time/dates";

/**
 * Daily KPI rollup (derived data, app.metric_daily): one row per branch per tenant-local day.
 * Reports read it for history (active-member trend, visits per active member) and live tables for
 * today. Everything except the active/paused snapshot can be recomputed from source at any time;
 * days before the first nightly snapshot get active/paused reconstructed from membership dates and
 * freezes (marked `reconstructed`).
 *
 * Nightly (metrics.rollup): yesterday with a live snapshot, plus the two days before it refreshed
 * (late corrections) keeping their snapshot. Rebuild: `pnpm metrics:rebuild`.
 */

type Mode = "snapshot" | "reconstruct" | "keep";

async function rollupDayTx(
  tx: TenantTransaction,
  tenantId: string,
  timeZone: string,
  day: LocalDate,
  mode: Mode,
  now: Date,
) {
  const fromUtc = startOfDayUtc(day, timeZone);
  const toUtc = startOfDayUtc(addDays(day, 1), timeZone);
  const date = toDbDate(day);
  const t = Prisma.sql`${tenantId}::uuid`;

  const active =
    mode === "snapshot"
      ? Prisma.sql`
        SELECT branch_id, count(DISTINCT member_id) FILTER (WHERE status = 'ACTIVE' AND start_date <= ${date}::date) AS active,
               count(DISTINCT member_id) FILTER (WHERE status = 'PAUSED') AS paused
          FROM app.membership WHERE tenant_id = ${t} GROUP BY branch_id`
      : Prisma.sql`
        SELECT m.branch_id,
               count(DISTINCT m.member_id) FILTER (WHERE NOT frozen) AS active,
               count(DISTINCT m.member_id) FILTER (WHERE frozen) AS paused
          FROM (
            SELECT ms.branch_id, ms.member_id,
                   EXISTS (SELECT 1 FROM app.membership_freeze f
                            WHERE f.tenant_id = ms.tenant_id AND f.membership_id = ms.id AND f.start_date <= ${date}::date AND f.end_date >= ${date}::date) AS frozen
              FROM app.membership ms
             WHERE ms.tenant_id = ${t} AND ms.activated_at IS NOT NULL AND ms.status <> 'PENDING_PAYMENT'
               AND ms.start_date <= ${date}::date AND ms.end_date >= ${date}::date
               AND (ms.cancelled_at IS NULL OR ms.cancelled_at >= ${toUtc})
          ) m GROUP BY m.branch_id`;

  // Every figure per branch for the day; branches with nothing get zeros.
  await tx.$executeRaw`
    WITH b AS (SELECT id AS branch_id FROM app.branch WHERE tenant_id = ${t}),
    snap AS (${active}),
    visits AS (
      SELECT branch_id, count(*) AS raw, count(DISTINCT member_id) AS uniq
        FROM app.attendance_event
       WHERE tenant_id = ${t} AND type = 'CHECK_IN' AND result = 'ACCEPTED' AND voided_at IS NULL AND member_id IS NOT NULL
         AND occurred_at >= ${fromUtc} AND occurred_at < ${toUtc}
       GROUP BY branch_id),
    newm AS (
      SELECT branch_id, count(*) AS n FROM (
        SELECT DISTINCT ON (member_id) member_id, start_date, branch_id FROM app.membership
         WHERE tenant_id = ${t} AND activated_at IS NOT NULL ORDER BY member_id, start_date, created_at) f
       WHERE start_date = ${date}::date GROUP BY branch_id),
    inv AS (
      SELECT branch_id, sum(total_minor) AS v FROM app.gym_invoice
       WHERE tenant_id = ${t} AND voided_at IS NULL AND status <> 'VOID' AND issue_date = ${date}::date GROUP BY branch_id),
    cn AS (
      SELECT i.branch_id, sum(c.total_minor) AS v FROM app.credit_note c
        JOIN app.gym_invoice i ON i.id = c.invoice_id AND i.tenant_id = c.tenant_id
       WHERE c.tenant_id = ${t} AND c.issue_date = ${date}::date GROUP BY i.branch_id),
    pay AS (
      SELECT branch_id, sum(amount_minor) AS v FROM app.gym_payment
       WHERE tenant_id = ${t} AND status = 'SUCCEEDED' AND voided_at IS NULL AND received_at >= ${fromUtc} AND received_at < ${toUtc}
       GROUP BY branch_id),
    ref AS (
      SELECT branch_id, sum(v) AS v FROM (
        SELECT p.branch_id, r.amount_minor AS v
          FROM app.refund r JOIN app.gym_payment p ON p.id = r.payment_id AND p.tenant_id = r.tenant_id
         WHERE r.tenant_id = ${t} AND r.status = 'PROCESSED' AND r.processed_at >= ${fromUtc} AND r.processed_at < ${toUtc}
        UNION ALL
        SELECT mp.home_branch_id, -e.amount_minor
          FROM app.member_credit_entry e JOIN app.member_profile mp ON mp.id = e.member_id AND mp.tenant_id = e.tenant_id
         WHERE e.tenant_id = ${t} AND e.kind = 'MANUAL_REFUND' AND e.payment_id IS NULL AND e.created_at >= ${fromUtc} AND e.created_at < ${toUtc}
      ) x GROUP BY branch_id)
    INSERT INTO app.metric_daily (tenant_id, branch_id, day, active_members, paused_members, new_members, check_ins,
                                  unique_visits, invoiced_minor, payments_minor, refunds_minor, reconstructed, computed_at)
    SELECT ${tenantId}::uuid, b.branch_id, ${date}::date,
           coalesce(snap.active, 0), coalesce(snap.paused, 0), coalesce(newm.n, 0),
           coalesce(visits.raw, 0), coalesce(visits.uniq, 0),
           coalesce(inv.v, 0) - coalesce(cn.v, 0), coalesce(pay.v, 0), coalesce(ref.v, 0),
           ${mode !== "snapshot"}, ${now}
      FROM b
      LEFT JOIN snap ON snap.branch_id = b.branch_id
      LEFT JOIN visits ON visits.branch_id = b.branch_id
      LEFT JOIN newm ON newm.branch_id = b.branch_id
      LEFT JOIN inv ON inv.branch_id = b.branch_id
      LEFT JOIN cn ON cn.branch_id = b.branch_id
      LEFT JOIN pay ON pay.branch_id = b.branch_id
      LEFT JOIN ref ON ref.branch_id = b.branch_id
    ON CONFLICT (tenant_id, branch_id, day) DO UPDATE SET
      active_members = CASE WHEN ${mode === "keep"} AND NOT metric_daily.reconstructed THEN metric_daily.active_members ELSE EXCLUDED.active_members END,
      paused_members = CASE WHEN ${mode === "keep"} AND NOT metric_daily.reconstructed THEN metric_daily.paused_members ELSE EXCLUDED.paused_members END,
      reconstructed  = CASE WHEN ${mode === "keep"} AND NOT metric_daily.reconstructed THEN false ELSE EXCLUDED.reconstructed END,
      new_members = EXCLUDED.new_members, check_ins = EXCLUDED.check_ins, unique_visits = EXCLUDED.unique_visits,
      invoiced_minor = EXCLUDED.invoiced_minor, payments_minor = EXCLUDED.payments_minor,
      refunds_minor = EXCLUDED.refunds_minor, computed_at = EXCLUDED.computed_at`;
}

/**
 * Nightly, run on the tenant's local `today` (after midnight): snapshot yesterday from the live
 * membership state, refresh the two days before it (keeping their snapshot).
 */
export async function runMetricsRollupTx(
  tx: TenantTransaction,
  tenantId: string,
  timeZone: string,
  today: LocalDate,
  now: Date,
) {
  const yesterday = addDays(today, -1);
  await rollupDayTx(tx, tenantId, timeZone, yesterday, "snapshot", now);
  for (const d of [addDays(today, -2), addDays(today, -3)])
    await rollupDayTx(tx, tenantId, timeZone, d, "keep", now);
  return { day: yesterday, refreshed: 2 };
}

/**
 * Rebuild [from, to) from source. Days that already have a nightly snapshot keep it; other days
 * get active/paused reconstructed from dates. Safe to re-run (upsert).
 */
export async function rebuildMetricsTx(
  tx: TenantTransaction,
  tenantId: string,
  timeZone: string,
  from: LocalDate,
  to: LocalDate,
  now: Date,
) {
  if (to <= from) return { days: 0 };
  if (diffDays(from, to) > 800)
    throw new Error("Rebuild at most 800 days at a time");
  let days = 0;
  for (let d = from; d < to; d = addDays(d, 1)) {
    await rollupDayTx(tx, tenantId, timeZone, d, "keep", now);
    days++;
  }
  return { days };
}
