import { AppError } from "../errors";
import { PERMISSIONS, type PermissionKey } from "./permissions";

export * from "./permissions";

export type TenantStatusValue =
  "PENDING_APPROVAL" | "ACTIVE" | "SUSPENDED" | "CANCELLED";

export type SubscriptionStatusValue =
  "TRIALING" | "ACTIVE" | "PAST_DUE" | "GRACE" | "SUSPENDED" | "CANCELLED";

/** Permissions granted by one role assignment. branchId null = every branch. */
export type Grant = {
  roleKey: string;
  branchId: string | null;
  permissions: ReadonlySet<PermissionKey>;
};

/**
 * Who is acting, for which tenant, with what rights. Built from the verified session on every
 * request (packages/auth) and passed explicitly to every core service (D-05).
 */
export type AuthContext = {
  userId: string;
  tenantId: string;
  membershipId: string;
  grants: readonly Grant[];
  /** The branch picked in the header, if any. Always one the user may access. */
  activeBranchId: string | null;
  tenantStatus: TenantStatusValue;
  subscriptionStatus: SubscriptionStatusValue | null;
  timezone: string;
  /** For audit logs. */
  request?: { ip?: string | null; userAgent?: string | null };
};

export function roleKeys(ctx: Pick<AuthContext, "grants">): string[] {
  return [...new Set(ctx.grants.map((g) => g.roleKey))];
}

/** Does any grant give `key` (for `branchId`, if the key is branch-scoped)? */
export function hasPermission(
  ctx: Pick<AuthContext, "grants">,
  key: PermissionKey,
  options: { branchId?: string | null } = {},
): boolean {
  const scope = PERMISSIONS[key].scope;
  return ctx.grants.some((grant) => {
    if (!grant.permissions.has(key)) return false;
    if (grant.branchId === null) return true;
    if (scope === "tenant") return false;
    // Branch-scoped key with no branch named: "can do this somewhere". Lists must then be
    // filtered with allowedBranchIds().
    if (options.branchId === undefined || options.branchId === null)
      return true;
    return grant.branchId === options.branchId;
  });
}

/** Throws FORBIDDEN unless the context holds `key` (for `branchId`, when given). */
export function requirePermission(
  ctx: Pick<AuthContext, "grants">,
  key: PermissionKey,
  options: { branchId?: string | null } = {},
): void {
  if (!hasPermission(ctx, key, options)) {
    throw new AppError("FORBIDDEN", "You don't have permission to do that.");
  }
}

/** "ALL", or the branch ids where `key` is granted. */
export function allowedBranchIds(
  ctx: Pick<AuthContext, "grants">,
  key: PermissionKey,
): "ALL" | string[] {
  const ids = new Set<string>();
  for (const grant of ctx.grants) {
    if (!grant.permissions.has(key)) continue;
    if (grant.branchId === null) return "ALL";
    ids.add(grant.branchId);
  }
  return [...ids];
}

/** Every permission the context holds anywhere (for filtering navigation; never for security). */
export function permissionSet(
  ctx: Pick<AuthContext, "grants">,
): Set<PermissionKey> {
  const out = new Set<PermissionKey>();
  for (const grant of ctx.grants) {
    for (const key of grant.permissions) {
      if (PERMISSIONS[key].scope === "tenant" && grant.branchId !== null)
        continue;
      out.add(key);
    }
  }
  return out;
}

const READ_ONLY_SUBSCRIPTION: ReadonlySet<SubscriptionStatusValue> = new Set([
  "SUSPENDED",
  "CANCELLED",
]);

/** Suspended or cancelled tenants are read-only (data is never deleted). */
export function isTenantWritable(
  ctx: Pick<AuthContext, "tenantStatus" | "subscriptionStatus">,
): boolean {
  if (ctx.tenantStatus !== "ACTIVE") return false;
  return !(
    ctx.subscriptionStatus && READ_ONLY_SUBSCRIPTION.has(ctx.subscriptionStatus)
  );
}

export function requireWritableTenant(
  ctx: Pick<AuthContext, "tenantStatus" | "subscriptionStatus">,
): void {
  if (!isTenantWritable(ctx)) {
    throw new AppError(
      "SUBSCRIPTION_INACTIVE",
      ctx.tenantStatus === "PENDING_APPROVAL"
        ? "Your gym is waiting for approval."
        : "Your subscription is not active, so changes are disabled. Your data is safe.",
    );
  }
}

export * from "./roles";
