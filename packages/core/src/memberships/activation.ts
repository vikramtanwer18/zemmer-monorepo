import type { TenantTransaction } from "@gym/db";
import { recordAudit, type AuditActor } from "../audit";
import { markLeadWonTx } from "../crm/conversion";
import { emitEvent } from "../events";
import { notify } from "../notifications";
import { activatePaidPtBalances } from "../staff/pt-activation";
import { fromDbDate } from "../time/dates";
import { shouldActivate } from "./rules";

/**
 * After money lands on invoices: activates PENDING_PAYMENT memberships whose invoice now meets
 * the tenant's activation policy. Runs in the caller's transaction (payment + allocation +
 * activation commit together or not at all).
 */
export async function activatePaidMemberships(
  tx: TenantTransaction,
  actor: AuditActor & { userId?: string },
  tenantId: string,
  invoiceIds: string[],
): Promise<string[]> {
  if (invoiceIds.length === 0) return [];
  // M3: PT packages sold on these invoices activate under the same policy.
  await activatePaidPtBalances(tx, actor, tenantId, invoiceIds);
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId } });
  const policy = settings?.membershipActivation ?? "FULL_PAYMENT";
  const invoices = await tx.gymInvoice.findMany({
    where: { id: { in: invoiceIds }, membershipId: { not: null } },
    include: {
      allocations: { where: { reversedAt: null } },
      creditNotes: true,
      membership: { include: { plan: true, member: true } },
    },
  });
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const activated: string[] = [];
  for (const invoice of invoices) {
    const membership = invoice.membership;
    if (!membership || membership.status !== "PENDING_PAYMENT") continue;
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
    const now = new Date();
    await tx.membership.update({
      where: { id: membership.id },
      data: { status: "ACTIVE", activatedAt: now },
    });
    await tx.membershipEvent.create({
      data: {
        tenantId,
        membershipId: membership.id,
        type: "ACTIVATED",
        fromStatus: "PENDING_PAYMENT",
        toStatus: "ACTIVE",
        data: { invoiceId: invoice.id, policy },
        actorUserId: actor.userId ?? null,
      },
    });
    await recordAudit(tx, actor, {
      action: "membership.activated",
      entityType: "Membership",
      entityId: membership.id,
      branchId: membership.branchId,
      meta: { invoice: invoice.number, policy },
    });
    // M6: automation trigger ("membership purchased/renewed").
    await emitEvent(tx, tenantId, "membership.activated", {
      membershipId: membership.id,
      memberId: membership.memberId,
      planId: membership.planId,
      branchId: membership.branchId,
      amountMinor: Number(invoice.totalMinor),
      renewal: membership.renewedFromId !== null,
    });
    await notify(tx, tenantId, {
      templateKey: "membership.activated",
      recipient: {
        memberId: membership.memberId,
        userId: membership.member.userId,
        email: membership.member.email,
      },
      data: {
        name: membership.member.firstName,
        gym: tenant.displayName,
        plan: membership.plan.name,
        start: fromDbDate(membership.startDate),
        end: fromDbDate(membership.endDate),
      },
      link: "/m/",
      dedupeKey: `activated:${membership.id}`,
    });
    // M5: a membership sold from a lead wins the lead, in this same transaction.
    await markLeadWonTx(tx, actor, tenantId, membership);
    activated.push(membership.id);
  }
  return activated;
}
