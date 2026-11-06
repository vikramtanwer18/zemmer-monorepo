import { describe, expect, it } from "vitest";
import {
  agingBucketOf,
  agingTotals,
  availableMinutes,
  churnOutcome,
  collectionRate,
  comparison,
  noShow,
  occupancy,
  previousPeriod,
  ratio,
  reactivatedMembers,
  renewalOutcome,
  uniqueVisits,
  utilization,
  type MembershipRow,
} from "./calc";

const m = (
  id: string,
  memberId: string,
  startDate: string,
  endDate: string,
  status = "EXPIRED",
): MembershipRow => ({ id, memberId, startDate, endDate, status });
const nov = { from: "2026-11-01", to: "2026-12-01" };

describe("periods", () => {
  it("previous period has the same length, ends where this one starts", () => {
    expect(previousPeriod(nov)).toEqual({
      from: "2026-10-02",
      to: "2026-11-01",
    });
    expect(previousPeriod({ from: "2026-11-02", to: "2026-11-09" })).toEqual({
      from: "2026-10-26",
      to: "2026-11-02",
    });
    expect(comparison(120, 100)).toEqual({
      current: 120,
      previous: 100,
      delta: 20,
      pct: 0.2,
    });
    expect(comparison(5, 0).pct).toBeNull();
    expect(ratio(1, 0)).toBeNull();
  });
});

describe("renewals, churn, reactivation", () => {
  const rows = [
    m("a1", "A", "2026-10-01", "2026-11-10"),
    m("a2", "A", "2026-11-11", "2026-12-10", "ACTIVE"), // renewed next day
    m("b1", "B", "2026-10-15", "2026-11-14"), // ended, came back 40 days later (beyond 30 grace)
    m("b2", "B", "2026-12-24", "2027-01-23", "ACTIVE"),
    m("c1", "C", "2026-10-20", "2026-11-19", "CANCELLED"), // cancelled: excluded
    m("d1", "D", "2026-10-25", "2026-11-24"), // ended, never came back
    m("e1", "E", "2026-11-05", "2026-12-04", "ACTIVE"), // ends after the period
  ];
  it("renewal rate: renewed within grace ÷ ended in the period (cancelled excluded)", () => {
    const r = renewalOutcome(rows, nov, 30);
    expect(r.denominator).toBe(3); // a1, b1, d1
    expect(r.numerator).toBe(1); // a1
    expect([...r.renewedIds]).toEqual(["a1"]);
    expect(renewalOutcome(rows, nov, 45).numerator).toBe(2); // b1 counts with a longer grace
  });
  it("churn: last membership ended, nothing within grace; in progress until the window closes", () => {
    expect(churnOutcome(rows, nov, 30, "2026-12-10")).toMatchObject({
      count: 0,
      inProgress: true,
    }); // b1/d1 grace not over
    const later = churnOutcome(rows, nov, 30, "2027-02-01");
    expect(later.memberIds.sort()).toEqual(["B", "D"]);
    expect(later.inProgress).toBe(false);
  });
  it("reactivated: came back after more than the grace period; first-ever is not reactivation", () => {
    expect(
      reactivatedMembers(rows, { from: "2026-12-01", to: "2027-01-01" }, 30),
    ).toEqual(["B"]);
    expect(reactivatedMembers(rows, nov, 30)).toEqual([]); // a2 is a renewal, e1 is new
  });
});

describe("attendance, classes, trainers", () => {
  it("unique visits: one per member per branch per day", () => {
    expect(
      uniqueVisits([
        { memberId: "A", branchId: "X", day: "2026-11-02" },
        { memberId: "A", branchId: "X", day: "2026-11-02" },
        { memberId: "A", branchId: "Y", day: "2026-11-02" },
        { memberId: "B", branchId: "X", day: "2026-11-02" },
        { memberId: "A", branchId: "X", day: "2026-11-03" },
      ]),
    ).toBe(4);
  });
  it("occupancy over held sessions; no-show over expected bookings", () => {
    expect(
      occupancy([
        { capacity: 10, attended: 8, status: "COMPLETED" },
        { capacity: 10, attended: 0, status: "CANCELLED" },
        { capacity: 20, attended: 10, status: "COMPLETED" },
      ]),
    ).toEqual({ numerator: 18, denominator: 30 });
    expect(
      noShow([
        { status: "ATTENDED", lateCancel: false },
        { status: "NO_SHOW", lateCancel: false },
        { status: "CANCELLED", lateCancel: true },
        { status: "CANCELLED", lateCancel: false },
      ]),
    ).toEqual({ numerator: 2, denominator: 3 });
  });
  it("available minutes from weekly slots and exceptions; utilization", () => {
    const slots = [
      {
        kind: "WEEKLY" as const,
        dayOfWeek: 1,
        date: null,
        startMinute: 360,
        endMinute: 720,
        available: true,
      }, // Mon 6–12
      {
        kind: "WEEKLY" as const,
        dayOfWeek: 2,
        date: null,
        startMinute: 360,
        endMinute: 600,
        available: true,
      }, // Tue 6–10
      {
        kind: "EXCEPTION" as const,
        dayOfWeek: null,
        date: "2026-11-03",
        startMinute: 360,
        endMinute: 480,
        available: false,
      }, // Tue off 6–8
    ];
    expect(
      availableMinutes(slots, { from: "2026-11-02", to: "2026-11-09" }),
    ).toBe(360 + 120);
    expect(utilization(240, 480)).toEqual({
      numerator: 240,
      denominator: 480,
      value: 0.5,
    });
  });
});

describe("money", () => {
  it("aging buckets by days past due; not-yet-due isn't overdue", () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(agingBucketOf)).toEqual([
      null,
      "0-30",
      "0-30",
      "31-60",
      "31-60",
      "61-90",
      "61-90",
      "90+",
    ]);
    expect(
      agingTotals(
        [
          { outstandingMinor: 1000, dueDate: "2026-11-10" },
          { outstandingMinor: 500, dueDate: "2026-09-01" },
          { outstandingMinor: 700, dueDate: "2026-11-30" },
          { outstandingMinor: 0, dueDate: "2026-01-01" },
        ],
        "2026-11-20",
      ),
    ).toEqual({
      overdue: 1500,
      totals: { "0-30": 1000, "31-60": 0, "61-90": 500, "90+": 0 },
    });
  });
  it("collection rate uses the same invoice set on both sides; overpayment capped", () => {
    expect(
      collectionRate([
        { totalMinor: 1000, allocatedMinor: 1000 },
        { totalMinor: 2000, allocatedMinor: 500 },
        { totalMinor: 500, allocatedMinor: 900 },
      ]),
    ).toEqual({ numerator: 2000, denominator: 3500 });
  });
});
