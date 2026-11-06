import { addDays, diffDays, isoWeekday, type LocalDate } from "../time/dates";

/**
 * Pure KPI arithmetic (docs/KPI_DEFINITIONS.md). Loaders fetch rows; these functions decide what
 * counts, so the rules are tested with fixed fixtures and every screen uses the same code.
 */

export type Period = { from: LocalDate; to: LocalDate };

export const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

/** The same-length period just before (for "vs previous period"). */
export function previousPeriod(p: Period): Period {
  const len = diffDays(p.from, p.to);
  return { from: addDays(p.from, -len), to: p.from };
}

export function comparison(current: number | null, previous: number | null) {
  if (current === null || previous === null)
    return { current, previous, delta: null, pct: null };
  const delta = current - previous;
  return {
    current,
    previous,
    delta,
    pct: previous !== 0 ? delta / Math.abs(previous) : null,
  };
}

export const daysIn = (p: Period): LocalDate[] => {
  const out: LocalDate[] = [];
  for (let d = p.from; d < p.to; d = addDays(d, 1)) out.push(d);
  return out;
};

// --- memberships ------------------------------------------------------------------------------

export type MembershipRow = {
  id: string;
  memberId: string;
  startDate: LocalDate;
  endDate: LocalDate;
  status: string;
  branchId?: string;
};
/** Which rows a branch filter keeps (the follow-up membership may be at any branch). */
export type InScope = (m: MembershipRow) => boolean;
const everywhere: InScope = () => true;

/**
 * Renewal rate: memberships that ended in the period (not cancelled) and were followed by another
 * membership starting no later than `graceDays` after the day after the end ÷ memberships that ended.
 */
export function renewalOutcome(
  all: readonly MembershipRow[],
  period: Period,
  graceDays: number,
  inScope: InScope = everywhere,
) {
  const ended = all.filter(
    (m) =>
      inScope(m) &&
      m.endDate >= period.from &&
      m.endDate < period.to &&
      m.status !== "CANCELLED" &&
      m.status !== "PENDING_PAYMENT",
  );
  const byMember = new Map<string, MembershipRow[]>();
  for (const m of all)
    if (m.status !== "CANCELLED" && m.status !== "PENDING_PAYMENT")
      byMember.set(m.memberId, [...(byMember.get(m.memberId) ?? []), m]);
  const renewed = ended.filter((e) =>
    (byMember.get(e.memberId) ?? []).some(
      (n) =>
        n.id !== e.id &&
        n.startDate > e.startDate &&
        n.startDate <= addDays(e.endDate, 1 + graceDays),
    ),
  );
  return {
    numerator: renewed.length,
    denominator: ended.length,
    renewedIds: new Set(renewed.map((r) => r.id)),
    endedIds: ended.map((e) => e.id),
  };
}

/**
 * Churned members: their last membership ended in the period and nothing started within the grace
 * window. "In progress" while the grace window after the period hasn't closed yet.
 */
export function churnOutcome(
  all: readonly MembershipRow[],
  period: Period,
  graceDays: number,
  today: LocalDate,
  inScope: InScope = everywhere,
) {
  const usable = all.filter(
    (m) => m.status !== "CANCELLED" && m.status !== "PENDING_PAYMENT",
  );
  const byMember = new Map<string, MembershipRow[]>();
  for (const m of usable)
    byMember.set(m.memberId, [...(byMember.get(m.memberId) ?? []), m]);
  const churned: string[] = [];
  for (const [memberId, list] of byMember) {
    const ending = list.filter(
      (m) => m.endDate >= period.from && m.endDate < period.to,
    );
    if (!ending.length) continue;
    const last = [...ending]
      .sort((a, b) =>
        a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0,
      )
      .at(-1)!;
    if (!inScope(last)) continue; // counted at the branch of the membership that ended
    const lastEnd = last.endDate;
    // Continued = another membership runs past lastEnd and started no later than the grace window.
    const continued = list.some(
      (m) =>
        m.endDate > lastEnd && m.startDate <= addDays(lastEnd, 1 + graceDays),
    );
    if (!continued && addDays(lastEnd, 1 + graceDays) <= today)
      churned.push(memberId);
  }
  return {
    count: churned.length,
    memberIds: churned,
    inProgress: addDays(period.to, graceDays) > today,
  };
}

/** Reactivated: started a membership in the period, previous one had ended more than grace days before. */
export function reactivatedMembers(
  all: readonly MembershipRow[],
  period: Period,
  graceDays: number,
  inScope: InScope = everywhere,
) {
  const usable = all.filter(
    (m) => m.status !== "CANCELLED" && m.status !== "PENDING_PAYMENT",
  );
  const byMember = new Map<string, MembershipRow[]>();
  for (const m of usable)
    byMember.set(m.memberId, [...(byMember.get(m.memberId) ?? []), m]);
  const ids = new Set<string>();
  for (const [memberId, list] of byMember)
    for (const m of list) {
      if (!inScope(m) || m.startDate < period.from || m.startDate >= period.to)
        continue;
      const before = list.filter(
        (p) => p.id !== m.id && p.startDate < m.startDate,
      );
      if (!before.length) continue; // first-ever → "new", not reactivated
      const lastEnd = before
        .map((p) => p.endDate)
        .sort()
        .at(-1)!;
      if (diffDays(lastEnd, m.startDate) > graceDays + 1) ids.add(memberId);
    }
  return [...ids];
}

// --- attendance -------------------------------------------------------------------------------

/** One visit per member per branch per local day. */
export function uniqueVisits(
  events: readonly { memberId: string; branchId: string; day: LocalDate }[],
) {
  return new Set(events.map((e) => `${e.memberId}|${e.branchId}|${e.day}`))
    .size;
}

export function average(values: readonly number[]): number | null {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}

// --- classes & trainers ------------------------------------------------------------------------

/** Occupancy over sessions held (cancelled excluded): attended ÷ capacity. */
export function occupancy(
  sessions: readonly { capacity: number; attended: number; status: string }[],
) {
  const held = sessions.filter((s) => s.status !== "CANCELLED");
  return {
    numerator: held.reduce((s, x) => s + x.attended, 0),
    denominator: held.reduce((s, x) => s + x.capacity, 0),
  };
}

/**
 * No-show rate: bookings not attended and not cancelled before the cutoff ÷ bookings still expected
 * (attended + no-show + late cancellations). On-time cancellations don't count on either side.
 */
export function noShow(
  bookings: readonly { status: string; lateCancel: boolean; count?: number }[],
) {
  const n = (b: { count?: number }) => b.count ?? 1;
  const expected = bookings.filter(
    (b) =>
      b.status === "ATTENDED" ||
      b.status === "NO_SHOW" ||
      (b.status === "CANCELLED" && b.lateCancel),
  );
  const missed = expected.filter((b) => b.status !== "ATTENDED");
  return {
    numerator: missed.reduce((s, b) => s + n(b), 0),
    denominator: expected.reduce((s, b) => s + n(b), 0),
  };
}

export type AvailabilitySlot = {
  kind: "WEEKLY" | "EXCEPTION";
  dayOfWeek: number | null;
  date: LocalDate | null;
  startMinute: number;
  endMinute: number;
  available: boolean;
};

/** Scheduled minutes in the period: weekly slots, plus extra exceptions, minus unavailable exceptions. */
export function availableMinutes(
  slots: readonly AvailabilitySlot[],
  period: Period,
): number {
  let total = 0;
  for (const day of daysIn(period)) {
    const wd = isoWeekday(day);
    let m = slots
      .filter((s) => s.kind === "WEEKLY" && s.available && s.dayOfWeek === wd)
      .reduce((a, s) => a + Math.max(0, s.endMinute - s.startMinute), 0);
    for (const e of slots.filter(
      (s) => s.kind === "EXCEPTION" && s.date === day,
    ))
      m += (e.available ? 1 : -1) * Math.max(0, e.endMinute - e.startMinute);
    total += Math.max(0, m);
  }
  return total;
}

/** Trainer utilization: booked PT + class minutes ÷ available scheduled minutes. */
export function utilization(bookedMinutes: number, available: number) {
  return {
    numerator: bookedMinutes,
    denominator: available,
    value: ratio(bookedMinutes, available),
  };
}

// --- money --------------------------------------------------------------------------------------

export type AgingBucket = "0-30" | "31-60" | "61-90" | "90+";

/** Overdue buckets by days past due (KPI_DEFINITIONS "Overdue dues"). Not yet due → not overdue. */
export function agingBucketOf(daysOverdue: number): AgingBucket | null {
  if (daysOverdue <= 0) return null;
  if (daysOverdue <= 30) return "0-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
}

export function agingTotals(
  invoices: readonly { outstandingMinor: number; dueDate: LocalDate }[],
  today: LocalDate,
) {
  const totals: Record<AgingBucket, number> = {
    "0-30": 0,
    "31-60": 0,
    "61-90": 0,
    "90+": 0,
  };
  let overdue = 0;
  for (const i of invoices) {
    if (i.outstandingMinor <= 0) continue;
    const b = agingBucketOf(diffDays(i.dueDate, today));
    if (!b) continue;
    totals[b] += i.outstandingMinor;
    overdue += i.outstandingMinor;
  }
  return { overdue, totals };
}

/** Collection rate: allocated to invoices due in the period ÷ total of those invoices (same set both sides). */
export function collectionRate(
  invoices: readonly { totalMinor: number; allocatedMinor: number }[],
) {
  const den = invoices.reduce((s, i) => s + i.totalMinor, 0);
  const num = invoices.reduce(
    (s, i) => s + Math.min(i.allocatedMinor, i.totalMinor),
    0,
  );
  return { numerator: num, denominator: den };
}
