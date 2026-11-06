import { withTenant, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { allowedBranchIds, type AuthContext } from "../authz";
import { contactSchema, createLeadTx } from "../crm/leads";
import {
  checkEntitlement,
  isFeatureEnabled,
  loadEntitlements,
} from "../entitlements";
import { emitEvent, type EventHandler } from "../events";
import { AppError } from "../errors";
import type { MemberContext } from "../members/self";
import { notify } from "../notifications";
import {
  entitlementsFor,
  guard,
  inTenant,
  nowOf,
  type CoreDeps,
} from "../tenancy/deps";
import { parseInput } from "../validation";
import { awardPointsTx, ensureEngagementDefaultsTx, onVisitTx } from "./hooks";
import { newReferralCode } from "./rules";

/**
 * Referrals (M7 §9): every member has one random code (no personal data). A friend opens
 * /r/<gym>/<code>, leaves their number → a CRM lead (source "referral") linked to the referrer.
 * When that lead's membership is paid (lead.converted), the referrer gets the referral points
 * once (unique source key) and referral.converted is emitted for M6 automations.
 */

export const REFERRAL_CONSENT_TEXT =
  "I agree that {gym} may contact me by phone, WhatsApp or email about joining.";

async function codeForTx(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
) {
  const existing = await tx.referralCode.findUnique({
    where: { tenantId_memberId: { tenantId, memberId } },
  });
  if (existing) return existing.code;
  for (let i = 0; i < 5; i++) {
    const code = newReferralCode();
    const r = await tx.referralCode.createMany({
      data: [{ tenantId, memberId, code }],
      skipDuplicates: true,
    });
    if (r.count === 1) return code;
    const mine = await tx.referralCode.findUnique({
      where: { tenantId_memberId: { tenantId, memberId } },
    });
    if (mine) return mine.code;
  }
  throw new AppError("INTERNAL", "Couldn't make a referral code. Try again.");
}

export async function myReferrals(deps: CoreDeps, mctx: MemberContext) {
  checkEntitlement(
    await entitlementsFor(deps, mctx.tenantId),
    "rewards.enabled",
  );
  return withTenant(
    deps.db,
    mctx.tenantId,
    async (tx) => {
      await ensureEngagementDefaultsTx(tx, mctx.tenantId);
      const code = await codeForTx(tx, mctx.tenantId, mctx.memberId);
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: mctx.tenantId },
        select: { slug: true },
      });
      const rule = await tx.rewardRule.findUnique({
        where: {
          tenantId_trigger: {
            tenantId: mctx.tenantId,
            trigger: "REFERRAL_CONVERTED",
          },
        },
      });
      const referrals = await tx.referral.findMany({
        where: { referrerMemberId: mctx.memberId },
        orderBy: { createdAt: "desc" },
        include: { lead: { select: { firstName: true } } },
      });
      return {
        code,
        path: `/r/${tenant.slug}/${code}`,
        points: rule?.enabled ? rule.points : 0,
        // First names only: the referrer doesn't see the friend's number.
        referrals: referrals.map((r) => ({
          id: r.id,
          name: r.lead?.firstName ?? "Friend",
          status: r.status,
          createdAt: r.createdAt,
          rewardPoints: r.rewardPoints,
        })),
      };
    },
    { userId: mctx.userId },
  );
}

export async function referralLanding(
  deps: Pick<CoreDeps, "db">,
  slug: string,
  code: string,
) {
  if (!/^[a-z0-9-]{2,80}$/.test(slug) || !/^[A-Za-z0-9]{6,12}$/.test(code))
    return null;
  const rows = await deps.db.$queryRaw<
    {
      tenant_id: string;
      member_id: string;
      first_name: string;
      gym_name: string;
      branch_id: string;
    }[]
  >`
    SELECT tenant_id::text, member_id::text, first_name, gym_name, branch_id::text FROM app.referral_lookup(${slug}, ${code})`;
  const r = rows[0];
  if (!r) return null;
  const ent = await withTenant(deps.db, r.tenant_id, (tx) =>
    loadEntitlements(tx, r.tenant_id),
  );
  if (!isFeatureEnabled(ent, "rewards.enabled")) return null;
  return {
    tenantId: r.tenant_id,
    referrerId: r.member_id,
    referrerFirstName: r.first_name,
    gymName: r.gym_name,
    branchId: r.branch_id,
    consentText: REFERRAL_CONSENT_TEXT.replace("{gym}", r.gym_name),
  };
}

const submitSchema = contactSchema.and(
  z.object({
    consent: z.literal("on", {
      error: "Please tick the box to agree to be contacted.",
    }),
  }),
);

/** The friend's form. Tenant, branch and referrer come only from the code. The route rate-limits. */
export async function submitReferral(
  deps: Pick<CoreDeps, "db" | "now">,
  input: {
    slug: string;
    code: string;
    body: Record<string, unknown>;
    honeypot?: string;
  },
) {
  const landing = await referralLanding(deps, input.slug, input.code);
  if (!landing) return { ok: false as const, status: 404 as const };
  if (input.honeypot) return { ok: true as const };
  const data = parseInput(submitSchema, input.body);
  const now = deps.now ? deps.now() : new Date();
  await withTenant(deps.db, landing.tenantId, async (tx) => {
    const actor = { system: true as const, tenantId: landing.tenantId };
    // Someone who is already a member can't be referred.
    if (data.phone) {
      const member = await tx.memberProfile.findFirst({
        where: { phone: data.phone, status: { not: "ARCHIVED" } },
        select: { id: true },
      });
      if (member) return;
    }
    const source = await tx.leadSource.findFirst({
      where: { code: "referral", archivedAt: null },
    });
    const { lead } = await createLeadTx(
      tx,
      actor,
      landing.tenantId,
      {
        branchId: landing.branchId,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        email: data.email,
        interest: data.interest ?? null,
        sourceId: source?.id ?? null,
        campaignId: null,
        utm: {
          source: "referral",
          medium: null,
          campaign: null,
          term: null,
          content: null,
        },
        referrer: null,
        ownerUserId: null,
        captureFormId: null,
        consentText: landing.consentText,
        marketingConsent: false,
        note: `Referred by member ${landing.referrerFirstName} (code ${input.code.toUpperCase()}).`,
      },
      "FORM",
      now,
    );
    // One referral per lead; the first referrer keeps it.
    await tx.referral.createMany({
      data: [
        {
          tenantId: landing.tenantId,
          referrerMemberId: landing.referrerId,
          leadId: lead.id,
        },
      ],
      skipDuplicates: true,
    });
  });
  return { ok: true as const };
}

/** lead.converted: the referred person paid for a membership → points to the referrer, once. */
export async function rewardReferralTx(
  tx: TenantTransaction,
  tenantId: string,
  data: { leadId: string; memberId: string; membershipId: string },
) {
  const ref = await tx.referral.findUnique({
    where: { tenantId_leadId: { tenantId, leadId: data.leadId } },
  });
  if (!ref || ref.status === "REWARDED" || ref.status === "REJECTED")
    return null;
  if (ref.referrerMemberId === data.memberId) {
    await tx.referral.update({
      where: { id: ref.id },
      data: { status: "REJECTED", note: "Referred themselves." },
    });
    return null;
  }
  const now = new Date();
  const ent = await loadEntitlements(tx, tenantId, now);
  await ensureEngagementDefaultsTx(tx, tenantId);
  const rule = await tx.rewardRule.findUnique({
    where: { tenantId_trigger: { tenantId, trigger: "REFERRAL_CONVERTED" } },
  });
  const points =
    isFeatureEnabled(ent, "rewards.enabled") && rule?.enabled ? rule.points : 0;
  const awarded =
    points > 0
      ? await awardPointsTx(tx, tenantId, ref.referrerMemberId, {
          points,
          reason: "A friend you referred joined",
          sourceKey: `referral:${ref.id}`,
        })
      : false;
  const claimed = await tx.referral.updateMany({
    where: { id: ref.id, status: { in: ["PENDING", "JOINED"] } },
    data: {
      status: "REWARDED",
      referredMemberId: data.memberId,
      membershipId: data.membershipId,
      joinedAt: ref.joinedAt ?? now,
      rewardedAt: now,
      rewardPoints: awarded ? points : 0,
    },
  });
  if (claimed.count === 0) return null;
  await emitEvent(tx, tenantId, "referral.converted", {
    referralId: ref.id,
    referrerMemberId: ref.referrerMemberId,
    referredMemberId: data.memberId,
    leadId: data.leadId,
    points: awarded ? points : 0,
  });
  const referrer = await tx.memberProfile.findUnique({
    where: { id: ref.referrerMemberId },
    select: { userId: true },
  });
  if (referrer?.userId)
    await notify(tx, tenantId, {
      templateKey: "engagement.achievement",
      recipient: { userId: referrer.userId },
      channels: ["IN_APP"],
      data: {
        achievement: "Your friend joined",
        description: "Thanks for the referral!",
        points: awarded ? `+${points} points.` : "",
      },
      link: "/m/rewards",
      dedupeKey: `referral:${ref.id}`,
    });
  await recordAudit(
    tx,
    { system: true, tenantId },
    {
      action: "referral.rewarded",
      entityType: "Referral",
      entityId: ref.id,
      meta: { points: awarded ? points : 0 },
    },
  );
  return { referralId: ref.id, points: awarded ? points : 0 };
}

/** Engagement reacts to domain events (each handler runs once per event). */
export const ENGAGEMENT_EVENT_HANDLER: EventHandler = {
  name: "engagement.react",
  types: ["attendance.checked_in", "lead.converted"],
  handle: async (tx, tenantId, event) => {
    const d = event.data as Record<string, string>;
    if (event.type === "attendance.checked_in")
      await onVisitTx(
        tx,
        tenantId,
        d.memberId!,
        new Date(d.occurredAt!),
        new Date(),
      );
    else if (event.type === "lead.converted")
      await rewardReferralTx(tx, tenantId, {
        leadId: d.leadId!,
        memberId: d.memberId!,
        membershipId: d.membershipId!,
      });
  },
};

export async function listReferrals(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, {
    permission: "leads.view",
    entitlement: "rewards.enabled",
  });
  const allowed = allowedBranchIds(ctx, "leads.view");
  return inTenant(deps, ctx, async (tx) =>
    tx.referral.findMany({
      where: allowed === "ALL" ? {} : { lead: { branchId: { in: allowed } } },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        referrer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
          },
        },
        referred: { select: { id: true, firstName: true, lastName: true } },
        lead: {
          select: { id: true, firstName: true, lastName: true, status: true },
        },
      },
    }),
  );
}
