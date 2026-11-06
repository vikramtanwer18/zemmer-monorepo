import { describe, expect, it } from "vitest";
import { addMonths, diffDays, startOfDayUtc, todayIn } from "../time/dates";
import {
  applyCoupon,
  canTransition,
  checkFreeze,
  endDateFor,
  freezeDaysUsed,
  isPastGrace,
  nextState,
  overlaps,
  renewalStart,
  shouldActivate,
  type CouponInput,
  type MembershipAction,
  type MembershipStateValue,
} from "./rules";

const STATES: MembershipStateValue[] = [
  "PENDING_PAYMENT",
  "ACTIVE",
  "PAUSED",
  "EXPIRED",
  "CANCELLED",
];
const ACTIONS: MembershipAction[] = [
  "activate",
  "freeze",
  "unfreeze",
  "extend",
  "cancel",
  "expire",
  "renew",
];

describe("membership state machine", () => {
  it("matches the reviewed transition table (every action × every state)", () => {
    const table = Object.fromEntries(
      ACTIONS.map((a) => [
        a,
        Object.fromEntries(
          STATES.map((s) => [s, canTransition(a, s) ? nextState(a, s) : null]),
        ),
      ]),
    );
    expect(table).toEqual({
      activate: {
        PENDING_PAYMENT: "ACTIVE",
        ACTIVE: null,
        PAUSED: null,
        EXPIRED: null,
        CANCELLED: null,
      },
      freeze: {
        PENDING_PAYMENT: null,
        ACTIVE: "PAUSED",
        PAUSED: null,
        EXPIRED: null,
        CANCELLED: null,
      },
      unfreeze: {
        PENDING_PAYMENT: null,
        ACTIVE: null,
        PAUSED: "ACTIVE",
        EXPIRED: null,
        CANCELLED: null,
      },
      extend: {
        PENDING_PAYMENT: "PENDING_PAYMENT",
        ACTIVE: "ACTIVE",
        PAUSED: "PAUSED",
        EXPIRED: null,
        CANCELLED: null,
      },
      cancel: {
        PENDING_PAYMENT: "CANCELLED",
        ACTIVE: "CANCELLED",
        PAUSED: "CANCELLED",
        EXPIRED: null,
        CANCELLED: null,
      },
      expire: {
        PENDING_PAYMENT: null,
        ACTIVE: "EXPIRED",
        PAUSED: null,
        EXPIRED: null,
        CANCELLED: null,
      },
      renew: {
        PENDING_PAYMENT: null,
        ACTIVE: "ACTIVE",
        PAUSED: "PAUSED",
        EXPIRED: "EXPIRED",
        CANCELLED: null,
      },
    });
  });

  it("throws a readable error for an invalid transition", () => {
    expect(() => nextState("freeze", "EXPIRED")).toThrow(
      "Cannot freeze a membership that is expired.",
    );
    expect(() => nextState("activate", "CANCELLED")).toThrow(/Cannot activate/);
  });
});

describe("dates", () => {
  it("computes inclusive end dates", () => {
    expect(endDateFor("2026-01-15", { unit: "MONTH", count: 1 })).toBe(
      "2026-02-14",
    );
    expect(endDateFor("2026-01-01", { unit: "YEAR", count: 1 })).toBe(
      "2026-12-31",
    );
    expect(endDateFor("2026-01-01", { unit: "DAY", count: 1 })).toBe(
      "2026-01-01",
    );
    // Short target month: end on its last day rather than losing days.
    expect(endDateFor("2026-01-31", { unit: "MONTH", count: 1 })).toBe(
      "2026-02-28",
    );
    expect(endDateFor("2028-01-30", { unit: "MONTH", count: 1 })).toBe(
      "2028-02-29",
    );
    expect(endDateFor("2026-01-28", { unit: "MONTH", count: 1 })).toBe(
      "2026-02-27",
    );
    expect(endDateFor("2026-01-01", { unit: "DAY", count: 30 })).toBe(
      "2026-01-30",
    );
  });

  it("clamps month arithmetic to the month's last day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
  });

  it("starts a renewal the day after the end, or today if already ended", () => {
    expect(renewalStart("2026-02-14", "2026-02-10")).toBe("2026-02-15");
    expect(renewalStart("2026-02-14", "2026-03-01")).toBe("2026-03-01");
  });

  it("detects overlapping ranges, inclusive", () => {
    expect(
      overlaps(
        { start: "2026-01-01", end: "2026-01-31" },
        { start: "2026-01-31", end: "2026-02-28" },
      ),
    ).toBe(true);
    expect(
      overlaps(
        { start: "2026-01-01", end: "2026-01-31" },
        { start: "2026-02-01", end: "2026-02-28" },
      ),
    ).toBe(false);
  });

  it("applies grace days before access ends", () => {
    expect(isPastGrace("2026-02-14", 0, "2026-02-14")).toBe(false);
    expect(isPastGrace("2026-02-14", 0, "2026-02-15")).toBe(true);
    expect(isPastGrace("2026-02-14", 3, "2026-02-17")).toBe(false);
    expect(isPastGrace("2026-02-14", 3, "2026-02-18")).toBe(true);
  });

  it("'today' depends on the tenant timezone", () => {
    // 20:00 UTC on 2 Nov = 01:30 on 3 Nov in India, still 2 Nov in New York.
    const instant = new Date("2026-11-02T20:00:00Z");
    expect(todayIn("Asia/Kolkata", instant)).toBe("2026-11-03");
    expect(todayIn("America/New_York", instant)).toBe("2026-11-02");
  });

  it("finds the UTC start of a local day, including DST zones", () => {
    expect(startOfDayUtc("2026-11-03", "Asia/Kolkata").toISOString()).toBe(
      "2026-11-02T18:30:00.000Z",
    );
    expect(startOfDayUtc("2026-07-01", "America/New_York").toISOString()).toBe(
      "2026-07-01T04:00:00.000Z",
    );
    expect(startOfDayUtc("2026-12-01", "America/New_York").toISOString()).toBe(
      "2026-12-01T05:00:00.000Z",
    );
    expect(diffDays("2026-01-01", "2026-03-01")).toBe(59);
  });
});

describe("activation policy", () => {
  it.each([
    ["FULL_PAYMENT", 0, false],
    ["FULL_PAYMENT", 5_000, false],
    ["FULL_PAYMENT", 10_000, true],
    ["ANY_PAYMENT", 0, false],
    ["ANY_PAYMENT", 1, true],
    ["IMMEDIATE", 0, true],
  ] as const)("%s with %i of 10000 paid → %s", (policy, paid, expected) => {
    expect(
      shouldActivate(policy, { totalMinor: 10_000, paidMinor: paid }),
    ).toBe(expected);
  });

  it("a free invoice activates under any policy", () => {
    expect(shouldActivate("ANY_PAYMENT", { totalMinor: 0, paidMinor: 0 })).toBe(
      true,
    );
    expect(
      shouldActivate("FULL_PAYMENT", { totalMinor: 0, paidMinor: 0 }),
    ).toBe(true);
  });
});

describe("freeze rules", () => {
  const membership = { startDate: "2026-01-01", endDate: "2026-06-30" };
  const rules = { maxDays: 30, maxTimes: 2 };

  it("allows a freeze within the limits", () => {
    expect(
      checkFreeze(
        rules,
        { frozenDays: 0, freezeCount: 0 },
        { start: "2026-02-01", days: 10 },
        membership,
        "2026-01-20",
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    [
      { maxDays: 0, maxTimes: 0 },
      { frozenDays: 0, freezeCount: 0 },
      { start: "2026-02-01", days: 5 },
      /can't be frozen/,
    ],
    [
      rules,
      { frozenDays: 0, freezeCount: 2 },
      { start: "2026-02-01", days: 5 },
      /all used/,
    ],
    [
      rules,
      { frozenDays: 25, freezeCount: 1 },
      { start: "2026-02-01", days: 10 },
      /Only 5 freeze days left/,
    ],
    [
      rules,
      { frozenDays: 0, freezeCount: 0 },
      { start: "2026-01-10", days: 5 },
      /in the past/,
    ],
    [
      rules,
      { frozenDays: 0, freezeCount: 0 },
      { start: "2026-07-05", days: 5 },
      /while the membership runs/,
    ],
    [
      rules,
      { frozenDays: 0, freezeCount: 0 },
      { start: "2026-02-01", days: 0 },
      /at least 1 day/,
    ],
  ])("refuses %#", (r, used, request, reason) => {
    const result = checkFreeze(r, used, request, membership, "2026-01-20");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(reason);
  });

  it("counts only the days actually frozen when unfreezing early", () => {
    expect(freezeDaysUsed("2026-02-01", "2026-02-04", 10)).toBe(3);
    expect(freezeDaysUsed("2026-02-01", "2026-03-01", 10)).toBe(10);
    expect(freezeDaysUsed("2026-02-01", "2026-02-01", 10)).toBe(0);
  });
});

describe("coupons", () => {
  const base: CouponInput = {
    kind: "PERCENT",
    value: 1000,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    maxRedemptions: 10,
    redemptions: 0,
    planCodes: [],
    status: "ACTIVE",
  };

  it("takes a percentage off the plan price, rounded half-up", () => {
    expect(applyCoupon(base, "monthly", 99_999, "2026-06-01")).toEqual({
      ok: true,
      discountMinor: 10_000,
    });
  });

  it("takes a flat amount, never more than the price", () => {
    expect(
      applyCoupon(
        { ...base, kind: "FLAT", value: 50_000 },
        "monthly",
        30_000,
        "2026-06-01",
      ),
    ).toEqual({ ok: true, discountMinor: 30_000 });
  });

  it.each([
    [{ status: "ARCHIVED" as const }, "2026-06-01", /no longer active/],
    [{}, "2025-12-31", /isn't valid yet/],
    [{}, "2027-01-01", /expired/],
    [{ redemptions: 10 }, "2026-06-01", /used up/],
    [{ planCodes: ["annual"] }, "2026-06-01", /doesn't apply/],
  ])("refuses %#", (overrides, today, reason) => {
    const result = applyCoupon(
      { ...base, ...overrides },
      "monthly",
      100_000,
      today,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(reason);
  });
});
