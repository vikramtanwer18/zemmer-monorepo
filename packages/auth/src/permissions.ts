import {
  PERMISSION_KEYS,
  type Grant,
  type PermissionKey,
  type TenantRoleKey,
} from "@gym/core/authz";
import type { PlatformPermissionKey } from "@gym/core/platform";

/**
 * The fixed role → permission matrix (D-07). Code checks permission keys, never role names.
 * docs/PERMISSIONS.md is generated from this file: `pnpm --filter @gym/auth docs:permissions`.
 *
 * Spec §6: a receptionist gets no financial configuration, a trainer no payment records, and no
 * tenant role reaches platform administration (those keys live in a separate realm).
 */
const OWNER: readonly PermissionKey[] = PERMISSION_KEYS.filter(
  (k) => k !== "member.self",
);

const ADMIN: readonly PermissionKey[] = OWNER.filter(
  (k) =>
    k !== "subscription.manage" &&
    k !== "staff.assign_owner" &&
    k !== "staff.assign_admin",
);

export const ROLE_PERMISSIONS: Record<TenantRoleKey, readonly PermissionKey[]> =
  {
    GYM_OWNER: OWNER,
    GYM_ADMIN: ADMIN,
    BRANCH_MANAGER: [
      "dashboard.view",
      "branches.view",
      "staff.view",
      "staff.invite",
      "staff.manage",
      "settings.view",
      "members.view",
      "members.create",
      "members.edit",
      "members.export",
      "members.notes_private",
      "memberships.view",
      "memberships.sell",
      "memberships.manage",
      "billing.view",
      "billing.collect",
      "billing.refund",
      "billing.void",
      "attendance.view",
      "attendance.scan",
      "attendance.override",
      "attendance.correct",
      "classes.view",
      "classes.manage",
      "classes.attendance",
      "bookings.manage",
      "trainers.assign",
      "pt.manage",
      "leads.view",
      "leads.manage",
      "leads.assign",
      "leads.export",
      "tasks.manage",
      "messaging.send",
      "automations.approve",
      "retention.view",
      "fitness.manage",
      "rewards.fulfil",
      "reports.view",
      "reports.financial",
      "reports.export",
      "ai.use",
      "expenses.manage",
      "pos.sell",
      "inventory.manage",
    ],
    RECEPTIONIST: [
      "dashboard.view",
      "branches.view",
      "members.view",
      "members.create",
      "members.edit",
      "memberships.view",
      "memberships.sell",
      "billing.view",
      "billing.collect",
      "attendance.view",
      "attendance.scan",
      "classes.view",
      "classes.attendance",
      "bookings.manage",
      "pt.manage",
      "leads.view",
      "leads.manage",
      "tasks.manage",
      "pos.sell",
      "rewards.fulfil",
    ],
    SALES_STAFF: [
      "dashboard.view",
      "members.view",
      "members.create",
      "memberships.view",
      "memberships.sell",
      "billing.collect",
      "classes.view",
      "leads.view",
      "leads.manage",
      "tasks.manage",
      "messaging.send",
      "retention.view",
    ],
    // M3: trainers see their assigned clients only (clients.view), never the full member list or
    // payments; they run their own PT sessions (pt.own) and mark class attendance.
    TRAINER: [
      "dashboard.view",
      "attendance.view",
      "classes.view",
      "classes.attendance",
      "clients.view",
      "pt.own",
      "fitness.manage",
    ],
    ACCOUNTANT: [
      "dashboard.view",
      "branches.view",
      "members.view",
      "memberships.view",
      "billing.view",
      "billing.collect",
      "billing.refund",
      "billing.void",
      "reports.view",
      "reports.financial",
      "reports.export",
      "expenses.manage",
    ],
    MEMBER: ["member.self"],
  };

/** Turns stored role assignments into grants. Unknown role keys grant nothing. */
export function grantsFor(
  roles: readonly { roleKey: string; branchId: string | null }[],
): Grant[] {
  return roles.map((role) => ({
    roleKey: role.roleKey,
    branchId: role.branchId,
    permissions: new Set(
      (
        ROLE_PERMISSIONS as Record<string, readonly PermissionKey[] | undefined>
      )[role.roleKey] ?? [],
    ),
  }));
}

export const PLATFORM_ROLE_PERMISSIONS: Record<
  "SUPER_ADMIN" | "SUPPORT",
  readonly PlatformPermissionKey[]
> = {
  SUPER_ADMIN: [
    "platform.tenants.view",
    "platform.tenants.manage",
    "platform.plans.manage",
    "platform.settings.manage",
    "platform.audit.view",
    "platform.support.access",
    "platform.billing.view",
    "platform.billing.manage",
    "platform.announcements.manage",
    "platform.system.view",
  ],
  SUPPORT: [
    "platform.tenants.view",
    "platform.support.access",
    "platform.billing.view",
    "platform.system.view",
  ],
};

export function platformPermissionsFor(
  role: "SUPER_ADMIN" | "SUPPORT",
): Set<PlatformPermissionKey> {
  return new Set(PLATFORM_ROLE_PERMISSIONS[role]);
}
