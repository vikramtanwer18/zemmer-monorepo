import { addDays, compareDates, diffDays, type LocalDate } from "../time/dates";

/**
 * Pure rules for online payments (M4). Webhooks can arrive duplicated, late or out of order, so
 * state only ever moves forward and is derived from what was actually paid.
 */

export type LinkStatus =
  "CREATED" | "PARTIALLY_PAID" | "PAID" | "EXPIRED" | "CANCELLED";

const RANK: Record<LinkStatus, number> = {
  CREATED: 0,
  PARTIALLY_PAID: 1,
  EXPIRED: 1,
  CANCELLED: 1,
  PAID: 2,
};

/** The link's status from the money received (and whether the provider closed it). */
export function linkStatusFrom(
  amountMinor: number,
  paidMinor: number,
  closed: "EXPIRED" | "CANCELLED" | null,
): LinkStatus {
  if (paidMinor >= amountMinor) return "PAID";
  if (closed) return closed;
  return paidMinor > 0 ? "PARTIALLY_PAID" : "CREATED";
}

/**
 * Merge our status with a newly observed one: never backwards. PAID always wins; a closed link
 * stays closed unless more money proves it paid; PARTIALLY_PAID never returns to CREATED.
 */
export function mergeLinkStatus(
  current: LinkStatus,
  observed: LinkStatus,
): LinkStatus {
  if (current === "PAID" || observed === "PAID") return "PAID";
  if (current === "EXPIRED" || current === "CANCELLED") return current;
  if (observed === "EXPIRED" || observed === "CANCELLED") return observed;
  return RANK[observed] > RANK[current] ? observed : current;
}

/** Maps a provider link status to ours. */
export function fromProviderStatus(
  s: "created" | "partially_paid" | "paid" | "expired" | "cancelled",
): LinkStatus {
  return s.toUpperCase() as LinkStatus;
}

/**
 * A refund is backed by credit notes on the invoices the payment paid, newest allocation first,
 * never more than was allocated to an invoice nor more than it can still be credited. Whatever
 * is left (the payment's overpayment) comes from member credit without a credit note.
 */
export function planRefundCreditNotes(
  amountMinor: number,
  allocations: {
    invoiceId: string;
    allocatedMinor: number;
    creditableMinor: number;
  }[],
): {
  notes: { invoiceId: string; amountMinor: number }[];
  fromCreditOnlyMinor: number;
} {
  let left = amountMinor;
  const notes: { invoiceId: string; amountMinor: number }[] = [];
  for (const a of [...allocations].reverse()) {
    if (left <= 0) break;
    const take = Math.min(left, a.allocatedMinor, a.creditableMinor);
    if (take > 0) {
      notes.push({ invoiceId: a.invoiceId, amountMinor: take });
      left -= take;
    }
  }
  return { notes, fromCreditOnlyMinor: left };
}

/** Does this refund need a second person's approval? */
export function needsApproval(
  amountMinor: number,
  thresholdMinor: number | null,
): boolean {
  return thresholdMinor !== null && amountMinor > thresholdMinor;
}

// --- dues aging (KPI_DEFINITIONS: Outstanding dues, aging) ------------------------------------

export const AGING_BUCKETS = [
  "current",
  "1-30",
  "31-60",
  "61-90",
  "90+",
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Days past the due date (0 or less = not yet due). */
export function daysOverdue(dueDate: LocalDate, today: LocalDate): number {
  return diffDays(dueDate, today);
}

export function agingBucket(overdueDays: number): AgingBucket {
  if (overdueDays <= 0) return "current";
  if (overdueDays <= 30) return "1-30";
  if (overdueDays <= 60) return "31-60";
  if (overdueDays <= 90) return "61-90";
  return "90+";
}

/** The reminder (if any) due today for an invoice, given the gym's reminder days. */
export function duesReminderDue(
  dueDate: LocalDate,
  today: LocalDate,
  reminderDays: number[],
): number | null {
  const overdue = daysOverdue(dueDate, today);
  return reminderDays.includes(overdue) ? overdue : null;
}

// --- SaaS subscription lifecycle (D-14 MVP: TRIALING → ACTIVE → PAST_DUE → GRACE → SUSPENDED) ---

export type SaasStatus =
  "TRIALING" | "ACTIVE" | "PAST_DUE" | "GRACE" | "SUSPENDED" | "CANCELLED";

/**
 * Our subscription status from the provider's status (fetched, so out-of-order events converge)
 * and our own clock-based fields.
 */
export function saasStatusFrom(input: {
  current: SaasStatus;
  providerStatus: string;
  now: Date;
  graceEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}): SaasStatus {
  const { providerStatus: p, now } = input;
  switch (p) {
    case "active":
    case "authenticated":
      if (
        input.cancelAtPeriodEnd &&
        input.currentPeriodEnd &&
        input.currentPeriodEnd <= now
      )
        return "CANCELLED";
      return p === "active" ? "ACTIVE" : input.current;
    case "pending":
      return "PAST_DUE";
    case "halted":
      return input.graceEndsAt && input.graceEndsAt <= now
        ? "SUSPENDED"
        : "GRACE";
    case "cancelled":
    case "completed":
    case "expired":
      // Paid-up time is honoured: cancelled now, but access runs to the end of the period.
      return input.currentPeriodEnd && input.currentPeriodEnd > now
        ? input.current
        : "CANCELLED";
    default:
      return input.current;
  }
}

/** Dunning stage worth an email for a status change (one email per stage per period). */
export function dunningStage(
  from: SaasStatus,
  to: SaasStatus,
): "PAYMENT_FAILED" | "GRACE_STARTED" | "SUSPENDED" | "RECOVERED" | null {
  if (from === to) return null;
  if (to === "PAST_DUE") return "PAYMENT_FAILED";
  if (to === "GRACE") return "GRACE_STARTED";
  if (to === "SUSPENDED") return "SUSPENDED";
  if (to === "ACTIVE" && ["PAST_DUE", "GRACE", "SUSPENDED"].includes(from))
    return "RECOVERED";
  return null;
}

/** Trial-ending reminders: 3 days and 1 day before the trial ends. */
export function trialReminderDue(
  trialEnds: LocalDate,
  today: LocalDate,
): 3 | 1 | null {
  if (compareDates(addDays(today, 3), trialEnds) === 0) return 3;
  if (compareDates(addDays(today, 1), trialEnds) === 0) return 1;
  return null;
}

/** MRR in minor units for a price (KPI_DEFINITIONS: monthly-equivalent of the active price). */
export function monthlyEquivalent(
  amountMinor: number,
  cycle: "MONTHLY" | "HALF_YEARLY" | "YEARLY",
): number {
  return Math.round(
    cycle === "MONTHLY"
      ? amountMinor
      : cycle === "HALF_YEARLY"
        ? amountMinor / 6
        : amountMinor / 12,
  );
}

/** Our provider reference id: ≤ 40 chars, unique, no personal data. */
export function newReferenceId(prefix: "GL" | "RF", random: string): string {
  return `${prefix}-${random}`.slice(0, 40);
}
