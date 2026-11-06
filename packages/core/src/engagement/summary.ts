import { withTenant, type TenantTransaction } from "@gym/db";
import { isFeatureEnabled } from "../entitlements";
import type { MemberContext } from "../members/self";
import { entitlementsFor, nowOf, type CoreDeps } from "../tenancy/deps";
import { todayIn, toDbDate, type LocalDate } from "../time/dates";
import { checkAchievementsTx, pointsBalanceTx, refreshStreakTx } from "./hooks";

/** Member home: streak (fresh), points, latest milestones, unread trainer feedback. */
export async function myEngagement(deps: CoreDeps, mctx: MemberContext) {
  const ent = await entitlementsFor(deps, mctx.tenantId);
  const rewards = isFeatureEnabled(ent, "rewards.enabled");
  const now = nowOf(deps);
  return withTenant(
    deps.db,
    mctx.tenantId,
    async (tx) => {
      const streak = await refreshStreakTx(
        tx,
        mctx.tenantId,
        mctx.memberId,
        now,
      );
      return {
        rewards,
        streak,
        points: rewards ? await pointsBalanceTx(tx, mctx.memberId) : null,
        milestones: rewards
          ? await tx.memberAchievement.findMany({
              where: { memberId: mctx.memberId },
              include: { achievement: { select: { name: true } } },
              orderBy: { earnedAt: "desc" },
              take: 3,
            })
          : [],
        unreadFeedback: await tx.trainerFeedback.count({
          where: { memberId: mctx.memberId, readAt: null },
        }),
        workouts: isFeatureEnabled(ent, "workouts.enabled"),
        nutrition: isFeatureEnabled(ent, "nutrition.enabled"),
      };
    },
    { userId: mctx.userId },
  );
}

/**
 * Nightly per gym (its local date): streaks for members who visited in the last 16 weeks or have a
 * current membership (so a missed week shows tomorrow, not at the next visit), streak milestones,
 * and challenges whose end date has passed are closed.
 */
export async function runEngagementDailyTx(
  tx: TenantTransaction,
  tenantId: string,
  today: LocalDate,
  now: Date,
) {
  const since = new Date(now.getTime() - 16 * 7 * 86_400_000);
  const recent = await tx.attendanceEvent.findMany({
    where: {
      result: "ACCEPTED",
      occurredAt: { gte: since },
      memberId: { not: null },
    },
    distinct: ["memberId"],
    select: { memberId: true },
  });
  const withStreak = await tx.streakState.findMany({
    where: { currentWeeks: { gt: 0 } },
    select: { memberId: true },
  });
  const ids = [
    ...new Set([
      ...recent.map((r) => r.memberId!),
      ...withStreak.map((s) => s.memberId),
    ]),
  ];
  let milestones = 0;
  for (const id of ids) {
    await refreshStreakTx(tx, tenantId, id, now);
    milestones += (await checkAchievementsTx(tx, tenantId, id, now)).length;
  }
  const ended = await tx.challenge.updateMany({
    where: { status: "ACTIVE", endsOn: { lt: toDbDate(today) } },
    data: { status: "ENDED" },
  });
  return { streaks: ids.length, milestones, challengesEnded: ended.count };
}

export function engagementToday(timeZone: string, now: Date) {
  return todayIn(timeZone, now);
}
