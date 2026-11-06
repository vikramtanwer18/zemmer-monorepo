import type { TenantTransaction } from "@gym/db";
import { isFeatureEnabled, loadEntitlements } from "../entitlements";
import { notify } from "../notifications";
import {
  addDays,
  fromDbDate,
  todayIn,
  toDbDate,
  type LocalDate,
} from "../time/dates";
import {
  challengeProgress,
  computeStreak,
  DEFAULT_ACHIEVEMENTS,
  DEFAULT_REWARD_RULES,
  newlyEarned,
  visitRewardAllowed,
  weekStart,
} from "./rules";

/**
 * Engagement side effects shared by check-ins, workouts, challenges and the nightly job. Every
 * award has a unique source key, so running any of these twice changes nothing.
 */

export async function ensureEngagementDefaultsTx(
  tx: TenantTransaction,
  tenantId: string,
) {
  await tx.rewardRule.createMany({
    data: DEFAULT_REWARD_RULES.map((r) => ({
      tenantId,
      trigger: r.trigger,
      points: r.points,
    })),
    skipDuplicates: true,
  });
  await tx.achievement.createMany({
    data: DEFAULT_ACHIEVEMENTS.map((a) => ({ tenantId, ...a })),
    skipDuplicates: true,
  });
}

async function rewardsOnTx(tx: TenantTransaction, tenantId: string, now: Date) {
  return isFeatureEnabled(
    await loadEntitlements(tx, tenantId, now),
    "rewards.enabled",
  );
}

/** Adds points once per source key. Returns false when that source was already rewarded. */
export async function awardPointsTx(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
  entry: {
    points: number;
    reason: string;
    sourceKey: string;
    createdById?: string | null;
  },
): Promise<boolean> {
  if (entry.points <= 0) return false;
  const r = await tx.rewardLedger.createMany({
    data: [
      {
        tenantId,
        memberId,
        kind: "EARN",
        points: entry.points,
        reason: entry.reason,
        sourceKey: entry.sourceKey,
        createdById: entry.createdById ?? null,
      },
    ],
    skipDuplicates: true,
  });
  return r.count === 1;
}

export async function pointsBalanceTx(
  tx: TenantTransaction,
  memberId: string,
): Promise<number> {
  const s = await tx.rewardLedger.aggregate({
    where: { memberId },
    _sum: { points: true },
  });
  return s._sum.points ?? 0;
}

async function ruleTx(
  tx: TenantTransaction,
  tenantId: string,
  trigger: (typeof DEFAULT_REWARD_RULES)[number]["trigger"],
) {
  await ensureEngagementDefaultsTx(tx, tenantId);
  return tx.rewardRule.findUnique({
    where: { tenantId_trigger: { tenantId, trigger } },
  });
}

async function timezoneTx(tx: TenantTransaction, tenantId: string) {
  return (
    await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { timezone: true },
    })
  ).timezone;
}

/** Distinct local days with an accepted check-in, oldest first (optionally from a date). */
export async function visitDaysTx(
  tx: TenantTransaction,
  memberId: string,
  timeZone: string,
  from?: LocalDate,
): Promise<LocalDate[]> {
  // Visits count once per local day (a second check-in that day adds nothing). Timestamps are
  // stored as UTC without a zone: read them as UTC first, then convert to the gym's clock.
  const since = from ? toDbDate(addDays(from, -1)) : new Date(0);
  const rows = await tx.$queryRaw<{ d: string }[]>`
    SELECT DISTINCT to_char(((occurred_at AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD') AS d
      FROM app.attendance_event
     WHERE member_id = ${memberId}::uuid AND result = 'ACCEPTED' AND type = 'CHECK_IN' AND voided_at IS NULL
       AND occurred_at >= ${since}
     ORDER BY d`;
  const all = rows.map((r) => r.d);
  return from ? all.filter((d) => d >= from) : all;
}

async function workoutDaysTx(
  tx: TenantTransaction,
  memberId: string,
  from: LocalDate,
  to: LocalDate,
): Promise<LocalDate[]> {
  const logs = await tx.workoutLog.findMany({
    where: {
      memberId,
      status: "COMPLETED",
      performedOn: { gte: toDbDate(from), lte: toDbDate(to) },
    },
    select: { performedOn: true },
  });
  return logs.map((l) => fromDbDate(l.performedOn));
}

// --- streaks ---------------------------------------------------------------------------------------

/** Recomputes and stores the member's streak (docs/KPI_DEFINITIONS.md "Streaks"). */
export async function refreshStreakTx(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
  now: Date,
) {
  const tz = await timezoneTx(tx, tenantId);
  const today = todayIn(tz, now);
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId },
    select: { streakVisitsPerWeek: true, streakGraceDays: true },
  });
  const visitDays = await visitDaysTx(
    tx,
    memberId,
    tz,
    addDays(today, -7 * 104),
  );
  const memberships = await tx.membership.findMany({
    where: { memberId, status: { in: ["ACTIVE", "PAUSED", "EXPIRED"] } },
    select: {
      status: true,
      endDate: true,
      freezes: {
        where: { endedAt: null },
        select: { startDate: true, endDate: true },
      },
    },
  });
  const frozenWeeks = new Set<LocalDate>();
  let pausedToday = false;
  for (const m of memberships)
    for (const f of m.freezes) {
      const s = fromDbDate(f.startDate);
      const e = fromDbDate(f.endDate);
      if (s <= today && today <= e) pausedToday = true;
      // A week is frozen when the pause covers 4+ of its days.
      for (let w = weekStart(s); w <= e; w = addDays(w, 7)) {
        let days = 0;
        for (let d = 0; d < 7; d++) {
          const day = addDays(w, d);
          if (day >= s && day <= e) days++;
        }
        if (days >= 4) frozenWeeks.add(w);
      }
    }
  const current = memberships.some(
    (m) => m.status === "ACTIVE" || m.status === "PAUSED",
  );
  const lastEnd =
    memberships
      .map((m) => fromDbDate(m.endDate))
      .sort()
      .at(-1) ?? null;
  const r = computeStreak({
    visitDays,
    today,
    minVisitsPerWeek: settings?.streakVisitsPerWeek ?? 2,
    frozenWeeks,
    expiredOn: current ? null : lastEnd,
    graceDays: settings?.streakGraceDays ?? 14,
    pausedToday,
  });
  const data = {
    currentWeeks: r.currentWeeks,
    longestWeeks: r.longestWeeks,
    lastWeekStart: r.lastWeekStart ? toDbDate(r.lastWeekStart) : null,
    status: r.status,
    computedAt: now,
  };
  await tx.streakState.upsert({
    where: { tenantId_memberId: { tenantId, memberId } },
    create: { tenantId, memberId, ...data },
    update: data,
  });
  return r;
}

// --- milestones -----------------------------------------------------------------------------------

export async function checkAchievementsTx(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
  now: Date,
) {
  if (!(await rewardsOnTx(tx, tenantId, now))) return [];
  await ensureEngagementDefaultsTx(tx, tenantId);
  const tz = await timezoneTx(tx, tenantId);
  const [defs, earned, visits, workouts, prs, streak, challenges] = [
    await tx.achievement.findMany(),
    await tx.memberAchievement.findMany({
      where: { memberId },
      include: { achievement: { select: { key: true } } },
    }),
    (await visitDaysTx(tx, memberId, tz)).length,
    await tx.workoutLog.count({ where: { memberId, status: "COMPLETED" } }),
    await tx.personalRecord.count({ where: { memberId } }),
    await tx.streakState.findUnique({
      where: { tenantId_memberId: { tenantId, memberId } },
    }),
    await tx.challengeParticipant.count({
      where: { memberId, completedAt: { not: null } },
    }),
  ];
  const keys = newlyEarned(
    defs,
    {
      visits,
      workouts,
      personalRecords: prs,
      streakWeeks: streak?.longestWeeks ?? 0,
      challenges,
    },
    new Set(earned.map((e) => e.achievement.key)),
  );
  if (!keys.length) return [];
  const member = await tx.memberProfile.findUnique({
    where: { id: memberId },
    select: { userId: true },
  });
  const rule = await ruleTx(tx, tenantId, "ACHIEVEMENT");
  const out: string[] = [];
  for (const key of keys) {
    const def = defs.find((d) => d.key === key)!;
    const created = await tx.memberAchievement.createMany({
      data: [{ tenantId, memberId, achievementId: def.id, earnedAt: now }],
      skipDuplicates: true,
    });
    if (created.count === 0) continue;
    out.push(key);
    const points = rule?.enabled ? def.points : 0;
    if (points)
      await awardPointsTx(tx, tenantId, memberId, {
        points,
        reason: `Milestone: ${def.name}`,
        sourceKey: `ach:${memberId}:${def.key}`,
      });
    if (member?.userId)
      await notify(tx, tenantId, {
        templateKey: "engagement.achievement",
        recipient: { userId: member.userId },
        channels: ["IN_APP"],
        data: {
          achievement: def.name,
          description: def.description,
          points: points ? `+${points} points.` : "",
        },
        link: "/m/rewards",
        dedupeKey: `ach:${memberId}:${def.key}`,
      });
  }
  return out;
}

// --- challenges -----------------------------------------------------------------------------------

/** Recomputes the member's progress in their active challenges of this metric; awards completion once. */
export async function refreshChallengesTx(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
  metric: "VISITS" | "WORKOUTS",
  now: Date,
) {
  const tz = await timezoneTx(tx, tenantId);
  const entries = await tx.challengeParticipant.findMany({
    where: { memberId, leftAt: null, challenge: { status: "ACTIVE", metric } },
    include: { challenge: true },
  });
  const completed: string[] = [];
  const rule = entries.length
    ? await ruleTx(tx, tenantId, "CHALLENGE_COMPLETED")
    : null;
  const rewards = entries.length ? await rewardsOnTx(tx, tenantId, now) : false;
  for (const e of entries) {
    const c = e.challenge;
    const from = fromDbDate(c.startsOn);
    const to = fromDbDate(c.endsOn);
    const days =
      metric === "VISITS"
        ? await visitDaysTx(tx, memberId, tz, from)
        : await workoutDaysTx(tx, memberId, from, to);
    // Branch challenges count visits anywhere (the member's own effort), workouts are branch-free anyway.
    const progress = challengeProgress(days, from, to);
    const done = progress >= c.target && !e.completedAt;
    await tx.challengeParticipant.update({
      where: { id: e.id },
      data: { progress, ...(done ? { completedAt: now } : {}) },
    });
    if (done) {
      completed.push(c.id);
      if (rewards && rule?.enabled && c.points > 0)
        await awardPointsTx(tx, tenantId, memberId, {
          points: c.points,
          reason: `Challenge completed: ${c.name}`,
          sourceKey: `challenge:${c.id}:${memberId}`,
        });
    }
  }
  return completed;
}

// --- triggers -------------------------------------------------------------------------------------

/** A check-in (from the attendance.checked_in event). */
export async function onVisitTx(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
  occurredAt: Date,
  now: Date,
) {
  const tz = await timezoneTx(tx, tenantId);
  const day = todayIn(tz, occurredAt);
  let points = 0;
  if (await rewardsOnTx(tx, tenantId, now)) {
    const rule = await ruleTx(tx, tenantId, "VISIT");
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId },
      select: { rewardVisitWeeklyCap: true },
    });
    if (rule?.enabled && rule.points > 0) {
      const ws = weekStart(day);
      const weekKeys = Array.from(
        { length: 7 },
        (_, i) => `visit:${memberId}:${addDays(ws, i)}`,
      );
      const rewarded = await tx.rewardLedger.findMany({
        where: { sourceKey: { in: weekKeys } },
        select: { sourceKey: true },
      });
      const key = `visit:${memberId}:${day}`;
      if (
        visitRewardAllowed({
          alreadyRewardedToday: rewarded.some((r) => r.sourceKey === key),
          rewardedDaysThisWeek: rewarded.length,
          weeklyCap: settings?.rewardVisitWeeklyCap ?? 5,
        }) &&
        (await awardPointsTx(tx, tenantId, memberId, {
          points: rule.points,
          reason: `Visit on ${day}`,
          sourceKey: key,
        }))
      )
        points = rule.points;
    }
  }
  await refreshStreakTx(tx, tenantId, memberId, now);
  const challenges = await refreshChallengesTx(
    tx,
    tenantId,
    memberId,
    "VISITS",
    now,
  );
  const achievements = await checkAchievementsTx(tx, tenantId, memberId, now);
  return { points, challenges, achievements };
}

/** A completed workout (called inside the completion transaction). */
export async function onWorkoutCompletedTx(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
  w: { logId: string; performedOn: LocalDate; newRecords: number; now: Date },
) {
  let points = 0;
  if (await rewardsOnTx(tx, tenantId, w.now)) {
    const rule = await ruleTx(tx, tenantId, "WORKOUT_COMPLETED");
    // Once a day: a second workout the same day earns nothing (no reward for doubling up).
    if (
      rule?.enabled &&
      (await awardPointsTx(tx, tenantId, memberId, {
        points: rule.points,
        reason: `Workout on ${w.performedOn}`,
        sourceKey: `workout:${memberId}:${w.performedOn}`,
      }))
    )
      points = rule.points;
  }
  const challenges = await refreshChallengesTx(
    tx,
    tenantId,
    memberId,
    "WORKOUTS",
    w.now,
  );
  const achievements = await checkAchievementsTx(tx, tenantId, memberId, w.now);
  return { points, challenges, achievements };
}
