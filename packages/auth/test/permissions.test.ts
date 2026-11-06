import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PERMISSION_KEYS,
  TENANT_ROLE_KEYS,
  hasPermission,
} from "@gym/core/authz";
import { PLATFORM_PERMISSIONS } from "@gym/core/platform";
import { describe, expect, it } from "vitest";
import { renderPermissionsDoc } from "../src/permissions-doc";
import {
  grantsFor,
  PLATFORM_ROLE_PERMISSIONS,
  platformPermissionsFor,
  ROLE_PERMISSIONS,
} from "../src/permissions";

describe("tenant permission matrix", () => {
  it("matches the reviewed snapshot (every role × every key)", () => {
    const matrix = Object.fromEntries(
      TENANT_ROLE_KEYS.map((role) => [
        role,
        Object.fromEntries(
          PERMISSION_KEYS.map((key) => [
            key,
            ROLE_PERMISSIONS[role].includes(key),
          ]),
        ),
      ]),
    );
    expect(matrix).toMatchSnapshot();
  });

  it("only uses known permission keys", () => {
    for (const role of TENANT_ROLE_KEYS) {
      for (const key of ROLE_PERMISSIONS[role])
        expect(PERMISSION_KEYS).toContain(key);
    }
  });

  it("a receptionist gets no financial configuration (spec §6)", () => {
    const receptionist = ROLE_PERMISSIONS.RECEPTIONIST;
    for (const key of [
      "billing.configure",
      "billing.refund",
      "settings.manage",
      "reports.financial",
    ] as const) {
      expect(receptionist).not.toContain(key);
    }
  });

  it("a trainer does not see payment records (spec §6)", () => {
    for (const key of [
      "billing.view",
      "billing.collect",
      "billing.refund",
      "reports.financial",
    ] as const) {
      expect(ROLE_PERMISSIONS.TRAINER).not.toContain(key);
    }
  });

  it("a trainer sees assigned clients only and runs only their own PT sessions (M3)", () => {
    const trainer = ROLE_PERMISSIONS.TRAINER;
    expect(trainer).toContain("clients.view");
    expect(trainer).toContain("pt.own");
    for (const key of [
      "members.view",
      "pt.manage",
      "bookings.manage",
      "attendance.override",
      "staff.compensation.view",
    ] as const) {
      expect(trainer).not.toContain(key);
    }
  });

  it("pay details and check-in overrides are limited (M3)", () => {
    for (const role of TENANT_ROLE_KEYS) {
      const keys = ROLE_PERMISSIONS[role];
      expect(keys.includes("staff.compensation.view")).toBe(
        role === "GYM_OWNER" || role === "GYM_ADMIN",
      );
    }
    expect(ROLE_PERMISSIONS.RECEPTIONIST).toContain("attendance.scan");
    expect(ROLE_PERMISSIONS.RECEPTIONIST).not.toContain("attendance.override");
    expect(ROLE_PERMISSIONS.RECEPTIONIST).not.toContain("attendance.correct");
  });

  it("only the owner manages the SaaS subscription or grants owner/admin roles", () => {
    for (const role of TENANT_ROLE_KEYS) {
      const keys = ROLE_PERMISSIONS[role];
      const isOwner = role === "GYM_OWNER";
      expect(keys.includes("subscription.manage")).toBe(isOwner);
      expect(keys.includes("staff.assign_owner")).toBe(isOwner);
      expect(keys.includes("staff.assign_admin")).toBe(isOwner);
    }
  });

  it("no tenant role holds a platform permission (separate realms)", () => {
    const platformKeys = Object.keys(PLATFORM_PERMISSIONS);
    for (const role of TENANT_ROLE_KEYS) {
      for (const key of ROLE_PERMISSIONS[role])
        expect(platformKeys).not.toContain(key);
    }
  });

  it("members only get the member app", () => {
    expect(ROLE_PERMISSIONS.MEMBER).toEqual(["member.self"]);
  });

  it("grantsFor keeps branch scope and ignores unknown roles", () => {
    const grants = grantsFor([
      { roleKey: "RECEPTIONIST", branchId: "b1" },
      { roleKey: "MADE_UP", branchId: null },
    ]);
    expect(grants[1]?.permissions.size).toBe(0);
    expect(
      hasPermission({ grants }, "attendance.scan", { branchId: "b1" }),
    ).toBe(true);
    expect(
      hasPermission({ grants }, "attendance.scan", { branchId: "b2" }),
    ).toBe(false);
  });
});

describe("platform permission matrix", () => {
  it("support can view, open support sessions and see billing/system health; no changes", () => {
    expect([...platformPermissionsFor("SUPPORT")].sort()).toEqual(
      [
        "platform.support.access",
        "platform.tenants.view",
        "platform.billing.view",
        "platform.system.view",
      ].sort(),
    );
  });

  it("only owners and administrators connect the gym's payment account (M4)", () => {
    for (const role of TENANT_ROLE_KEYS) {
      expect(ROLE_PERMISSIONS[role].includes("settings.payments")).toBe(
        role === "GYM_OWNER" || role === "GYM_ADMIN",
      );
    }
  });

  it("super admin holds every platform permission", () => {
    expect([...PLATFORM_ROLE_PERMISSIONS.SUPER_ADMIN].sort()).toEqual(
      Object.keys(PLATFORM_PERMISSIONS).sort(),
    );
  });
});

describe("docs/PERMISSIONS.md", () => {
  it("is up to date (run `pnpm docs:permissions`)", () => {
    const doc = readFileSync(
      path.resolve(import.meta.dirname, "../../../docs/PERMISSIONS.md"),
      "utf8",
    );
    expect(doc).toBe(renderPermissionsDoc());
  });
});
