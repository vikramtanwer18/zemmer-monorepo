import { inOrder, type TenantTransaction } from "@gym/db";
import { recordAudit, type AuditActor } from "../audit";
import { shouldActivate } from "../memberships/rules";
import { addDays, todayIn, toDbDate } from "../time/dates";

/**
 * After money lands on invoices (same hook as memberships): activates PENDING_PAYMENT PT
 * balances whose invoice meets the activation policy, and grants their sessions.
 */
export async function activatePaidPtBalances(
  tx: TenantTransaction,
  actor: AuditActor & { userId?: string },
  tenantId: string,
  invoiceIds: string[],
  now: Date = new Date(),
): Promise<string[]> {
  if (invoiceIds.length === 0) return [];
  const pending = await tx.ptPackageBalance.findMany({
    where: { invoiceId: { in: invoiceIds }, status: "PENDING_PAYMENT" },
    include: {
      invoice: {
        include: {
          allocations: { where: { reversedAt: null } },
          creditNotes: true,
        },
      },
    },
  });
  if (pending.length === 0) return [];
  const [settings, tenant] = await inOrder([
    tx.tenantSettings.findUnique({ where: { tenantId } }),
    tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
  ]);
  const policy = settings?.membershipActivation ?? "FULL_PAYMENT";
  const today = todayIn(tenant.timezone, now);
  const activated: string[] = [];
  for (const b of pending) {
    const invoice = b.invoice!;
    const paid =
      invoice.allocations.reduce((s, a) => s + Number(a.amountMinor), 0) +
      invoice.creditNotes.reduce((s, c) => s + Number(c.totalMinor), 0);
    if (
      !shouldActivate(policy, {
        totalMinor: Number(invoice.totalMinor),
        paidMinor: paid,
      })
    )
      continue;
    await tx.ptPackageBalance.update({
      where: { id: b.id },
      data: {
        status: "ACTIVE",
        activatedAt: now,
        expiresOn: toDbDate(addDays(today, b.validityDays - 1)),
      },
    });
    await tx.entitlementLedger.createMany({
      data: [
        {
          tenantId,
          memberId: b.memberId,
          kind: "PT_SESSION",
          ptBalanceId: b.id,
          delta: b.sessionsTotal,
          reason: "GRANT",
          createdById: actor.userId ?? null,
        },
      ],
      skipDuplicates: true,
    });
    await recordAudit(tx, actor, {
      action: "pt_package.activated",
      entityType: "PtPackageBalance",
      entityId: b.id,
      branchId: b.branchId,
      meta: { invoice: invoice.number, sessions: b.sessionsTotal, policy },
    });
    activated.push(b.id);
  }
  return activated;
}
