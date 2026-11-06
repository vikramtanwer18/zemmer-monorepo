import type { PrismaClient } from "@gym/db";
import { withTenant, withUser, inOrder } from "@gym/db";
import type { SubscriptionStatusValue, TenantStatusValue } from "../authz";

export type MyTenant = {
  tenantId: string;
  displayName: string;
  status: TenantStatusValue;
};

/** The tenants where this user has an active membership (tenant picker). */
export async function listMyTenants(
  db: PrismaClient,
  userId: string,
): Promise<MyTenant[]> {
  return withUser(db, userId, async (tx) => {
    const memberships = await tx.tenantMembership.findMany({
      where: { userId, status: "ACTIVE" },
      select: {
        tenant: { select: { id: true, displayName: true, status: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return memberships
      .filter((m) => m.tenant.status !== "CANCELLED")
      .map((m) => ({
        tenantId: m.tenant.id,
        displayName: m.tenant.displayName,
        status: m.tenant.status,
      }));
  });
}

export type TenantAccess = {
  membershipId: string;
  roles: { roleKey: string; branchId: string | null }[];
  tenant: {
    id: string;
    displayName: string;
    status: TenantStatusValue;
    timezone: string;
    currency: string;
  };
  subscription: {
    status: SubscriptionStatusValue;
    trialEndsAt: Date | null;
    graceEndsAt: Date | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date | null;
    planName: string;
  } | null;
  require2faForStaff: boolean;
  branches: { id: string; name: string; code: string }[];
  activeSupportSessions: { id: string; expiresAt: Date; reason: string }[];
};

/**
 * Everything needed to build an AuthContext for (user, tenant), or null when the user has no
 * active membership there. Re-run on every request: nothing here is trusted from the client.
 */
export async function loadTenantAccess(
  db: PrismaClient,
  userId: string,
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantAccess | null> {
  return withTenant(
    db,
    tenantId,
    async (tx) => {
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        include: { roles: { select: { roleKey: true, branchId: true } } },
      });
      if (!membership || membership.status !== "ACTIVE") return null;

      const [tenant, subscription, settings, branches, support] = await inOrder(
        [
          tx.tenant.findUnique({ where: { id: tenantId } }),
          tx.tenantSubscription.findUnique({
            where: { tenantId },
            include: { plan: { select: { name: true } } },
          }),
          tx.tenantSettings.findUnique({ where: { tenantId } }),
          tx.branch.findMany({
            where: { status: "ACTIVE" },
            select: { id: true, name: true, code: true },
            orderBy: { createdAt: "asc" },
          }),
          tx.supportSession.findMany({
            where: { tenantId, endedAt: null, expiresAt: { gt: now } },
            select: { id: true, expiresAt: true, reason: true },
          }),
        ],
      );
      if (!tenant) return null;

      return {
        membershipId: membership.id,
        roles: membership.roles,
        tenant: {
          id: tenant.id,
          displayName: tenant.displayName,
          status: tenant.status,
          timezone: tenant.timezone,
          currency: tenant.currency,
        },
        subscription: subscription
          ? {
              status: subscription.status,
              trialEndsAt: subscription.trialEndsAt,
              graceEndsAt: subscription.graceEndsAt,
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
              currentPeriodEnd: subscription.currentPeriodEnd,
              planName: subscription.plan.name,
            }
          : null,
        require2faForStaff: settings?.require2faForStaff ?? false,
        branches,
        activeSupportSessions: support,
      };
    },
    { userId },
  );
}
