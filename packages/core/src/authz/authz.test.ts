import { describe, expect, it } from "vitest";
import { redactForAudit } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  isTenantWritable,
  mfaRequirement,
  permissionSet,
  requirePermission,
  type Grant,
  type PermissionKey,
} from "./index";

const grant = (
  roleKey: string,
  branchId: string | null,
  keys: PermissionKey[],
): Grant => ({
  roleKey,
  branchId,
  permissions: new Set(keys),
});

const BRANCH_A = "00000000-0000-4000-8000-00000000000a";
const BRANCH_B = "00000000-0000-4000-8000-00000000000b";

describe("permission checks", () => {
  const manager = {
    grants: [
      grant("BRANCH_MANAGER", BRANCH_A, [
        "members.view",
        "staff.invite",
        "settings.manage",
      ]),
    ],
  };

  it("a branch role grants branch-scoped keys for its branch only", () => {
    expect(hasPermission(manager, "members.view", { branchId: BRANCH_A })).toBe(
      true,
    );
    expect(hasPermission(manager, "members.view", { branchId: BRANCH_B })).toBe(
      false,
    );
  });

  it("a branch role never grants tenant-scoped keys", () => {
    expect(hasPermission(manager, "settings.manage")).toBe(false);
    expect(permissionSet(manager).has("settings.manage")).toBe(false);
  });

  it("an all-branch role grants everywhere", () => {
    const admin = {
      grants: [grant("GYM_ADMIN", null, ["members.view", "settings.manage"])],
    };
    expect(hasPermission(admin, "members.view", { branchId: BRANCH_B })).toBe(
      true,
    );
    expect(hasPermission(admin, "settings.manage")).toBe(true);
    expect(allowedBranchIds(admin, "members.view")).toBe("ALL");
  });

  it("lists the branches where a key is granted", () => {
    const twoBranches = {
      grants: [
        grant("RECEPTIONIST", BRANCH_A, ["members.view"]),
        grant("TRAINER", BRANCH_B, ["members.view"]),
      ],
    };
    expect(allowedBranchIds(twoBranches, "members.view")).toEqual([
      BRANCH_A,
      BRANCH_B,
    ]);
    expect(allowedBranchIds(twoBranches, "staff.view")).toEqual([]);
  });

  it("requirePermission throws FORBIDDEN (403)", () => {
    expect(() => requirePermission(manager, "billing.refund")).toThrow(
      expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
    );
  });
});

describe("mfaRequirement (D-03)", () => {
  it("owners and administrators always need the code, without trusted devices", () => {
    expect(mfaRequirement(["GYM_OWNER"], false)).toEqual({
      required: true,
      trustedDeviceAllowed: false,
    });
    expect(mfaRequirement(["GYM_ADMIN", "MEMBER"], false)).toEqual({
      required: true,
      trustedDeviceAllowed: false,
    });
  });

  it("other staff need it only when the gym requires it, and may trust a device", () => {
    expect(mfaRequirement(["RECEPTIONIST"], false).required).toBe(false);
    expect(mfaRequirement(["RECEPTIONIST"], true)).toEqual({
      required: true,
      trustedDeviceAllowed: true,
    });
  });

  it("members are not forced", () => {
    expect(mfaRequirement(["MEMBER"], true).required).toBe(false);
  });
});

describe("tenant writability", () => {
  it.each([
    ["ACTIVE", "TRIALING", true],
    ["ACTIVE", "GRACE", true],
    ["ACTIVE", "PAST_DUE", true],
    ["ACTIVE", "SUSPENDED", false],
    ["ACTIVE", "CANCELLED", false],
    ["SUSPENDED", "ACTIVE", false],
    ["PENDING_APPROVAL", "TRIALING", false],
  ] as const)(
    "tenant %s + subscription %s → writable %s",
    (tenantStatus, subscriptionStatus, expected) => {
      expect(isTenantWritable({ tenantStatus, subscriptionStatus })).toBe(
        expected,
      );
    },
  );
});

describe("audit redaction", () => {
  it("replaces secrets at any depth and keeps the rest", () => {
    const out = redactForAudit({
      email: "a@b.test",
      password: "hunter2",
      nested: { accessToken: "t", keySecret: "s", ok: 1, otp: "123456" },
      list: [{ codeHash: "x", name: "n" }],
      when: new Date("2026-01-01T00:00:00Z"),
      big: 10n,
    });
    expect(out).toEqual({
      email: "a@b.test",
      password: "[REDACTED]",
      nested: {
        accessToken: "[REDACTED]",
        keySecret: "[REDACTED]",
        ok: 1,
        otp: "[REDACTED]",
      },
      list: [{ codeHash: "[REDACTED]", name: "n" }],
      when: "2026-01-01T00:00:00.000Z",
      big: "10",
    });
  });
});
