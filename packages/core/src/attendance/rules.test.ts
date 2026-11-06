import { describe, expect, it } from "vitest";
import {
  evaluateAccess,
  parseAccessWindows,
  rejectMessage,
  streakDays,
  visitsThisWeek,
  withinWindows,
  type MembershipForAccess,
} from "./rules";

const HOME = "home";
const OTHER = "other";

const m = (over: Partial<MembershipForAccess> = {}): MembershipForAccess => ({
  id: "m1",
  status: "ACTIVE",
  startDate: "2026-11-01",
  endDate: "2026-11-30",
  graceDays: 0,
  planName: "Monthly",
  planCode: "MONTHLY",
  accessScope: "HOME_BRANCH",
  planBranchIds: [],
  accessWindows: null,
  ...over,
});

const q = { branchId: HOME, homeBranchId: HOME, today: "2026-11-10" };

describe("check-in eligibility", () => {
  it("lets an active member in at the home branch", () => {
    const r = evaluateAccess([m()], q);
    expect(r.ok && r.membership.id).toBe("m1");
  });

  it("refuses with the most useful reason", () => {
    expect(evaluateAccess([], q)).toMatchObject({ code: "NO_MEMBERSHIP" });
    expect(evaluateAccess([m({ endDate: "2026-11-05" })], q)).toMatchObject({
      code: "MEMBERSHIP_EXPIRED",
      detail: { date: "2026-11-05" },
    });
    expect(evaluateAccess([m({ startDate: "2026-11-20" })], q)).toMatchObject({
      code: "MEMBERSHIP_NOT_STARTED",
    });
    expect(evaluateAccess([m({ status: "PAUSED" })], q)).toMatchObject({
      code: "MEMBERSHIP_FROZEN",
    });
    expect(evaluateAccess([m({ status: "PENDING_PAYMENT" })], q)).toMatchObject(
      { code: "MEMBERSHIP_UNPAID" },
    );
    expect(evaluateAccess([m()], { ...q, branchId: OTHER })).toMatchObject({
      code: "WRONG_BRANCH",
    });
    // Frozen beats expired: a frozen current membership is more relevant than an old one.
    expect(
      evaluateAccess(
        [m({ id: "old", endDate: "2026-10-01" }), m({ status: "PAUSED" })],
        q,
      ),
    ).toMatchObject({ code: "MEMBERSHIP_FROZEN" });
  });

  it("uses grace days and says so", () => {
    const r = evaluateAccess([m({ endDate: "2026-11-08", graceDays: 3 })], q);
    expect(r).toMatchObject({ ok: true, inGrace: true });
    expect(
      evaluateAccess([m({ endDate: "2026-11-06", graceDays: 3 })], q),
    ).toMatchObject({ code: "MEMBERSHIP_EXPIRED" });
  });

  it("applies the plan's branch scope", () => {
    expect(
      evaluateAccess([m({ accessScope: "ALL_BRANCHES" })], {
        ...q,
        branchId: OTHER,
      }).ok,
    ).toBe(true);
    const listed = m({
      accessScope: "LISTED_BRANCHES",
      planBranchIds: [OTHER],
    });
    expect(evaluateAccess([listed], { ...q, branchId: OTHER }).ok).toBe(true);
    expect(evaluateAccess([listed], q)).toMatchObject({ code: "WRONG_BRANCH" });
  });

  it("applies access hours (off-peak plans)", () => {
    const offPeak = m({
      accessWindows: [{ days: [1, 2, 3, 4, 5], from: "10:00", to: "16:00" }],
    });
    // Tuesday 11:00 → in; Tuesday 18:00 → out; Saturday → out.
    expect(
      evaluateAccess([offPeak], { ...q, weekday: 2, minuteOfDay: 660 }).ok,
    ).toBe(true);
    const late = evaluateAccess([offPeak], {
      ...q,
      weekday: 2,
      minuteOfDay: 1080,
    });
    expect(late).toMatchObject({ code: "OUTSIDE_HOURS" });
    expect(!late.ok && rejectMessage(late.code, late.detail)).toContain(
      "Mon, Tue, Wed, Thu, Fri 10:00–16:00",
    );
    expect(withinWindows(offPeak.accessWindows, 6, 660)).toBe(false);
    expect(withinWindows(null, 6, 660)).toBe(true);
  });

  it("limits classes to eligible plan codes", () => {
    expect(evaluateAccess([m()], { ...q, planCodes: ["YOGA"] })).toMatchObject({
      code: "NO_MEMBERSHIP",
    });
    expect(evaluateAccess([m()], { ...q, planCodes: ["MONTHLY"] }).ok).toBe(
      true,
    );
  });

  it("parses stored access windows defensively", () => {
    expect(parseAccessWindows(null)).toBeNull();
    expect(
      parseAccessWindows([
        { days: [1], from: "06:00", to: "10:00" },
        { days: [9], from: "06:00", to: "10:00" },
        "junk",
      ]),
    ).toEqual([{ days: [1], from: "06:00", to: "10:00" }]);
  });
});

describe("streaks", () => {
  it("counts consecutive days ending today or yesterday", () => {
    const today = "2026-11-10";
    expect(streakDays([], today)).toBe(0);
    expect(streakDays(["2026-11-10", "2026-11-09", "2026-11-08"], today)).toBe(
      3,
    );
    // Not in yet today: yesterday's streak still counts.
    expect(streakDays(["2026-11-09", "2026-11-08"], today)).toBe(2);
    // A gap breaks it.
    expect(streakDays(["2026-11-10", "2026-11-08"], today)).toBe(1);
    expect(streakDays(["2026-11-07"], today)).toBe(0);
    // Two visits on one day count once.
    expect(streakDays(["2026-11-10", "2026-11-10"], today)).toBe(1);
  });

  it("counts distinct visit days in the last 7 days", () => {
    expect(
      visitsThisWeek(
        ["2026-11-10", "2026-11-10", "2026-11-04", "2026-11-03"],
        "2026-11-10",
      ),
    ).toBe(2);
  });
});
