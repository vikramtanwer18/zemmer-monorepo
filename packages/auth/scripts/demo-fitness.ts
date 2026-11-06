/**
 * M7 demo for Iron Temple: nutrition switched on (plan override, demo only), a workout template,
 * the demo member's health-data consent, an assigned plan with one logged workout and PRs, an
 * assessment and a goal, a diet plan and a food log, an announcement, an active challenge and a
 * perk. Skipped when the gym already has workout templates.
 */
import type { AuthContext } from "@gym/core/authz";
import {
  joinChallenge,
  publishAnnouncement,
  savePerk,
  saveChallenge,
  setChallengeStatus,
} from "@gym/core/engagement";
import { noEntitlementCache } from "@gym/core/entitlements";
import {
  assignWorkoutPlan,
  completeWorkout,
  listExercises,
  logSet,
  recordAssessment,
  saveWorkoutTemplate,
  setMyHealthConsent,
  startWorkout,
  addGoalForMember,
} from "@gym/core/fitness";
import { resolveMemberContext, type MemberContext } from "@gym/core/members";
import {
  assignNutritionPlan,
  logFood,
  logWater,
  searchFoods,
} from "@gym/core/nutrition";
import { addDays, todayIn } from "@gym/core/time/dates";
import { withTenant, type PrismaClient } from "@gym/db";
import { authContextFor } from "../src/context";

export async function seedFitnessDemo(
  db: PrismaClient,
  platformDb: PrismaClient,
  ownerCtx: AuthContext,
  input: { trainerEmail: string; memberEmail: string },
) {
  const deps = { db, entitlements: noEntitlementCache };
  if (
    (await withTenant(db, ownerCtx.tenantId, (tx) =>
      tx.workoutTemplate.count(),
    )) > 0
  )
    return false;
  const has = await platformDb.subscriptionOverride.findFirst({
    where: { tenantId: ownerCtx.tenantId, featureKey: "nutrition.enabled" },
  });
  if (!has)
    await platformDb.subscriptionOverride.create({
      data: {
        tenantId: ownerCtx.tenantId,
        featureKey: "nutrition.enabled",
        value: true,
        reason: "Demo data: nutrition tracking",
      },
    });
  const trainerUser = await db.user.findUniqueOrThrow({
    where: { email: input.trainerEmail },
  });
  const memberUser = await db.user.findUniqueOrThrow({
    where: { email: input.memberEmail },
  });
  const trainer = (await authContextFor(
    db,
    trainerUser.id,
    ownerCtx.tenantId,
  ))!;
  const mctx = (await resolveMemberContext(
    db,
    memberUser.id,
    ownerCtx.tenantId,
  )) as MemberContext;
  const ex = Object.fromEntries(
    (await listExercises(deps, trainer))
      .filter((e) => e.libraryKey)
      .map((e) => [e.libraryKey!, e.id]),
  );
  const item = (
    id: string,
    key: string,
    sets: number,
    extra: Record<string, unknown>,
  ) => ({ id, exerciseId: ex[key]!, sets, restSec: 90, ...extra });
  const t = await saveWorkoutTemplate(deps, trainer, null, {
    name: "Beginner full body (3 days)",
    level: "BEGINNER",
    description: "Three sessions a week with a rest day between.",
    structure: {
      weeks: [
        {
          days: [
            {
              title: "Full body A",
              items: [
                item("squat0a", "barbell_back_squat", 3, {
                  repsMin: 8,
                  repsMax: 10,
                  weightGuidance: "Comfortable for 10",
                }),
                item("bench0a", "barbell_bench_press", 3, {
                  repsMin: 8,
                  repsMax: 10,
                }),
                item("plank0a", "plank", 2, { durationSec: 30, restSec: 45 }),
              ],
            },
            {
              title: "Full body B",
              items: [
                item("pushup0b", "push_up", 3, { repsMin: 8, repsMax: 15 }),
                item("tread0b", "treadmill_run", 1, {
                  durationSec: 900,
                  restSec: 0,
                }),
              ],
            },
            {
              title: "Full body C",
              items: [
                item("squat0c", "barbell_back_squat", 3, {
                  repsMin: 6,
                  repsMax: 8,
                }),
                item("plank0c", "plank", 3, { durationSec: 40, restSec: 45 }),
              ],
            },
          ],
        },
      ],
    },
  });
  await setMyHealthConsent(deps, mctx, { granted: "on" });
  await assignWorkoutPlan(deps, trainer, mctx.memberId, { templateId: t.id });
  const log = await startWorkout(deps, mctx, { dayKey: "w1d1" });
  await logSet(deps, mctx, log.id, {
    exerciseId: ex.barbell_back_squat,
    planItemId: "squat0a",
    setNumber: 1,
    reps: "10",
    weightKg: "40",
  });
  await logSet(deps, mctx, log.id, {
    exerciseId: ex.barbell_back_squat,
    planItemId: "squat0a",
    setNumber: 2,
    reps: "8",
    weightKg: "45",
  });
  await logSet(deps, mctx, log.id, {
    exerciseId: ex.plank,
    planItemId: "plank0a",
    setNumber: 1,
    durationSec: "35",
  });
  await completeWorkout(deps, mctx, log.id, { effort: "6" });
  const today = todayIn(ownerCtx.timezone, new Date());
  await recordAssessment(deps, trainer, mctx.memberId, {
    assessedOn: addDays(today, -28),
    metrics: { weightKg: 82, waistCm: 92 },
  });
  await recordAssessment(deps, trainer, mctx.memberId, {
    metrics: { weightKg: 80.5, waistCm: 90 },
  });
  await addGoalForMember(deps, trainer, mctx.memberId, {
    type: "WEIGHT",
    title: "Reach 76 kg",
    startValue: "82",
    targetValue: "76",
  });
  await assignNutritionPlan(deps, trainer, mctx.memberId, {
    name: "Balanced Indian vegetarian",
    kcalTarget: "2000",
    proteinTarget: "100",
    waterTargetMl: "3000",
    meals: [
      {
        slot: "BREAKFAST",
        time: "08:00",
        description: "2 idli + sambar, 1 glass toned milk",
      },
      { slot: "LUNCH", time: "13:30", description: "2 roti, dal, sabzi, curd" },
      {
        slot: "DINNER",
        time: "20:00",
        description: "Paneer bhurji, 2 roti, salad",
      },
    ],
  });
  const roti = (await searchFoods(deps, mctx, "chapati"))[0];
  if (roti)
    await logFood(deps, mctx, {
      slot: "LUNCH",
      foodItemId: roti.id,
      servings: "2",
    });
  await logWater(deps, mctx, { ml: "500" });
  await publishAnnouncement(deps, ownerCtx, {
    title: "New spin bikes this week",
    body: "Six new bikes are on the first floor. Book the Thursday spin class in the app.",
  });
  const c = await saveChallenge(deps, ownerCtx, null, {
    name: "12 visits this month",
    metric: "VISITS",
    target: "12",
    startsOn: addDays(today, -3),
    endsOn: addDays(today, 27),
    leaderboard: "on",
    points: "150",
  });
  await setChallengeStatus(deps, ownerCtx, c.id, "ACTIVE");
  await joinChallenge(deps, mctx, c.id, {
    displayName: "Early bird",
    showOnBoard: "on",
  });
  await savePerk(deps, ownerCtx, null, {
    name: "Gym shaker bottle",
    pointsCost: "300",
  });
  return true;
}
