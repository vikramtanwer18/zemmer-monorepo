import { describe, expect, it } from "vitest";
import type { AuthContext, PermissionKey } from "../authz";
import { narrowScope, presetPeriod, resolveScope } from "./scope";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const NOW = { now: () => new Date("2026-11-06T04:30:00Z") }; // 10:00 IST, Friday

function ctx(
  grants: { branchId: string | null; permissions: PermissionKey[] }[],
  activeBranchId: string | null = null,
): AuthContext {
  return {
    userId: "u",
    tenantId: "t-from-context",
    membershipId: "m",
    grants: grants.map((g) => ({
      roleKey: "X",
      branchId: g.branchId,
      permissions: new Set(g.permissions),
    })),
    activeBranchId,
    tenantStatus: "ACTIVE",
    subscriptionStatus: "ACTIVE",
    timezone: "Asia/Kolkata",
  };
}

describe("period presets (half-open, tenant calendar)", () => {
  it("resolves presets around Friday 6 Nov 2026", () => {
    const today = "2026-11-06";
    expect(presetPeriod("today", today)).toEqual({
      from: "2026-11-06",
      to: "2026-11-07",
    });
    expect(presetPeriod("this_week", today)).toEqual({
      from: "2026-11-02",
      to: "2026-11-07",
    });
    expect(presetPeriod("last_week", today)).toEqual({
      from: "2026-10-26",
      to: "2026-11-02",
    });
    expect(presetPeriod("this_month", today)).toEqual({
      from: "2026-11-01",
      to: "2026-11-07",
    });
    expect(presetPeriod("last_month", today)).toEqual({
      from: "2026-10-01",
      to: "2026-11-01",
    });
    expect(presetPeriod("last_30_days", today)).toEqual({
      from: "2026-10-08",
      to: "2026-11-07",
    });
    expect(presetPeriod("this_year", today)).toEqual({
      from: "2026-01-01",
      to: "2026-11-07",
    });
  });
});

describe("resolveScope", () => {
  const owner = ctx([
    { branchId: null, permissions: ["reports.view", "reports.financial"] },
  ]);
  const manager = ctx([
    { branchId: A, permissions: ["reports.view", "reports.financial"] },
    { branchId: B, permissions: ["reports.view"] },
  ]);

  it("takes the tenant from the context, never from input", () => {
    const s = resolveScope(
      NOW,
      owner,
      { tenantId: "someone-else", preset: "today" },
      "reports.view",
    );
    expect(s.tenantId).toBe("t-from-context");
    expect(s.branchIds).toBeNull();
  });
  it("owner: all branches, a chosen one, or several", () => {
    expect(
      resolveScope(NOW, owner, { branchId: "all" }, "reports.view").branchIds,
    ).toBeNull();
    expect(
      resolveScope(NOW, owner, { branchId: C }, "reports.view").branchIds,
    ).toEqual([C]);
    expect(
      resolveScope(NOW, owner, { branchIds: [A, B, A] }, "reports.view")
        .branchIds,
    ).toEqual([A, B]);
  });
  it("branch manager: own branches by default; another branch is forbidden", () => {
    expect(resolveScope(NOW, manager, {}, "reports.view").branchIds).toEqual([
      A,
      B,
    ]);
    expect(
      resolveScope(NOW, manager, { branchId: "all" }, "reports.view").branchIds,
    ).toEqual([A, B]);
    expect(
      resolveScope(NOW, manager, { branchId: B }, "reports.view").branchIds,
    ).toEqual([B]);
    expect(() =>
      resolveScope(NOW, manager, { branchId: C }, "reports.view"),
    ).toThrow(/can't see that branch/);
    expect(() =>
      resolveScope(NOW, manager, { branchIds: [A, C] }, "reports.view"),
    ).toThrow(/can't see that branch/);
    // Money narrows to the branches with reports.financial.
    const s = resolveScope(NOW, manager, {}, "reports.view");
    expect(narrowScope(manager, s, "reports.financial")?.branchIds).toEqual([
      A,
    ]);
    expect(
      narrowScope(manager, { ...s, branchIds: [B] }, "reports.financial"),
    ).toBeNull();
  });
  it("validates dates and length; defaults to this month", () => {
    expect(resolveScope(NOW, owner, {}, "reports.view").period).toEqual({
      from: "2026-11-01",
      to: "2026-11-07",
    });
    expect(
      resolveScope(
        NOW,
        owner,
        { from: "2026-10-01", to: "2026-10-15" },
        "reports.view",
      ).period,
    ).toEqual({ from: "2026-10-01", to: "2026-10-15" });
    expect(() =>
      resolveScope(
        NOW,
        owner,
        { from: "2026-10-15", to: "2026-10-01" },
        "reports.view",
      ),
    ).toThrow(/after the start/);
    expect(() =>
      resolveScope(
        NOW,
        owner,
        { from: "2020-01-01", to: "2026-10-01" },
        "reports.view",
      ),
    ).toThrow(/two years/);
    expect(() =>
      resolveScope(NOW, owner, { from: "31/10/2026" }, "reports.view"),
    ).toThrow();
  });
  it("needs the permission", () => {
    expect(() =>
      resolveScope(
        NOW,
        ctx([{ branchId: null, permissions: ["dashboard.view"] }]),
        {},
        "reports.view",
      ),
    ).toThrow(/permission/);
  });
});
