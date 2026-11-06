import type { PrismaClient } from "@gym/db";
import { withTenant, withUser } from "@gym/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";

/**
 * A user deactivates their own global account (every gym). Refused while they are the only
 * active owner of a gym. Sessions are deleted, so every device is signed out.
 */
export async function deactivateOwnAccount(
  db: PrismaClient,
  userId: string,
  request?: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  const memberships = await withUser(db, userId, (tx) =>
    tx.tenantMembership.findMany({ where: { userId, status: "ACTIVE" } }),
  );
  for (const membership of memberships) {
    const soleOwner = await withTenant(db, membership.tenantId, async (tx) => {
      const owners = await tx.roleAssignment.findMany({
        where: { roleKey: "GYM_OWNER", membership: { status: "ACTIVE" } },
        select: { membershipId: true },
      });
      const ids = new Set(owners.map((o) => o.membershipId));
      return ids.has(membership.id) && ids.size === 1;
    });
    if (soleOwner) {
      throw new AppError(
        "CONFLICT",
        "You're the only owner of a gym. Add another owner first.",
      );
    }
  }
  const now = new Date();
  for (const membership of memberships) {
    await withTenant(db, membership.tenantId, (tx) =>
      recordAudit(
        tx,
        { userId, tenantId: membership.tenantId, request },
        {
          action: "account.deactivated",
          entityType: "User",
          entityId: userId,
        },
      ),
    );
  }
  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: { status: "DEACTIVATED", deactivatedAt: now },
    }),
    db.session.deleteMany({ where: { userId } }),
    db.trustedDevice.deleteMany({ where: { userId } }),
  ]);
}
