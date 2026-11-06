import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import { guard, inTenant, type CoreDeps } from "../tenancy/deps";
import { fromDbDate } from "../time/dates";
import { healthConsentTx } from "./access";

/**
 * A member's health and fitness data as JSON, for a member's own request handled by the gym
 * (fitness.export: Owner/Admin). General member exports never include any of this.
 */
export async function exportMemberFitnessData(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
) {
  await guard(deps, ctx, { permission: "fitness.export" });
  return inTenant(deps, ctx, async (tx) => {
    const m = await tx.memberProfile.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        memberCode: true,
        firstName: true,
        lastName: true,
        anonymizedAt: true,
      },
    });
    if (!m || m.anonymizedAt)
      throw new AppError("NOT_FOUND", "Member not found.");
    const [
      plans,
      logs,
      records,
      assessments,
      goals,
      nutrition,
      foods,
      water,
      feedback,
    ] = [
      await tx.workoutPlan.findMany({
        where: { memberId },
        include: { versions: true },
      }),
      await tx.workoutLog.findMany({
        where: { memberId },
        include: {
          sets: { include: { exercise: { select: { name: true } } } },
        },
      }),
      await tx.personalRecord.findMany({
        where: { memberId },
        include: { exercise: { select: { name: true } } },
      }),
      await tx.fitnessAssessment.findMany({ where: { memberId } }),
      await tx.memberGoal.findMany({ where: { memberId } }),
      await tx.nutritionPlan.findMany({
        where: { memberId },
        include: { meals: true },
      }),
      await tx.foodLog.findMany({ where: { memberId } }),
      await tx.waterLog.findMany({ where: { memberId } }),
      await tx.trainerFeedback.findMany({ where: { memberId } }),
    ];
    await recordAudit(tx, ctx, {
      action: "fitness.exported",
      entityType: "MemberProfile",
      entityId: memberId,
    });
    const json = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        member: {
          memberCode: m.memberCode,
          name: [m.firstName, m.lastName].filter(Boolean).join(" "),
        },
        consent: await healthConsentTx(tx, memberId),
        plans,
        workouts: logs,
        personalRecords: records,
        assessments: assessments.map((a) => ({
          ...a,
          assessedOn: fromDbDate(a.assessedOn),
        })),
        goals,
        nutritionPlans: nutrition,
        foodLogs: foods,
        waterLogs: water,
        trainerFeedback: feedback,
      },
      (_k, v) => (typeof v === "bigint" ? Number(v) : v),
      2,
    );
    return { filename: `fitness-${m.memberCode}.json`, json };
  });
}
