import type { AuthContext } from "@gym/core/authz";
import { loadTenantAccess } from "@gym/core/tenancy";
import type { PrismaClient } from "@gym/db";
import { grantsFor } from "./permissions";

/**
 * The AuthContext for a staff user in a tenant, without a browser session (background jobs act
 * as the user who started them). Null if they are no longer an active member of that tenant, so
 * a deactivated user's queued job cannot run.
 */
export async function authContextFor(
  db: PrismaClient,
  userId: string,
  tenantId: string,
): Promise<AuthContext | null> {
  const access = await loadTenantAccess(db, userId, tenantId);
  if (!access) return null;
  return {
    userId,
    tenantId,
    membershipId: access.membershipId,
    grants: grantsFor(access.roles),
    activeBranchId: null,
    tenantStatus: access.tenant.status,
    subscriptionStatus: access.subscription?.status ?? null,
    timezone: access.tenant.timezone,
  };
}
