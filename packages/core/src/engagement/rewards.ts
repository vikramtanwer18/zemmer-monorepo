import { withTenant, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  requirePermission,
  type AuthContext,
} from "../authz";
import { applyCreditTx } from "../billing/service";
import { checkEntitlement } from "../entitlements";
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
import { ensureEngagementDefaultsTx, pointsBalanceTx } from "./hooks";
import { DEFAULT_REWARD_RULES, pointsToCreditMinor } from "./rules";

const manageGuard = (deps: CoreDeps, ctx: AuthContext, write = false) =>
  guard(deps, ctx, {
    permission: "engagement.manage",
    entitlement: "rewards.enabled",
    write,
  });

async function memberRewardsTx<T>(
  deps: CoreDeps,
  mctx: MemberContext,
  fn: (tx: TenantTransaction) => Promise<T>,
) {
  checkEntitlement(
    await entitlementsFor(deps, mctx.tenantId),
    "rewards.enabled",
  );
  return withTenant(deps.db, mctx.tenantId, fn, { userId: mctx.userId });
}

// --- settings (owner/admin) -----------------------------------------------------------------------

export async function getRewardSettings(deps: CoreDeps, ctx: AuthContext) {
  await manageGuard(deps, ctx);
  return inTenant(deps, ctx, async (tx) => {
    await ensureEngagementDefaultsTx(tx, ctx.tenantId);
    const [rules, achievements, perks, settings] = [
      await tx.rewardRule.findMany(),
      await tx.achievement.findMany({
        orderBy: [{ kind: "asc" }, { threshold: "asc" }],
      }),
      await tx.rewardPerk.findMany({ orderBy: { pointsCost: "asc" } }),
      await tx.tenantSettings.findUniqueOrThrow({
        where: { tenantId: ctx.tenantId },
        select: {
          rewardPointValueMinor: true,
          rewardMinRedeemPoints: true,
          rewardVisitWeeklyCap: true,
          streakVisitsPerWeek: true,
          streakGraceDays: true,
        },
      }),
    ];
    return {
      rules: DEFAULT_REWARD_RULES.map((d) => ({
        ...d,
        ...(rules.find((r) => r.trigger === d.trigger) ?? {
          points: d.points,
          enabled: true,
        }),
      })),
      achievements,
      perks,
      settings,
    };
  });
}

const settingsSchema = z.object({
  rewardPointValueMinor: z.coerce.number().int().min(0).max(100000),
  rewardMinRedeemPoints: z.coerce.number().int().min(1).max(1_000_000),
  rewardVisitWeeklyCap: z.coerce.number().int().min(0).max(7),
  streakVisitsPerWeek: z.coerce.number().int().min(1).max(7),
  streakGraceDays: z.coerce.number().int().min(0).max(90),
  rules: z.record(
    z.enum([
      "VISIT",
      "WORKOUT_COMPLETED",
      "REFERRAL_CONVERTED",
      "CHALLENGE_COMPLETED",
      "ACHIEVEMENT",
    ]),
    z.object({
      points: z.coerce.number().int().min(0).max(100000),
      enabled: z.boolean(),
    }),
  ),
});

export async function saveRewardSettings(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await manageGuard(deps, ctx, true);
  const input = parseInput(settingsSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    await ensureEngagementDefaultsTx(tx, ctx.tenantId);
    const { rules, ...settings } = input;
    await tx.tenantSettings.update({
      where: { tenantId: ctx.tenantId },
      data: settings,
    });
    for (const [trigger, r] of Object.entries(rules))
      await tx.rewardRule.update({
        where: {
          tenantId_trigger: {
            tenantId: ctx.tenantId,
            trigger: trigger as never,
          },
        },
        data: r,
      });
    await recordAudit(tx, ctx, {
      action: "rewards.settings_updated",
      entityType: "TenantSettings",
      entityId: ctx.tenantId,
      after: input,
    });
  });
}

export async function saveAchievement(
  deps: CoreDeps,
  ctx: AuthContext,
  id: string,
  raw: unknown,
) {
  await manageGuard(deps, ctx, true);
  const input = parseInput(
    z.object({
      points: z.coerce.number().int().min(0).max(100000),
      enabled: z.boolean(),
    }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    await tx.achievement.update({ where: { id }, data: input });
    await recordAudit(tx, ctx, {
      action: "achievement.updated",
      entityType: "Achievement",
      entityId: id,
      after: input,
    });
  });
}

const perkSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().trim().max(300).optional(),
  ),
  pointsCost: z.coerce.number().int().min(1).max(1_000_000),
  active: z.boolean().default(true),
});

export async function savePerk(
  deps: CoreDeps,
  ctx: AuthContext,
  perkId: string | null,
  raw: unknown,
) {
  await manageGuard(deps, ctx, true);
  const input = parseInput(perkSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const data = { ...input, description: input.description ?? null };
    const row = perkId
      ? await tx.rewardPerk.update({ where: { id: perkId }, data })
      : await tx.rewardPerk.create({
          data: { tenantId: ctx.tenantId, ...data },
        });
    await recordAudit(tx, ctx, {
      action: perkId ? "reward_perk.updated" : "reward_perk.created",
      entityType: "RewardPerk",
      entityId: row.id,
      after: data,
    });
    return { id: row.id };
  });
}

// --- member: points, history, redeem ------------------------------------------------------------

export async function myRewards(deps: CoreDeps, mctx: MemberContext) {
  return memberRewardsTx(deps, mctx, async (tx) => {
    await ensureEngagementDefaultsTx(tx, mctx.tenantId);
    const [
      balance,
      history,
      perks,
      redemptions,
      settings,
      earned,
      achievements,
    ] = [
      await pointsBalanceTx(tx, mctx.memberId),
      await tx.rewardLedger.findMany({
        where: { memberId: mctx.memberId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      await tx.rewardPerk.findMany({
        where: { active: true },
        orderBy: { pointsCost: "asc" },
      }),
      await tx.rewardRedemption.findMany({
        where: { memberId: mctx.memberId },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { perk: { select: { name: true } } },
      }),
      await tx.tenantSettings.findUniqueOrThrow({
        where: { tenantId: mctx.tenantId },
        select: { rewardPointValueMinor: true, rewardMinRedeemPoints: true },
      }),
      await tx.memberAchievement.findMany({
        where: { memberId: mctx.memberId },
        include: { achievement: true },
        orderBy: { earnedAt: "desc" },
      }),
      await tx.achievement.findMany({
        where: { enabled: true },
        orderBy: [{ kind: "asc" }, { threshold: "asc" }],
      }),
    ];
    return {
      balance,
      history,
      perks,
      redemptions,
      settings,
      earned,
      achievements,
    };
  });
}

/** One redemption at a time per member: the balance check and the spend can't interleave. */
async function lockMemberPointsTx(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('reward-points'), hashtext(${tenantId + memberId}))`;
}

/**
 * Points → member credit, atomically: the redemption, the negative ledger entry, the credit entry
 * (and, with auto-apply on, credit used on open invoices) commit together or not at all.
 */
export async function redeemPointsForCredit(
  deps: CoreDeps,
  mctx: MemberContext,
  raw: unknown,
) {
  const { points } = parseInput(
    z.object({ points: z.coerce.number().int().min(1).max(10_000_000) }),
    raw,
  );
  return memberRewardsTx(deps, mctx, async (tx) => {
    await lockMemberPointsTx(tx, mctx.tenantId, mctx.memberId);
    const settings = await tx.tenantSettings.findUniqueOrThrow({
      where: { tenantId: mctx.tenantId },
      select: {
        rewardPointValueMinor: true,
        rewardMinRedeemPoints: true,
        autoApplyCredit: true,
      },
    });
    if (settings.rewardPointValueMinor <= 0)
      throw new AppError(
        "CONFLICT",
        "This gym doesn't turn points into credit.",
      );
    if (points < settings.rewardMinRedeemPoints)
      throw new AppError(
        "VALIDATION_FAILED",
        `Redeem at least ${settings.rewardMinRedeemPoints} points.`,
        { fields: { points: ["Below the minimum."] } },
      );
    const balance = await pointsBalanceTx(tx, mctx.memberId);
    if (points > balance)
      throw new AppError("VALIDATION_FAILED", `You have ${balance} points.`, {
        fields: { points: ["More than your balance."] },
      });
    const amountMinor = pointsToCreditMinor(
      points,
      settings.rewardPointValueMinor,
    );
    const credit = await tx.memberCreditEntry.create({
      data: {
        tenantId: mctx.tenantId,
        memberId: mctx.memberId,
        amountMinor,
        kind: "REWARD",
        note: `${points} reward points`,
        createdById: mctx.userId,
      },
    });
    const r = await tx.rewardRedemption.create({
      data: {
        tenantId: mctx.tenantId,
        memberId: mctx.memberId,
        kind: "CREDIT",
        points,
        amountMinor,
        creditEntryId: credit.id,
        status: "FULFILLED",
        decidedAt: nowOf(deps),
      },
    });
    await tx.rewardLedger.create({
      data: {
        tenantId: mctx.tenantId,
        memberId: mctx.memberId,
        kind: "REDEEM",
        points: -points,
        reason: "Turned into member credit",
        sourceKey: `redeem:${r.id}`,
        redemptionId: r.id,
        createdById: mctx.userId,
      },
    });
    const actor = { userId: mctx.userId, tenantId: mctx.tenantId };
    if (settings.autoApplyCredit)
      await applyCreditTx(tx, actor, mctx.tenantId, mctx.memberId);
    await recordAudit(tx, actor, {
      action: "rewards.redeemed_credit",
      entityType: "RewardRedemption",
      entityId: r.id,
      meta: { points, amountMinor },
    });
    return { id: r.id, amountMinor };
  });
}

/** A perk: points are held now (spent), staff hand it over or refuse (points come back). */
export async function requestPerk(
  deps: CoreDeps,
  mctx: MemberContext,
  perkId: string,
) {
  return memberRewardsTx(deps, mctx, async (tx) => {
    await lockMemberPointsTx(tx, mctx.tenantId, mctx.memberId);
    const perk = await tx.rewardPerk.findUnique({ where: { id: perkId } });
    if (!perk || !perk.active)
      throw new AppError("NOT_FOUND", "That reward isn't available.");
    const balance = await pointsBalanceTx(tx, mctx.memberId);
    if (perk.pointsCost > balance)
      throw new AppError(
        "VALIDATION_FAILED",
        `It needs ${perk.pointsCost} points; you have ${balance}.`,
      );
    const r = await tx.rewardRedemption.create({
      data: {
        tenantId: mctx.tenantId,
        memberId: mctx.memberId,
        kind: "PERK",
        perkId: perk.id,
        points: perk.pointsCost,
      },
    });
    await tx.rewardLedger.create({
      data: {
        tenantId: mctx.tenantId,
        memberId: mctx.memberId,
        kind: "REDEEM",
        points: -perk.pointsCost,
        reason: `Reward: ${perk.name}`,
        sourceKey: `redeem:${r.id}`,
        redemptionId: r.id,
        createdById: mctx.userId,
      },
    });
    await recordAudit(
      tx,
      { userId: mctx.userId, tenantId: mctx.tenantId },
      {
        action: "rewards.perk_requested",
        entityType: "RewardRedemption",
        entityId: r.id,
        meta: { perk: perk.name, points: perk.pointsCost },
      },
    );
    return { id: r.id };
  });
}

// --- staff: hand over perks (rewards.fulfil, branch-scoped) --------------------------------------

export async function listRedemptions(
  deps: CoreDeps,
  ctx: AuthContext,
  status: "REQUESTED" | "FULFILLED" | "REJECTED" = "REQUESTED",
) {
  await guard(deps, ctx, {
    permission: "rewards.fulfil",
    entitlement: "rewards.enabled",
  });
  const allowed = allowedBranchIds(ctx, "rewards.fulfil");
  return inTenant(deps, ctx, (tx) =>
    tx.rewardRedemption.findMany({
      where: {
        kind: "PERK",
        status,
        ...(allowed === "ALL"
          ? {}
          : { member: { homeBranchId: { in: allowed } } }),
      },
      orderBy: { createdAt: "asc" },
      take: 200,
      include: {
        perk: { select: { name: true } },
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
            homeBranchId: true,
          },
        },
      },
    }),
  );
}

export async function decidePerk(
  deps: CoreDeps,
  ctx: AuthContext,
  redemptionId: string,
  raw: unknown,
) {
  await guard(deps, ctx, {
    permission: "rewards.fulfil",
    entitlement: "rewards.enabled",
    write: true,
  });
  const input = parseInput(
    z.object({
      fulfil: z.boolean(),
      note: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.string().trim().max(200).optional(),
      ),
    }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const r = await tx.rewardRedemption.findUnique({
      where: { id: redemptionId },
      include: {
        perk: true,
        member: { select: { homeBranchId: true, userId: true } },
      },
    });
    if (!r || r.kind !== "PERK") throw new AppError("NOT_FOUND", "Not found.");
    requirePermission(ctx, "rewards.fulfil", {
      branchId: r.member.homeBranchId,
    });
    const claimed = await tx.rewardRedemption.updateMany({
      where: { id: r.id, status: "REQUESTED" },
      data: {
        status: input.fulfil ? "FULFILLED" : "REJECTED",
        decidedAt: nowOf(deps),
        decidedById: ctx.userId,
        note: input.note ?? null,
      },
    });
    if (claimed.count === 0) throw new AppError("CONFLICT", "Already decided.");
    if (!input.fulfil)
      await tx.rewardLedger.create({
        data: {
          tenantId: ctx.tenantId,
          memberId: r.memberId,
          kind: "REVERSE",
          points: r.points,
          reason: `Refused: ${r.perk?.name ?? "reward"}`,
          sourceKey: `reverse:${r.id}`,
          redemptionId: r.id,
          createdById: ctx.userId,
        },
      });
    if (r.member.userId)
      await notify(tx, ctx.tenantId, {
        templateKey: "rewards.perk_update",
        recipient: { userId: r.member.userId },
        channels: ["IN_APP"],
        data: {
          perk: r.perk?.name ?? "Reward",
          status: input.fulfil
            ? "handed over"
            : "not available, points returned",
          note: input.note ?? "",
        },
        link: "/m/rewards",
        dedupeKey: `perk:${r.id}`,
      });
    await recordAudit(tx, ctx, {
      action: input.fulfil ? "rewards.perk_fulfilled" : "rewards.perk_refused",
      entityType: "RewardRedemption",
      entityId: r.id,
      branchId: r.member.homeBranchId,
    });
  });
}

/** Staff gives or takes points by hand (with a reason). */
export async function adjustPoints(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  await manageGuard(deps, ctx, true);
  const input = parseInput(
    z.object({
      points: z.coerce
        .number()
        .int()
        .min(-100000)
        .max(100000)
        .refine((p) => p !== 0, "Not zero."),
      reason: z.string().trim().min(3).max(200),
    }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    await lockMemberPointsTx(tx, ctx.tenantId, memberId);
    if (
      input.points < 0 &&
      (await pointsBalanceTx(tx, memberId)) + input.points < 0
    )
      throw new AppError(
        "VALIDATION_FAILED",
        "That would make the balance negative.",
      );
    const row = await tx.rewardLedger.create({
      data: {
        tenantId: ctx.tenantId,
        memberId,
        kind: "ADJUST",
        points: input.points,
        reason: input.reason,
        sourceKey: `adjust:${crypto.randomUUID()}`,
        createdById: ctx.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: "rewards.adjusted",
      entityType: "RewardLedger",
      entityId: row.id,
      meta: { memberId, ...input },
    });
  });
}
