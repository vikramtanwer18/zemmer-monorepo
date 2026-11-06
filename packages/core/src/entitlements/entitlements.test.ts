import { describe, expect, it } from "vitest";
import { isAppError } from "../errors";
import {
  checkEntitlement,
  evaluateEntitlements,
  evaluateQuota,
  isFeatureEnabled,
  quotaLimit,
  type EntitlementInputs,
} from "./index";

const now = new Date("2026-11-02T10:00:00Z");
const base: EntitlementInputs = {
  features: [
    { key: "branches.max", defaultValue: 1 },
    { key: "crm.enabled", defaultValue: false },
    { key: "classes.enabled", defaultValue: false },
  ],
  plan: {
    code: "growth",
    version: 1,
    values: [
      { featureKey: "branches.max", value: 3 },
      { featureKey: "crm.enabled", value: true },
    ],
  },
  overrides: [],
  now,
};

describe("evaluateEntitlements", () => {
  it("plan values replace catalog defaults; unlisted features keep defaults", () => {
    const ent = evaluateEntitlements(base);
    expect(ent.values).toEqual({
      "branches.max": 3,
      "crm.enabled": true,
      "classes.enabled": false,
    });
    expect(ent.planCode).toBe("growth");
  });

  it("an unexpired override wins over the plan", () => {
    const ent = evaluateEntitlements({
      ...base,
      overrides: [
        {
          featureKey: "branches.max",
          value: 10,
          expiresAt: new Date("2026-12-01T00:00:00Z"),
          createdAt: now,
        },
      ],
    });
    expect(quotaLimit(ent, "branches.max")).toBe(10);
    expect(ent.nextChangeAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("an expired override is ignored", () => {
    const ent = evaluateEntitlements({
      ...base,
      overrides: [
        {
          featureKey: "branches.max",
          value: 10,
          expiresAt: new Date("2026-11-01T00:00:00Z"),
          createdAt: now,
        },
      ],
    });
    expect(quotaLimit(ent, "branches.max")).toBe(3);
  });

  it("the newest override wins when several apply", () => {
    const ent = evaluateEntitlements({
      ...base,
      overrides: [
        {
          featureKey: "classes.enabled",
          value: true,
          expiresAt: null,
          createdAt: new Date("2026-10-01"),
        },
        {
          featureKey: "classes.enabled",
          value: false,
          expiresAt: null,
          createdAt: new Date("2026-10-05"),
        },
      ],
    });
    expect(isFeatureEnabled(ent, "classes.enabled")).toBe(false);
  });

  it("no subscription means catalog defaults", () => {
    const ent = evaluateEntitlements({ ...base, plan: null });
    expect(quotaLimit(ent, "branches.max")).toBe(1);
    expect(ent.planCode).toBeNull();
  });
});

describe("quotas", () => {
  it("null is unlimited", () => {
    expect(evaluateQuota(null, 1_000_000, 1).allowed).toBe(true);
  });

  it("allows up to and including the limit", () => {
    expect(evaluateQuota(3, 2, 1).allowed).toBe(true);
    expect(evaluateQuota(3, 3, 1).allowed).toBe(false);
    expect(evaluateQuota(3, 3, 0).allowed).toBe(true);
  });

  it("a missing or malformed limit fails closed (0)", () => {
    const ent = evaluateEntitlements({ ...base, features: [], plan: null });
    expect(quotaLimit(ent, "staff.max")).toBe(0);
    const bad = evaluateEntitlements({
      ...base,
      plan: {
        code: "x",
        version: 1,
        values: [{ featureKey: "staff.max", value: "lots" }],
      },
    });
    expect(quotaLimit(bad, "staff.max")).toBe(0);
  });
});

describe("checkEntitlement", () => {
  it("throws ENTITLEMENT_REQUIRED (402) for a disabled feature", () => {
    const ent = evaluateEntitlements(base);
    expect(() => checkEntitlement(ent, "crm.enabled")).not.toThrow();
    try {
      checkEntitlement(ent, "classes.enabled");
      expect.unreachable();
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("ENTITLEMENT_REQUIRED");
      expect(isAppError(err) && err.status).toBe(402);
    }
  });
});
