import { Prisma, type TenantTransaction } from "@gym/db";
import { addDays, fromDbDate, toDbDate, type LocalDate } from "../time/dates";
import type { AvailabilitySlot, MembershipRow } from "./calc";
import { branchFilter, periodUtc, type KpiScope } from "./scope";

/**
 * SQL loaders for the KPI registry. Every query runs in a tenant transaction (RLS applies) and
 * filters by the scope's branches. They return raw rows or sums; the counting rules live in
 * calc.ts so they're tested with fixtures. Timestamps are stored as UTC without a zone, so local
 * days are `(col AT TIME ZONE 'UTC') AT TIME ZONE <tz>`.
 */

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

async function one(tx: TenantTransaction, query: Prisma.Sql): Promise<number> {
  const rows = await tx.$queryRaw<{ value: bigint | number | null }[]>(query);
  return num(rows[0]?.value);
}

const d = (date: LocalDate) => toDbDate(date);

// --- members & memberships --------------------------------------------------------------------

/** Member records in status ACTIVE, not anonymised, by home branch. */
export const totalMembers = (tx: TenantTransaction, scope: KpiScope) =>
  one(
    tx,
    Prisma.sql`SELECT count(*) AS value FROM app.member_profile
      WHERE status = 'ACTIVE' AND anonymized_at IS NULL ${branchFilter("home_branch_id", scope)}`,
  );

/** Distinct members with an ACTIVE (not PAUSED) membership that has started, today. */
export const activeMembersNow = (tx: TenantTransaction, scope: KpiScope) =>
  one(
    tx,
    Prisma.sql`SELECT count(DISTINCT member_id) AS value FROM app.membership
      WHERE status = 'ACTIVE' AND start_date <= ${d(scope.today)}::date ${branchFilter("branch_id", scope)}`,
  );

/** Distinct members whose only current membership is PAUSED. */
export const pausedMembersNow = (tx: TenantTransaction, scope: KpiScope) =>
  one(
    tx,
    Prisma.sql`SELECT count(DISTINCT m.member_id) AS value FROM app.membership m
      WHERE m.status = 'PAUSED' ${branchFilter("m.branch_id", scope)}
        AND NOT EXISTS (SELECT 1 FROM app.membership a
                         WHERE a.member_id = m.member_id AND a.status = 'ACTIVE' AND a.start_date <= ${d(scope.today)}::date)`,
  );

/** Members whose first-ever activated membership started in the period (re-joins aren't new). */
export async function newMemberIds(
  tx: TenantTransaction,
  scope: KpiScope,
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ member_id: string }[]>`
    SELECT member_id::text FROM (
      SELECT DISTINCT ON (member_id) member_id, start_date, branch_id
        FROM app.membership
       WHERE activated_at IS NOT NULL
       ORDER BY member_id, start_date, created_at
    ) first
    WHERE start_date >= ${d(scope.period.from)}::date AND start_date < ${d(scope.period.to)}::date
    ${branchFilter("branch_id", scope)}`;
  return rows.map((r) => r.member_id);
}

/**
 * Every usable membership (not awaiting payment) of members who had one overlapping the period,
 * so renewal / churn / reactivation can look at what came before and after. Not branch-filtered:
 * the calculators apply the branch to the membership being counted.
 */
export async function membershipHistory(
  tx: TenantTransaction,
  scope: KpiScope,
  graceDays: number,
): Promise<MembershipRow[]> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      member_id: string;
      branch_id: string;
      start_date: Date;
      end_date: Date;
      status: string;
    }[]
  >`
    SELECT id::text, member_id::text, branch_id::text, start_date, end_date, status::text
      FROM app.membership
     WHERE status <> 'PENDING_PAYMENT'
       AND member_id IN (
         SELECT member_id FROM app.membership
          WHERE status <> 'PENDING_PAYMENT'
            AND end_date >= ${d(addDays(scope.period.from, -1))}::date
            AND start_date < ${d(addDays(scope.period.to, graceDays + 1))}::date)`;
  return rows.map((r) => ({
    id: r.id,
    memberId: r.member_id,
    branchId: r.branch_id,
    startDate: fromDbDate(r.start_date),
    endDate: fromDbDate(r.end_date),
    status: r.status,
  }));
}

/** ACTIVE memberships ending in [today, today + days) with no renewal bought yet. */
export const expiringCount = (
  tx: TenantTransaction,
  scope: KpiScope,
  days: number,
) =>
  one(
    tx,
    Prisma.sql`SELECT count(*) AS value FROM app.membership m
      WHERE m.status = 'ACTIVE'
        AND m.end_date >= ${d(scope.today)}::date AND m.end_date < ${d(addDays(scope.today, days))}::date
        ${branchFilter("m.branch_id", scope)}
        AND NOT EXISTS (
          SELECT 1 FROM app.membership r
           WHERE r.member_id = m.member_id AND r.id <> m.id
             AND r.status IN ('PENDING_PAYMENT', 'ACTIVE', 'PAUSED') AND r.start_date > m.end_date)`,
  );

/** Distinct members with an open (or actioned) retention flag: a rule fired, not a prediction. */
export const atRiskMembers = (tx: TenantTransaction, scope: KpiScope) =>
  one(
    tx,
    Prisma.sql`SELECT count(DISTINCT member_id) AS value FROM app.retention_flag
      WHERE status IN ('OPEN', 'ACTIONED') AND member_id IS NOT NULL ${branchFilter("branch_id", scope)}`,
  );

// --- money --------------------------------------------------------------------------------------

/** Invoice totals (incl. tax) issued in the period, minus credit notes issued in the period. */
export async function invoicedMinor(
  tx: TenantTransaction,
  scope: KpiScope,
  column: "total_minor" | "taxable_minor" = "total_minor",
) {
  const col = Prisma.raw(column);
  const invoiced = await one(
    tx,
    Prisma.sql`SELECT coalesce(sum(${col}), 0) AS value FROM app.gym_invoice
      WHERE voided_at IS NULL AND status <> 'VOID'
        AND issue_date >= ${d(scope.period.from)}::date AND issue_date < ${d(scope.period.to)}::date
        ${branchFilter("branch_id", scope)}`,
  );
  const credited = await one(
    tx,
    Prisma.sql`SELECT coalesce(sum(c.${col}), 0) AS value
      FROM app.credit_note c JOIN app.gym_invoice i ON i.id = c.invoice_id AND i.tenant_id = c.tenant_id
      WHERE c.issue_date >= ${d(scope.period.from)}::date AND c.issue_date < ${d(scope.period.to)}::date
        ${branchFilter("i.branch_id", scope)}`,
  );
  return { gross: invoiced, credited, net: invoiced - credited };
}

/** Successful, not voided payments received in the period (online + manual). */
export function paymentsMinor(tx: TenantTransaction, scope: KpiScope) {
  const { fromUtc, toUtc } = periodUtc(scope);
  return one(
    tx,
    Prisma.sql`SELECT coalesce(sum(amount_minor), 0) AS value FROM app.gym_payment
      WHERE status = 'SUCCEEDED' AND voided_at IS NULL AND received_at >= ${fromUtc} AND received_at < ${toUtc}
        ${branchFilter("branch_id", scope)}`,
  );
}

/**
 * Money returned in the period: refunds PROCESSED in it (online and manual, at the payment's
 * branch), plus older direct credit refunds recorded without a refund request (member's home branch).
 */
export async function refundsMinor(tx: TenantTransaction, scope: KpiScope) {
  const { fromUtc, toUtc } = periodUtc(scope);
  const processed = await one(
    tx,
    Prisma.sql`SELECT coalesce(sum(r.amount_minor), 0) AS value
      FROM app.refund r JOIN app.gym_payment p ON p.id = r.payment_id AND p.tenant_id = r.tenant_id
      WHERE r.status = 'PROCESSED' AND r.processed_at >= ${fromUtc} AND r.processed_at < ${toUtc}
        ${branchFilter("p.branch_id", scope)}`,
  );
  const direct = await one(
    tx,
    Prisma.sql`SELECT coalesce(sum(-e.amount_minor), 0) AS value
      FROM app.member_credit_entry e JOIN app.member_profile mp ON mp.id = e.member_id AND mp.tenant_id = e.tenant_id
      WHERE e.kind = 'MANUAL_REFUND' AND e.payment_id IS NULL AND e.created_at >= ${fromUtc} AND e.created_at < ${toUtc}
        ${branchFilter("mp.home_branch_id", scope)}`,
  );
  return processed + direct;
}

const outstandingExpr = Prisma.sql`greatest(0, i.total_minor
  - coalesce((SELECT sum(a.amount_minor) FROM app.payment_allocation a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0)
  - coalesce((SELECT sum(c.total_minor) FROM app.credit_note c WHERE c.invoice_id = i.id), 0))`;

/** Sum over open invoices of (total − allocated payments − credit notes). Excludes VOID. */
export const outstandingMinor = (tx: TenantTransaction, scope: KpiScope) =>
  one(
    tx,
    Prisma.sql`SELECT coalesce(sum(${outstandingExpr}), 0) AS value FROM app.gym_invoice i
      WHERE i.status <> 'VOID' AND i.voided_at IS NULL ${branchFilter("i.branch_id", scope)}`,
  );

/** Open invoices already past their due date, with what's still owed. */
export async function overdueInvoices(tx: TenantTransaction, scope: KpiScope) {
  const rows = await tx.$queryRaw<
    { id: string; due_date: Date; outstanding: bigint }[]
  >`
    SELECT i.id::text, i.due_date, ${outstandingExpr} AS outstanding FROM app.gym_invoice i
     WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID') AND i.voided_at IS NULL
       AND i.due_date < ${d(scope.today)}::date ${branchFilter("i.branch_id", scope)}`;
  return rows.map((r) => ({
    id: r.id,
    dueDate: fromDbDate(r.due_date),
    outstandingMinor: num(r.outstanding),
  }));
}

/** Invoices due in the period: amount due (total − credit notes) and payments allocated to them. */
export async function invoicesDueIn(tx: TenantTransaction, scope: KpiScope) {
  const rows = await tx.$queryRaw<{ total: bigint; allocated: bigint }[]>`
    SELECT greatest(0, i.total_minor - coalesce((SELECT sum(c.total_minor) FROM app.credit_note c WHERE c.invoice_id = i.id), 0)) AS total,
           coalesce((SELECT sum(a.amount_minor) FROM app.payment_allocation a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0) AS allocated
      FROM app.gym_invoice i
     WHERE i.status <> 'VOID' AND i.voided_at IS NULL
       AND i.due_date >= ${d(scope.period.from)}::date AND i.due_date < ${d(scope.period.to)}::date
       ${branchFilter("i.branch_id", scope)}`;
  return rows.map((r) => ({
    totalMinor: num(r.total),
    allocatedMinor: num(r.allocated),
  }));
}

/** Member credit ledger total (a liability, not revenue), by the member's home branch. */
export const creditBalanceMinor = (tx: TenantTransaction, scope: KpiScope) =>
  one(
    tx,
    Prisma.sql`SELECT coalesce(sum(e.amount_minor), 0) AS value
      FROM app.member_credit_entry e JOIN app.member_profile mp ON mp.id = e.member_id AND mp.tenant_id = e.tenant_id
      WHERE true ${branchFilter("mp.home_branch_id", scope)}`,
  );

// --- attendance ---------------------------------------------------------------------------------

const acceptedCheckIn = Prisma.sql`type = 'CHECK_IN' AND result = 'ACCEPTED' AND voided_at IS NULL AND member_id IS NOT NULL`;

/** Accepted check-ins (QR + manual + overrides) and unique visits (member × branch × local day). */
export async function checkIns(tx: TenantTransaction, scope: KpiScope) {
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<
    { raw: bigint; unique_visits: bigint; members: bigint }[]
  >`
    SELECT count(*) AS raw,
           count(DISTINCT (member_id, branch_id, ((occurred_at AT TIME ZONE 'UTC') AT TIME ZONE ${scope.timezone})::date)) AS unique_visits,
           count(DISTINCT member_id) AS members
      FROM app.attendance_event
     WHERE ${acceptedCheckIn} AND occurred_at >= ${fromUtc} AND occurred_at < ${toUtc}
       ${branchFilter("branch_id", scope)}`;
  return {
    raw: num(rows[0]?.raw),
    unique: num(rows[0]?.unique_visits),
    members: num(rows[0]?.members),
  };
}

/** Unique visits per local day and branch (trend charts, rollups). */
export async function visitsByDay(tx: TenantTransaction, scope: KpiScope) {
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<
    { day: string; branch_id: string; raw: bigint; unique_visits: bigint }[]
  >`
    SELECT to_char(((occurred_at AT TIME ZONE 'UTC') AT TIME ZONE ${scope.timezone})::date, 'YYYY-MM-DD') AS day,
           branch_id::text,
           count(*) AS raw,
           count(DISTINCT member_id) AS unique_visits
      FROM app.attendance_event
     WHERE ${acceptedCheckIn} AND occurred_at >= ${fromUtc} AND occurred_at < ${toUtc}
       ${branchFilter("branch_id", scope)}
     GROUP BY 1, 2 ORDER BY 1, 2`;
  return rows.map((r) => ({
    day: r.day,
    branchId: r.branch_id,
    raw: num(r.raw),
    unique: num(r.unique_visits),
  }));
}

/** Average of the daily active-member snapshots in the period (rollup), or null without any. */
export async function averageActiveFromRollup(
  tx: TenantTransaction,
  scope: KpiScope,
) {
  const rows = await tx.$queryRaw<{ days: bigint; avg: number | null }[]>`
    SELECT count(*) AS days, avg(total)::float8 AS avg FROM (
      SELECT day, sum(active_members) AS total FROM app.metric_daily
       WHERE day >= ${d(scope.period.from)}::date AND day < ${d(scope.period.to)}::date
         ${branchFilter("branch_id", scope)}
       GROUP BY day) per_day`;
  return { days: num(rows[0]?.days), average: rows[0]?.avg ?? null };
}

/** Active members on a past day from the rollup (null when that day has no snapshot). */
export async function activeOnDay(
  tx: TenantTransaction,
  scope: KpiScope,
  day: LocalDate,
) {
  const rows = await tx.$queryRaw<{ n: bigint; total: bigint | null }[]>`
    SELECT count(*) AS n, sum(active_members) AS total FROM app.metric_daily
     WHERE day = ${d(day)}::date ${branchFilter("branch_id", scope)}`;
  return num(rows[0]?.n) ? num(rows[0]?.total) : null;
}

// --- classes & trainers ---------------------------------------------------------------------------

/** Sessions that started in the period and have ended (held = not cancelled), with attendance. */
export async function heldSessions(
  tx: TenantTransaction,
  scope: KpiScope,
  now: Date,
) {
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<
    { capacity: number; status: string; attended: bigint }[]
  >`
    SELECT s.capacity, s.status::text,
           (SELECT count(*) FROM app.booking b WHERE b.session_id = s.id AND b.status = 'ATTENDED') AS attended
      FROM app.class_session s
     WHERE s.starts_at >= ${fromUtc} AND s.starts_at < ${toUtc} AND s.ends_at <= ${now}
       ${branchFilter("s.branch_id", scope)}`;
  return rows.map((r) => ({
    capacity: r.capacity,
    status: r.status,
    attended: num(r.attended),
  }));
}

/** Bookings for sessions held in the period, grouped by outcome. */
export async function bookingOutcomes(
  tx: TenantTransaction,
  scope: KpiScope,
  now: Date,
) {
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<
    { status: string; late_cancel: boolean; n: bigint }[]
  >`
    SELECT b.status::text, b.late_cancel, count(*) AS n
      FROM app.booking b JOIN app.class_session s ON s.id = b.session_id AND s.tenant_id = b.tenant_id
     WHERE s.status <> 'CANCELLED' AND s.starts_at >= ${fromUtc} AND s.starts_at < ${toUtc} AND s.ends_at <= ${now}
       ${branchFilter("s.branch_id", scope)}
     GROUP BY 1, 2`;
  return rows.map((r) => ({
    status: r.status,
    lateCancel: r.late_cancel,
    count: num(r.n),
  }));
}

/**
 * Per trainer (trainer profile with availability set up): availability slots that apply to the
 * scope's branches, and minutes booked in the period (PT not cancelled + classes not cancelled).
 * Sessions and appointments reference the trainer profile; availability is kept per user.
 */
export async function trainerLoad(tx: TenantTransaction, scope: KpiScope) {
  const { fromUtc, toUtc } = periodUtc(scope);
  const slots = await tx.$queryRaw<
    {
      trainer_id: string;
      name: string;
      kind: "WEEKLY" | "EXCEPTION";
      day_of_week: number | null;
      date: Date | null;
      start_minute: number;
      end_minute: number;
      available: boolean;
    }[]
  >`
    SELECT t.id::text AS trainer_id, t.display_name AS name, a.kind::text AS kind, a.day_of_week, a.date, a.start_minute, a.end_minute, a.available
      FROM app.staff_availability a JOIN app.trainer_profile t ON t.user_id = a.user_id AND t.tenant_id = a.tenant_id
     WHERE ${scope.branchIds ? Prisma.sql`(a.branch_id IS NULL OR a.branch_id = ANY(${scope.branchIds}::uuid[]))` : Prisma.sql`true`}`;
  const booked = await tx.$queryRaw<{ trainer_id: string; minutes: number }[]>`
    SELECT trainer_id, sum(minutes)::float8 AS minutes FROM (
      SELECT trainer_id::text AS trainer_id, extract(epoch FROM (ends_at - starts_at)) / 60 AS minutes
        FROM app.pt_appointment
       WHERE status <> 'CANCELLED' AND starts_at >= ${fromUtc} AND starts_at < ${toUtc} ${branchFilter("branch_id", scope)}
      UNION ALL
      SELECT trainer_id::text, extract(epoch FROM (ends_at - starts_at)) / 60
        FROM app.class_session
       WHERE status <> 'CANCELLED' AND trainer_id IS NOT NULL AND starts_at >= ${fromUtc} AND starts_at < ${toUtc}
         ${branchFilter("branch_id", scope)}
    ) t GROUP BY trainer_id`;
  const byTrainer = new Map<
    string,
    { name: string; slots: AvailabilitySlot[] }
  >();
  for (const s of slots) {
    const entry = byTrainer.get(s.trainer_id) ?? { name: s.name, slots: [] };
    entry.slots.push({
      kind: s.kind,
      dayOfWeek: s.day_of_week,
      date: s.date ? fromDbDate(s.date) : null,
      startMinute: s.start_minute,
      endMinute: s.end_minute,
      available: s.available,
    });
    byTrainer.set(s.trainer_id, entry);
  }
  const bookedBy = new Map(
    booked.map((b) => [b.trainer_id, Math.round(b.minutes)]),
  );
  return { byTrainer, bookedBy };
}

// --- leads & referrals ----------------------------------------------------------------------------

export function leadsCreated(tx: TenantTransaction, scope: KpiScope) {
  const { fromUtc, toUtc } = periodUtc(scope);
  return one(
    tx,
    Prisma.sql`SELECT count(*) AS value FROM app.lead WHERE created_at >= ${fromUtc} AND created_at < ${toUtc} ${branchFilter("branch_id", scope)}`,
  );
}

/** Open leads now, by fixed stage category (custom stage names never matter). */
export async function openLeadsByStage(tx: TenantTransaction, scope: KpiScope) {
  const rows = await tx.$queryRaw<{ category: string; n: bigint }[]>`
    SELECT s.category::text AS category, count(*) AS n
      FROM app.lead l JOIN app.lead_stage s ON s.id = l.stage_id AND s.tenant_id = l.tenant_id
     WHERE l.status = 'OPEN' ${branchFilter("l.branch_id", scope)}
     GROUP BY 1`;
  return Object.fromEntries(rows.map((r) => [r.category, num(r.n)])) as Record<
    string,
    number
  >;
}

/** Trials scheduled to start in the period and not cancelled. */
export function trialsBooked(tx: TenantTransaction, scope: KpiScope) {
  const { fromUtc, toUtc } = periodUtc(scope);
  return one(
    tx,
    Prisma.sql`SELECT count(*) AS value FROM app.trial_booking
      WHERE status <> 'CANCELLED' AND starts_at >= ${fromUtc} AND starts_at < ${toUtc} ${branchFilter("branch_id", scope)}`,
  );
}

export function leadsWon(tx: TenantTransaction, scope: KpiScope) {
  const { fromUtc, toUtc } = periodUtc(scope);
  return one(
    tx,
    Prisma.sql`SELECT count(*) AS value FROM app.lead WHERE status = 'WON' AND won_at >= ${fromUtc} AND won_at < ${toUtc} ${branchFilter("branch_id", scope)}`,
  );
}

/** Cohort: leads created in the period, and those won within `windowDays` of being created. */
export async function leadCohort(
  tx: TenantTransaction,
  scope: KpiScope,
  windowDays: number,
) {
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<{ leads: bigint; won: bigint }[]>`
    SELECT count(*) AS leads,
           count(*) FILTER (WHERE status = 'WON' AND won_at <= created_at + make_interval(days => ${windowDays}::int)) AS won
      FROM app.lead
     WHERE created_at >= ${fromUtc} AND created_at < ${toUtc} ${branchFilter("branch_id", scope)}`;
  return { leads: num(rows[0]?.leads), won: num(rows[0]?.won) };
}

/** Trials attended in the period and those whose lead was won within 30 days (same rule as M5). */
export async function trialOutcomes(tx: TenantTransaction, scope: KpiScope) {
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<{ attended: bigint; converted: bigint }[]>`
    SELECT count(*) AS attended,
           count(*) FILTER (WHERE l.status = 'WON' AND l.won_at IS NOT NULL AND l.won_at - t.attended_at <= interval '30 days') AS converted
      FROM app.trial_booking t JOIN app.lead l ON l.id = t.lead_id AND l.tenant_id = t.tenant_id
     WHERE t.status = 'ATTENDED' AND t.attended_at >= ${fromUtc} AND t.attended_at < ${toUtc}
       ${branchFilter("t.branch_id", scope)}`;
  return {
    attended: num(rows[0]?.attended),
    converted: num(rows[0]?.converted),
  };
}

/** Referral leads created in the period, and referred friends who joined in it (lead's branch). */
export async function referralCounts(tx: TenantTransaction, scope: KpiScope) {
  const { fromUtc, toUtc } = periodUtc(scope);
  const rows = await tx.$queryRaw<{ created: bigint; joined: bigint }[]>`
    SELECT count(*) FILTER (WHERE r.created_at >= ${fromUtc} AND r.created_at < ${toUtc}) AS created,
           count(*) FILTER (WHERE r.status IN ('JOINED', 'REWARDED') AND r.joined_at >= ${fromUtc} AND r.joined_at < ${toUtc}) AS joined
      FROM app.referral r LEFT JOIN app.lead l ON l.id = r.lead_id AND l.tenant_id = r.tenant_id
     WHERE (r.created_at >= ${fromUtc} OR r.joined_at >= ${fromUtc}) ${branchFilter("l.branch_id", scope)}`;
  return { created: num(rows[0]?.created), joined: num(rows[0]?.joined) };
}
