import {
  addDays,
  addMonths,
  compareDates,
  diffDays,
  maxDate,
  type LocalDate,
} from "../time/dates";

/**
 * Membership rules. Pure; the service in ./service.ts applies them inside transactions.
 *
 *   PENDING_PAYMENT ──activate──▶ ACTIVE ──freeze──▶ PAUSED ──unfreeze──▶ ACTIVE
 *        │                         │  ▲                │
 *        └──cancel──▶ CANCELLED ◀──┘  └──extend─────── │ (extend keeps the status)
 *                                  └──expire──▶ EXPIRED ◀┘ (a paused membership doesn't expire)
 */
export type MembershipStateValue =
  "PENDING_PAYMENT" | "ACTIVE" | "PAUSED" | "EXPIRED" | "CANCELLED";
export type MembershipAction =
  "activate" | "freeze" | "unfreeze" | "extend" | "cancel" | "expire" | "renew";

const ALLOWED: Record<MembershipAction, readonly MembershipStateValue[]> = {
  activate: ["PENDING_PAYMENT"],
  freeze: ["ACTIVE"],
  unfreeze: ["PAUSED"],
  extend: ["ACTIVE", "PAUSED", "PENDING_PAYMENT"],
  cancel: ["PENDING_PAYMENT", "ACTIVE", "PAUSED"],
  expire: ["ACTIVE"],
  // Renewal creates a new membership; the old one may be in any of these.
  renew: ["ACTIVE", "PAUSED", "EXPIRED"],
};

export function canTransition(
  action: MembershipAction,
  from: MembershipStateValue,
): boolean {
  return ALLOWED[action].includes(from);
}

export function nextState(
  action: MembershipAction,
  from: MembershipStateValue,
): MembershipStateValue {
  if (!canTransition(action, from)) {
    throw new RangeError(
      `Cannot ${action} a membership that is ${from.toLowerCase().replace("_", " ")}.`,
    );
  }
  switch (action) {
    case "activate":
    case "unfreeze":
      return "ACTIVE";
    case "freeze":
      return "PAUSED";
    case "cancel":
      return "CANCELLED";
    case "expire":
      return "EXPIRED";
    case "extend":
    case "renew":
      return from;
  }
}

export type Duration = { unit: "DAY" | "MONTH" | "YEAR"; count: number };

/**
 * Inclusive end date: a 1-month plan from 15 Jan ends on 14 Feb. When the target month is too
 * short (31 Jan + 1 month), the membership ends on that month's last day (28/29 Feb), so members
 * starting late in a month never lose days.
 */
export function endDateFor(start: LocalDate, duration: Duration): LocalDate {
  if (!Number.isInteger(duration.count) || duration.count < 1)
    throw new RangeError("Duration must be ≥ 1");
  if (duration.unit === "DAY") return addDays(start, duration.count - 1);
  const months =
    duration.unit === "MONTH" ? duration.count : duration.count * 12;
  const after = addMonths(start, months);
  const clamped = after.slice(8) !== start.slice(8);
  return clamped ? after : addDays(after, -1);
}

/** A renewal starts the day after the current end, or today if it has already ended. */
export function renewalStart(
  currentEnd: LocalDate,
  today: LocalDate,
): LocalDate {
  return maxDate(addDays(currentEnd, 1), today);
}

/** Do two inclusive date ranges overlap? */
export function overlaps(
  a: { start: LocalDate; end: LocalDate },
  b: { start: LocalDate; end: LocalDate },
): boolean {
  return compareDates(a.start, b.end) <= 0 && compareDates(b.start, a.end) <= 0;
}

/** Has the membership's access ended (end date plus grace days is before today)? */
export function isPastGrace(
  endDate: LocalDate,
  graceDays: number,
  today: LocalDate,
): boolean {
  return compareDates(addDays(endDate, graceDays), today) < 0;
}

export type ActivationPolicy = "FULL_PAYMENT" | "ANY_PAYMENT" | "IMMEDIATE";

export function shouldActivate(
  policy: ActivationPolicy,
  invoice: { totalMinor: number; paidMinor: number },
): boolean {
  switch (policy) {
    case "IMMEDIATE":
      return true;
    case "ANY_PAYMENT":
      return invoice.paidMinor > 0 || invoice.totalMinor === 0;
    case "FULL_PAYMENT":
      return invoice.paidMinor >= invoice.totalMinor;
  }
}

// --- freezing ---------------------------------------------------------------------------

export type FreezeRules = { maxDays: number; maxTimes: number };

export type FreezeCheck = { ok: true } | { ok: false; reason: string };

/** Freeze for `days` days from `start`, given what has already been used. */
export function checkFreeze(
  rules: FreezeRules,
  used: { frozenDays: number; freezeCount: number },
  request: { start: LocalDate; days: number },
  membership: { startDate: LocalDate; endDate: LocalDate },
  today: LocalDate,
): FreezeCheck {
  if (rules.maxTimes === 0 || rules.maxDays === 0)
    return { ok: false, reason: "This plan can't be frozen." };
  if (!Number.isInteger(request.days) || request.days < 1)
    return { ok: false, reason: "Freeze for at least 1 day." };
  if (used.freezeCount >= rules.maxTimes) {
    return {
      ok: false,
      reason: `This plan allows ${rules.maxTimes} freeze${rules.maxTimes === 1 ? "" : "s"}; all used.`,
    };
  }
  const left = rules.maxDays - used.frozenDays;
  if (request.days > left)
    return {
      ok: false,
      reason: `Only ${left} freeze day${left === 1 ? "" : "s"} left on this plan.`,
    };
  if (compareDates(request.start, today) < 0)
    return { ok: false, reason: "A freeze can't start in the past." };
  if (
    compareDates(request.start, membership.startDate) < 0 ||
    compareDates(request.start, membership.endDate) > 0
  ) {
    return {
      ok: false,
      reason: "The freeze must start while the membership runs.",
    };
  }
  return { ok: true };
}

/**
 * KPI open question 2 (proposed default, used here): frozen days extend the end date.
 * Unfreezing early credits back only the days actually frozen.
 */
export function freezeDaysUsed(
  freezeStart: LocalDate,
  unfreezeDay: LocalDate,
  plannedDays: number,
): number {
  return Math.max(0, Math.min(plannedDays, diffDays(freezeStart, unfreezeDay)));
}

// --- coupons ----------------------------------------------------------------------------

export type CouponInput = {
  kind: "PERCENT" | "FLAT";
  value: number;
  validFrom: LocalDate | null;
  validTo: LocalDate | null;
  maxRedemptions: number | null;
  redemptions: number;
  planCodes: string[];
  status: "ACTIVE" | "ARCHIVED";
};

export type CouponCheck =
  { ok: true; discountMinor: number } | { ok: false; reason: string };

/** Discount on the plan price (before tax, never more than the price). Joining fees are not discounted. */
export function applyCoupon(
  coupon: CouponInput,
  planCode: string,
  priceMinor: number,
  today: LocalDate,
): CouponCheck {
  if (coupon.status !== "ACTIVE")
    return { ok: false, reason: "This coupon is no longer active." };
  if (coupon.validFrom && compareDates(today, coupon.validFrom) < 0)
    return { ok: false, reason: "This coupon isn't valid yet." };
  if (coupon.validTo && compareDates(today, coupon.validTo) > 0)
    return { ok: false, reason: "This coupon has expired." };
  if (
    coupon.maxRedemptions !== null &&
    coupon.redemptions >= coupon.maxRedemptions
  ) {
    return { ok: false, reason: "This coupon has been used up." };
  }
  if (coupon.planCodes.length > 0 && !coupon.planCodes.includes(planCode)) {
    return { ok: false, reason: "This coupon doesn't apply to this plan." };
  }
  const raw =
    coupon.kind === "PERCENT"
      ? Math.floor((priceMinor * coupon.value + 5000) / 10_000)
      : coupon.value;
  return { ok: true, discountMinor: Math.max(0, Math.min(raw, priceMinor)) };
}
