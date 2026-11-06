import { AppError } from "../errors";

/** Platform realm permission keys. The role matrix is in packages/auth/src/permissions.ts. */
export const PLATFORM_PERMISSIONS = {
  "platform.tenants.view": "See tenants, subscriptions and usage",
  "platform.tenants.manage": "Create, approve, suspend and reactivate tenants",
  "platform.plans.manage": "Edit plans, feature values and tenant overrides",
  "platform.settings.manage": "Change platform settings",
  "platform.audit.view": "Read the platform audit log",
  "platform.support.access": "Open time-boxed, read-only support sessions",
  "platform.billing.view":
    "See SaaS subscriptions, invoices, payments, MRR and usage",
  "platform.billing.manage":
    "Platform payment account, plan prices, trial extensions and comps",
  "platform.announcements.manage": "Publish announcements to gyms",
  "platform.system.view":
    "See system health, queues and failed jobs (and retry them)",
} as const;

export type PlatformPermissionKey = keyof typeof PLATFORM_PERMISSIONS;

export type PlatformContext = {
  platformUserId: string;
  role: "SUPER_ADMIN" | "SUPPORT";
  permissions: ReadonlySet<PlatformPermissionKey>;
  request?: { ip?: string | null; userAgent?: string | null };
};

export function requirePlatformPermission(
  ctx: PlatformContext,
  key: PlatformPermissionKey,
): void {
  if (!ctx.permissions.has(key)) {
    throw new AppError("FORBIDDEN", "You don't have permission to do that.");
  }
}
