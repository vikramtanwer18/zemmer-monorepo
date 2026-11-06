import type { Prisma, TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import type { MemberContext } from "../members/self";
import { nowOf, type CoreDeps } from "../tenancy/deps";
import { fromDbDate, todayIn, toDbDate } from "../time/dates";
import { parseInput } from "../validation";
import { inMemberFitness, inStaffFitness } from "./access";
import {
  assessmentMetricsSchema,
  goalProgress,
  METRIC_LABELS,
  type AssessmentMetrics,
  type MetricKey,
} from "./rules";

const dateField = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
);

const assessmentSchema = z.object({
  assessedOn: dateField,
  metrics: z.preprocess(
    (v) => (typeof v === "string" ? JSON.parse(v) : v),
    assessmentMetricsSchema,
  ),
  notes: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().trim().max(1000).optional(),
  ),
});

/** Trainer (assigned) or view_all records measurements and tests. */
export async function recordAssessment(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  const input = parseInput(assessmentSchema, raw);
  const today = todayIn(ctx.timezone, nowOf(deps));
  if (input.assessedOn && input.assessedOn > today)
    throw new AppError("VALIDATION_FAILED", "That date is in the future.", {
      fields: { assessedOn: ["In the future."] },
    });
  return inStaffFitness(
    deps,
    ctx,
    memberId,
    "workouts.enabled",
    "write",
    async (tx) => {
      const row = await tx.fitnessAssessment.create({
        data: {
          tenantId: ctx.tenantId,
          memberId,
          assessedOn: toDbDate(input.assessedOn ?? today),
          metrics: input.metrics as Prisma.InputJsonValue,
          notes: input.notes ?? null,
          assessedByUserId: ctx.userId,
        },
      });
      // Never the values themselves in the audit log (health data).
      await recordAudit(tx, ctx, {
        action: "fitness.assessment_recorded",
        entityType: "FitnessAssessment",
        entityId: row.id,
        meta: { memberId, fields: Object.keys(input.metrics) },
      });
      await refreshGoalsTx(tx, memberId, nowOf(deps));
      return { id: row.id };
    },
  );
}

/** The member can record their own weight / measurements too (shown as "self-reported"). */
export async function recordMyMeasurement(
  deps: CoreDeps,
  mctx: MemberContext,
  raw: unknown,
) {
  const input = parseInput(assessmentSchema, raw);
  const today = todayIn(mctx.timezone, nowOf(deps));
  return inMemberFitness(
    deps,
    mctx,
    "workouts.enabled",
    { write: true },
    async (tx) => {
      const row = await tx.fitnessAssessment.create({
        data: {
          tenantId: mctx.tenantId,
          memberId: mctx.memberId,
          assessedOn: toDbDate(
            input.assessedOn && input.assessedOn <= today
              ? input.assessedOn
              : today,
          ),
          metrics: input.metrics as Prisma.InputJsonValue,
          notes: input.notes ?? null,
        },
      });
      await refreshGoalsTx(tx, mctx.memberId, nowOf(deps));
      return { id: row.id };
    },
  );
}

type Series = {
  key: MetricKey;
  label: string;
  unit: string;
  points: { date: string; value: number; self: boolean }[];
};

async function progressTx(tx: TenantTransaction, memberId: string) {
  const rows = await tx.fitnessAssessment.findMany({
    where: { memberId },
    orderBy: { assessedOn: "asc" },
    take: 500,
  });
  const series = new Map<MetricKey, Series>();
  for (const r of rows) {
    const m = assessmentMetricsSchema.safeParse(r.metrics);
    if (!m.success) continue;
    for (const [k, v] of Object.entries(m.data) as [
      MetricKey,
      number | undefined,
    ][]) {
      if (v === undefined) continue;
      const s = series.get(k) ?? { key: k, ...METRIC_LABELS[k], points: [] };
      s.points.push({
        date: fromDbDate(r.assessedOn),
        value: v,
        self: r.assessedByUserId === null,
      });
      series.set(k, s);
    }
  }
  const records = await tx.personalRecord.findMany({
    where: {
      memberId,
      kind: { in: ["EST_1RM", "MAX_WEIGHT", "MAX_REPS", "MAX_DURATION"] },
    },
    orderBy: { achievedAt: "asc" },
    include: { exercise: { select: { name: true } } },
  });
  const prSeries = new Map<
    string,
    {
      exercise: string;
      kind: string;
      points: { date: string; value: number }[];
    }
  >();
  for (const r of records) {
    const k = `${r.exerciseId}:${r.kind}`;
    const s = prSeries.get(k) ?? {
      exercise: r.exercise.name,
      kind: r.kind,
      points: [],
    };
    s.points.push({
      date: r.achievedAt.toISOString().slice(0, 10),
      value: Number(r.value),
    });
    prSeries.set(k, s);
  }
  const goals = await tx.memberGoal.findMany({
    where: { memberId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  return {
    assessments: rows.map((r) => ({
      id: r.id,
      assessedOn: fromDbDate(r.assessedOn),
      metrics: r.metrics as AssessmentMetrics,
      notes: r.notes,
      self: r.assessedByUserId === null,
    })),
    series: [...series.values()],
    records: [...prSeries.values()].filter((s) => s.points.length >= 1),
    goals: goals.map((g) => ({
      ...g,
      startValue: g.startValue === null ? null : Number(g.startValue),
      targetValue: g.targetValue === null ? null : Number(g.targetValue),
      progress: goalProgress(
        g.startValue === null ? null : Number(g.startValue),
        g.targetValue === null ? null : Number(g.targetValue),
        latestFor(g, series),
      ),
    })),
  };
}

function latestFor(
  g: { type: string; metric: string | null },
  series: Map<MetricKey, Series>,
): number | null {
  if (!g.metric || !(g.metric in METRIC_LABELS)) return null;
  const s = series.get(g.metric as MetricKey);
  return s?.points.at(-1)?.value ?? null;
}

export async function myProgress(deps: CoreDeps, mctx: MemberContext) {
  return inMemberFitness(deps, mctx, "workouts.enabled", {}, (tx) =>
    progressTx(tx, mctx.memberId),
  );
}

export async function memberProgress(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
) {
  return inStaffFitness(
    deps,
    ctx,
    memberId,
    "workouts.enabled",
    "read",
    (tx) => progressTx(tx, memberId),
    { action: "fitness.progress_viewed" },
  );
}

// --- goals ------------------------------------------------------------------------------------

const goalSchema = z.object({
  type: z.enum([
    "WEIGHT",
    "BODY_FAT",
    "MEASUREMENT",
    "STRENGTH",
    "ATTENDANCE",
    "CUSTOM",
  ]),
  title: z.string().trim().min(2, "Describe the goal.").max(120),
  metric: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().max(40).optional(),
  ),
  startValue: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().min(-1000).max(100000).optional(),
  ),
  targetValue: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().min(-1000).max(100000).optional(),
  ),
  deadline: dateField,
});

function goalData(input: z.infer<typeof goalSchema>) {
  const metric =
    input.type === "WEIGHT"
      ? "weightKg"
      : input.type === "BODY_FAT"
        ? "bodyFatPct"
        : (input.metric ?? null);
  if (
    metric &&
    (input.type === "WEIGHT" ||
      input.type === "BODY_FAT" ||
      input.type === "MEASUREMENT") &&
    !(metric in METRIC_LABELS)
  )
    throw new AppError("VALIDATION_FAILED", "Pick a measurement.", {
      fields: { metric: ["Unknown measurement."] },
    });
  return {
    type: input.type,
    title: input.title,
    metric,
    unit:
      metric && metric in METRIC_LABELS
        ? METRIC_LABELS[metric as MetricKey].unit
        : null,
    startValue: input.startValue ?? null,
    targetValue: input.targetValue ?? null,
    deadline: input.deadline ? toDbDate(input.deadline) : null,
  };
}

export async function addGoalForMember(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  const input = parseInput(goalSchema, raw);
  return inStaffFitness(
    deps,
    ctx,
    memberId,
    "workouts.enabled",
    "write",
    async (tx) => {
      const g = await tx.memberGoal.create({
        data: {
          tenantId: ctx.tenantId,
          memberId,
          createdByUserId: ctx.userId,
          ...goalData(input),
        },
      });
      await recordAudit(tx, ctx, {
        action: "fitness.goal_added",
        entityType: "MemberGoal",
        entityId: g.id,
        meta: { memberId, type: input.type },
      });
      return { id: g.id };
    },
  );
}

export async function addMyGoal(
  deps: CoreDeps,
  mctx: MemberContext,
  raw: unknown,
) {
  const input = parseInput(goalSchema, raw);
  return inMemberFitness(
    deps,
    mctx,
    "workouts.enabled",
    { write: true },
    async (tx) => {
      const g = await tx.memberGoal.create({
        data: {
          tenantId: mctx.tenantId,
          memberId: mctx.memberId,
          ...goalData(input),
        },
      });
      return { id: g.id };
    },
  );
}

export async function setMyGoalStatus(
  deps: CoreDeps,
  mctx: MemberContext,
  goalId: string,
  status: "ACHIEVED" | "ABANDONED" | "ACTIVE",
) {
  return inMemberFitness(
    deps,
    mctx,
    "workouts.enabled",
    { write: true },
    async (tx) => {
      const g = await tx.memberGoal.findUnique({ where: { id: goalId } });
      if (!g || g.memberId !== mctx.memberId)
        throw new AppError("NOT_FOUND", "Goal not found.");
      await tx.memberGoal.update({
        where: { id: g.id },
        data: {
          status,
          achievedAt: status === "ACHIEVED" ? nowOf(deps) : null,
        },
      });
    },
  );
}

/** A measurement goal reached by the latest value is marked achieved automatically. */
async function refreshGoalsTx(
  tx: TenantTransaction,
  memberId: string,
  now: Date,
) {
  const goals = await tx.memberGoal.findMany({
    where: {
      memberId,
      status: "ACTIVE",
      metric: { not: null },
      targetValue: { not: null },
    },
  });
  if (!goals.length) return;
  const { series } = {
    series: new Map(
      (await progressTx(tx, memberId)).series.map((s) => [s.key, s] as const),
    ),
  };
  for (const g of goals) {
    const latest = latestFor(g, series);
    const start = g.startValue === null ? null : Number(g.startValue);
    if (latest === null || start === null) continue;
    if (goalProgress(start, Number(g.targetValue), latest) === 100)
      await tx.memberGoal.update({
        where: { id: g.id },
        data: { status: "ACHIEVED", achievedAt: now },
      });
  }
}
