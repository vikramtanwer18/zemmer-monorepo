import { addDays, compareDates, diffDays, type LocalDate } from "../time/dates";

/**
 * Check-in eligibility (D-09), as pure functions so the scan, manual check-in and class booking
 * all apply the same rules and they can be unit-tested without a database.
 */
export const REJECT_CODES = [
  "INVALID_CODE",
  "CODE_EXPIRED",
  "CODE_ALREADY_USED",
  "PASS_REVOKED",
  "MEMBER_INACTIVE",
  "NO_MEMBERSHIP",
  "MEMBERSHIP_NOT_STARTED",
  "MEMBERSHIP_EXPIRED",
  "MEMBERSHIP_FROZEN",
  "MEMBERSHIP_UNPAID",
  "WRONG_BRANCH",
  "OUTSIDE_HOURS",
  "ALREADY_CHECKED_IN",
  "NOT_CHECKED_IN",
  "DUES_OUTSTANDING",
] as const;

export type RejectCode = (typeof REJECT_CODES)[number];

/** Codes a staff member with attendance.override may check in anyway (identity is known). */
export const OVERRIDABLE: ReadonlySet<RejectCode> = new Set<RejectCode>([
  "NO_MEMBERSHIP",
  "MEMBERSHIP_NOT_STARTED",
  "MEMBERSHIP_EXPIRED",
  "MEMBERSHIP_FROZEN",
  "MEMBERSHIP_UNPAID",
  "WRONG_BRANCH",
  "OUTSIDE_HOURS",
  "ALREADY_CHECKED_IN",
  "DUES_OUTSTANDING",
]);

/** Plain-words reason shown on the scan result (staff) — never technical. */
export function rejectMessage(
  code: RejectCode,
  detail: Record<string, string | undefined> = {},
): string {
  switch (code) {
    case "INVALID_CODE":
      return "This isn't a valid member pass for this gym.";
    case "CODE_EXPIRED":
      return "This code has expired. Ask the member to open the live card (it changes every 30 seconds).";
    case "CODE_ALREADY_USED":
      return "This code has already been used. Ask the member to show the live card, not a screenshot.";
    case "PASS_REVOKED":
      return "This pass has been cancelled. The member needs a new one from the front desk.";
    case "MEMBER_INACTIVE":
      return "This member's record isn't active (archived or waiting for approval).";
    case "NO_MEMBERSHIP":
      return "No active membership.";
    case "MEMBERSHIP_NOT_STARTED":
      return `The membership hasn't started yet${detail.date ? ` (starts ${detail.date})` : ""}.`;
    case "MEMBERSHIP_EXPIRED":
      return `The membership has expired${detail.date ? ` (ended ${detail.date})` : ""}.`;
    case "MEMBERSHIP_FROZEN":
      return "The membership is frozen right now.";
    case "MEMBERSHIP_UNPAID":
      return "The membership is waiting for payment.";
    case "WRONG_BRANCH":
      return "The membership isn't valid at this branch.";
    case "OUTSIDE_HOURS":
      return `Outside this membership's access hours${detail.hours ? ` (${detail.hours})` : ""}.`;
    case "ALREADY_CHECKED_IN":
      return `Already checked in${detail.time ? ` at ${detail.time}` : ""}.`;
    case "NOT_CHECKED_IN":
      return "This member isn't checked in at this branch, so they can't check out.";
    case "DUES_OUTSTANDING":
      return `Outstanding dues${detail.amount ? ` of ${detail.amount}` : ""}. Collect payment before check-in.`;
  }
}

export type AccessWindow = { days: number[]; from: string; to: string };

export type MembershipForAccess = {
  id: string;
  status: "PENDING_PAYMENT" | "ACTIVE" | "PAUSED" | "EXPIRED" | "CANCELLED";
  startDate: LocalDate;
  endDate: LocalDate;
  graceDays: number;
  planName: string;
  planCode: string;
  accessScope: "ALL_BRANCHES" | "HOME_BRANCH" | "LISTED_BRANCHES";
  /** Plan branches (LISTED_BRANCHES grants access only there). */
  planBranchIds: string[];
  accessWindows: AccessWindow[] | null;
  /** Class credits per membership from the plan: number, or null = unlimited (0 = no classes). */
  classCredits?: number | null;
};

export type AccessQuery = {
  branchId: string;
  homeBranchId: string;
  today: LocalDate;
  /** Local wall-clock minute and ISO weekday at the branch. Omit to skip the hours check. */
  minuteOfDay?: number;
  weekday?: number;
  /** Class booking: only these plan codes (empty = any). */
  planCodes?: string[];
};

export type AccessResult =
  | {
      ok: true;
      membership: MembershipForAccess;
      /** The end date has passed but the plan's grace days still give access. */
      inGrace: boolean;
    }
  | { ok: false; code: RejectCode; detail: Record<string, string> };

function parseClock(text: string): number {
  const [h, m] = text.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

export function withinWindows(
  windows: AccessWindow[] | null,
  weekday: number,
  minute: number,
): boolean {
  if (!windows || windows.length === 0) return true;
  return windows.some((w) => {
    if (!w.days.includes(weekday)) return false;
    const from = parseClock(w.from);
    const to = w.to === "24:00" ? 1440 : parseClock(w.to);
    return minute >= from && minute < to;
  });
}

export function describeWindows(windows: AccessWindow[] | null): string {
  if (!windows || windows.length === 0) return "any time";
  const names = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return windows
    .map((w) => `${w.days.map((d) => names[d]).join(", ")} ${w.from}–${w.to}`)
    .join("; ");
}

export function branchAllowed(
  m: Pick<MembershipForAccess, "accessScope" | "planBranchIds">,
  branchId: string,
  homeBranchId: string,
): boolean {
  switch (m.accessScope) {
    case "ALL_BRANCHES":
      return true;
    case "HOME_BRANCH":
      return branchId === homeBranchId;
    case "LISTED_BRANCHES":
      return m.planBranchIds.includes(branchId);
  }
}

// Order in which failures are reported when no membership qualifies: the most specific (the one
// the member is closest to fixing) first.
const FAILURE_RANK: RejectCode[] = [
  "OUTSIDE_HOURS",
  "WRONG_BRANCH",
  "MEMBERSHIP_FROZEN",
  "MEMBERSHIP_UNPAID",
  "MEMBERSHIP_NOT_STARTED",
  "MEMBERSHIP_EXPIRED",
  "NO_MEMBERSHIP",
];

/**
 * Does any of the member's memberships let them in at `branchId` now? Returns the membership
 * used, or the most useful reason why not.
 */
export function evaluateAccess(
  memberships: MembershipForAccess[],
  q: AccessQuery,
): AccessResult {
  const failures: { code: RejectCode; detail: Record<string, string> }[] = [];
  for (const m of memberships) {
    if (m.status === "CANCELLED") continue;
    if (
      q.planCodes &&
      q.planCodes.length > 0 &&
      !q.planCodes.includes(m.planCode)
    )
      continue;
    if (compareDates(q.today, m.startDate) < 0) {
      failures.push({
        code:
          m.status === "PENDING_PAYMENT"
            ? "MEMBERSHIP_UNPAID"
            : "MEMBERSHIP_NOT_STARTED",
        detail: { date: m.startDate },
      });
      continue;
    }
    const lastAccessDay = addDays(m.endDate, m.graceDays);
    if (m.status === "EXPIRED" || compareDates(q.today, lastAccessDay) > 0) {
      failures.push({
        code: "MEMBERSHIP_EXPIRED",
        detail: { date: m.endDate },
      });
      continue;
    }
    if (m.status === "PAUSED") {
      failures.push({ code: "MEMBERSHIP_FROZEN", detail: {} });
      continue;
    }
    if (m.status === "PENDING_PAYMENT") {
      failures.push({ code: "MEMBERSHIP_UNPAID", detail: {} });
      continue;
    }
    if (!branchAllowed(m, q.branchId, q.homeBranchId)) {
      failures.push({ code: "WRONG_BRANCH", detail: {} });
      continue;
    }
    if (
      q.minuteOfDay !== undefined &&
      q.weekday !== undefined &&
      !withinWindows(m.accessWindows, q.weekday, q.minuteOfDay)
    ) {
      failures.push({
        code: "OUTSIDE_HOURS",
        detail: { hours: describeWindows(m.accessWindows) },
      });
      continue;
    }
    return {
      ok: true,
      membership: m,
      inGrace: compareDates(q.today, m.endDate) > 0,
    };
  }
  if (failures.length === 0)
    return { ok: false, code: "NO_MEMBERSHIP", detail: {} };
  failures.sort(
    (a, b) => FAILURE_RANK.indexOf(a.code) - FAILURE_RANK.indexOf(b.code),
  );
  // Among expired ones, report the most recent end date.
  const best = failures[0]!;
  if (best.code === "MEMBERSHIP_EXPIRED") {
    const latest = failures
      .filter((f) => f.code === "MEMBERSHIP_EXPIRED")
      .map((f) => f.detail.date!)
      .sort()
      .at(-1)!;
    return { ok: false, code: best.code, detail: { date: latest } };
  }
  return { ok: false, ...best };
}

/** Parses the plan's stored access windows (M2 JSON), ignoring anything malformed. */
export function parseAccessWindows(value: unknown): AccessWindow[] | null {
  if (!Array.isArray(value)) return null;
  const out: AccessWindow[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown>;
    const clock = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
    if (
      Array.isArray(w.days) &&
      w.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) &&
      typeof w.from === "string" &&
      typeof w.to === "string" &&
      clock.test(w.from) &&
      clock.test(w.to)
    ) {
      out.push({ days: w.days as number[], from: w.from, to: w.to });
    }
  }
  return out.length ? out : null;
}

/**
 * Check-in streak (M3 simple version; full rules in M7): the number of consecutive local days,
 * ending today or yesterday, with at least one accepted check-in. A day without a visit breaks it.
 */
export function streakDays(visitDates: LocalDate[], today: LocalDate): number {
  const days = new Set(visitDates);
  let cursor = days.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** Visits in the 7 local days ending today (distinct days). */
export function visitsThisWeek(
  visitDates: LocalDate[],
  today: LocalDate,
): number {
  return new Set(
    visitDates.filter((d) => {
      const age = diffDays(d, today);
      return age >= 0 && age < 7;
    }),
  ).size;
}
