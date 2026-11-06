import type { TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit, type AuditActor } from "../audit";
import { hasPermission, requirePermission, type AuthContext } from "../authz";
import { AppError } from "../errors";
import { emitEvent } from "../events";
import { createMemberTx } from "../members/service";
import { guard, inTenant, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";
import { leadName, moveToStageTx } from "./leads";
import { crmGuard, stageFor } from "./setup";

/**
 * Step 1 of "Convert to member": a member record from the lead (D-04: tenant-scoped profile;
 * the person's app account, if any, links later by email), or link a member found as a
 * duplicate. The lead stays OPEN until a membership sold with this lead is paid (step 2,
 * markLeadWonTx inside the activation transaction).
 */
export async function convertLead(
  deps: CoreDeps,
  ctx: AuthContext,
  leadId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.manage", { write: true });
  const input = parseInput(
    z.object({
      memberId: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.uuid().optional(),
      ),
      confirmDuplicate: z
        .union([z.literal("on"), z.literal(""), z.boolean()])
        .optional()
        .transform((v) => v === "on" || v === true),
    }),
    raw,
  );
  const ent = await guard(deps, ctx, {
    permission: "members.create",
    write: true,
  });
  return inTenant(deps, ctx, async (tx) => {
    const lead = await tx.lead.findUnique({
      where: { id: leadId },
      include: { source: true },
    });
    if (!lead || !hasPermission(ctx, "leads.view", { branchId: lead.branchId }))
      throw new AppError("NOT_FOUND", "Lead not found.");
    requirePermission(ctx, "leads.manage", { branchId: lead.branchId });
    if (lead.status !== "OPEN")
      throw new AppError("CONFLICT", "Only open leads can be converted.");
    if (lead.convertedMemberId)
      return { memberId: lead.convertedMemberId, created: false };
    let memberId: string;
    let created = false;
    if (input.memberId) {
      const member = await tx.memberProfile.findUnique({
        where: { id: input.memberId },
      });
      if (
        !member ||
        member.status === "ARCHIVED" ||
        !hasPermission(ctx, "members.view", { branchId: member.homeBranchId })
      )
        throw new AppError("NOT_FOUND", "Member not found.");
      memberId = member.id;
    } else {
      const member = await createMemberTx(tx, ctx, ent, {
        firstName: lead.firstName,
        lastName: lead.lastName ?? undefined,
        email: lead.email ?? undefined,
        phone: lead.phone ?? undefined,
        homeBranchId: lead.branchId,
        source:
          lead.source?.code === "walk_in"
            ? "WALK_IN"
            : lead.source?.code === "referral"
              ? "REFERRAL"
              : "STAFF",
        marketingEmail: lead.marketingConsent,
        confirmDuplicate: input.confirmDuplicate,
      });
      memberId = member.id;
      created = true;
    }
    await tx.lead.update({
      where: { id: lead.id },
      data: { convertedMemberId: memberId },
    });
    await tx.leadActivity.create({
      data: {
        tenantId: ctx.tenantId,
        leadId: lead.id,
        type: "CONVERSION",
        body: created
          ? "Member record created. Sell a membership to finish."
          : "Linked to an existing member. Sell a membership to finish.",
        meta: { memberId },
        userId: ctx.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: created ? "lead.member_created" : "lead.member_linked",
      entityType: "Lead",
      entityId: lead.id,
      branchId: lead.branchId,
      after: { memberId },
    });
    return { memberId, created };
  });
}

/** Sale-time check: the lead was converted to this member and is still open. */
export async function leadForSaleTx(
  tx: TenantTransaction,
  leadId: string,
  memberId: string,
) {
  const lead = await tx.lead.findUnique({ where: { id: leadId } });
  if (!lead || lead.convertedMemberId !== memberId || lead.status !== "OPEN")
    throw new AppError(
      "VALIDATION_FAILED",
      "This lead can't be linked to this sale. Open it from the lead's 'Convert to member'.",
    );
  return lead;
}

/**
 * Called inside the membership activation transaction: the membership sold from a lead is now
 * paid/active, so the lead is WON with links to member + membership. Idempotent.
 */
export async function markLeadWonTx(
  tx: TenantTransaction,
  actor: AuditActor & { userId?: string | null },
  tenantId: string,
  membership: { id: string; memberId: string; leadId: string | null },
) {
  if (!membership.leadId) return false;
  const lead = await tx.lead.findUnique({ where: { id: membership.leadId } });
  if (!lead || lead.status !== "OPEN") return false;
  const now = new Date();
  await moveToStageTx(
    tx,
    actor,
    tenantId,
    lead,
    await stageFor(tx, tenantId, "WON"),
    {
      reason: "membership paid",
      extra: {
        convertedMemberId: membership.memberId,
        convertedMembershipId: membership.id,
        wonAt: now,
      },
    },
  );
  await tx.followUpTask.updateMany({
    where: { leadId: lead.id, status: "OPEN" },
    data: { status: "DONE", completedAt: now, outcome: "Joined" },
  });
  await tx.leadActivity.create({
    data: {
      tenantId,
      leadId: lead.id,
      type: "CONVERSION",
      body: `${leadName(lead)} joined: membership paid`,
      meta: { memberId: membership.memberId, membershipId: membership.id },
      userId: "system" in actor ? null : (actor.userId ?? null),
    },
  });
  await emitEvent(tx, tenantId, "lead.converted", {
    leadId: lead.id,
    memberId: membership.memberId,
    membershipId: membership.id,
    campaignId: lead.campaignId,
  });
  await recordAudit(tx, actor, {
    action: "lead.converted",
    entityType: "Lead",
    entityId: lead.id,
    branchId: lead.branchId,
    after: { memberId: membership.memberId, membershipId: membership.id },
  });
  return true;
}

/** Recent open leads already converted to this member (sell page: "finishing a lead"). */
export async function leadsAwaitingSale(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
) {
  if (!hasPermission(ctx, "leads.view")) return [];
  return inTenant(deps, ctx, (tx) =>
    tx.lead.findMany({
      where: { convertedMemberId: memberId, status: "OPEN" },
      select: { id: true, firstName: true, lastName: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ).then((rows) => rows.map((r) => ({ ...r, name: leadName(r) })));
}
