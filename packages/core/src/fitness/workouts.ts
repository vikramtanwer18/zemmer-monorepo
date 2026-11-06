import type { Prisma, TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { onWorkoutCompletedTx } from "../engagement/hooks";
import { AppError } from "../errors";
import type { MemberContext } from "../members/self";
import { notify } from "../notifications";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import {
  addDays,
  diffDays,
  fromDbDate,
  todayIn,
  toDbDate,
} from "../time/dates";
import { parseInput } from "../validation";
import { weekStart } from "../engagement/rules";
import { inMemberFitness, inStaffFitness } from "./access";
import { ensureExerciseLibraryTx, exercisesByIdTx } from "./library";
import {
  dayByKey,
  detectRecords,
  nextPlannedDay,
  workoutStructureSchema,
  type RecordKind,
  type WorkoutStructure,
} from "./rules";

const structureInput = z.preprocess(
  (v) => (typeof v === "string" ? JSON.parse(v) : v),
  workoutStructureSchema,
);

async function assertExercisesTx(tx: TenantTransaction, s: WorkoutStructure) {
  const ids = s.weeks.flatMap((w) =>
    w.days.flatMap((d) => d.items.map((i) => i.exerciseId)),
  );
  const found = await exercisesByIdTx(tx, ids);
  const missing = ids.find((id) => !found.has(id));
  if (missing)
    throw new AppError(
      "VALIDATION_FAILED",
      "An exercise in the plan isn't in this gym's library.",
    );
}

// --- templates (fitness.manage) ----------------------------------------------------------------------

const tplGuard = (deps: CoreDeps, ctx: AuthContext, write = false) =>
  guard(deps, ctx, {
    permission: "fitness.manage",
    entitlement: "workouts.enabled",
    write,
  });

export async function listWorkoutTemplates(deps: CoreDeps, ctx: AuthContext) {
  await tplGuard(deps, ctx);
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.workoutTemplate.findMany({
      where: { archivedAt: null },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { plans: true } } },
    });
    return rows.map((r) => {
      const s = workoutStructureSchema.safeParse(r.structure);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        level: r.level,
        weeks: s.success ? s.data.weeks.length : 0,
        daysPerWeek: s.success
          ? Math.max(...s.data.weeks.map((w) => w.days.length))
          : 0,
        assigned: r._count.plans,
        updatedAt: r.updatedAt,
      };
    });
  });
}

export async function getWorkoutTemplate(
  deps: CoreDeps,
  ctx: AuthContext,
  templateId: string,
) {
  await tplGuard(deps, ctx);
  return inTenant(deps, ctx, async (tx) => {
    const t = await tx.workoutTemplate.findUnique({
      where: { id: templateId },
    });
    if (!t || t.archivedAt)
      throw new AppError("NOT_FOUND", "Template not found.");
    const structure = workoutStructureSchema.parse(t.structure);
    const exercises = await exercisesByIdTx(
      tx,
      structure.weeks.flatMap((w) =>
        w.days.flatMap((d) => d.items.map((i) => i.exerciseId)),
      ),
    );
    return {
      ...t,
      structure,
      exercises: Object.fromEntries(
        [...exercises].map(([id, e]) => [
          id,
          { name: e.name, measure: e.measure, equipment: e.equipment },
        ]),
      ),
    };
  });
}

const templateSchema = z.object({
  name: z.string().trim().min(2, "Name it.").max(80),
  description: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().trim().max(500).optional(),
  ),
  level: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]).default("BEGINNER"),
  structure: structureInput,
});

export async function saveWorkoutTemplate(
  deps: CoreDeps,
  ctx: AuthContext,
  templateId: string | null,
  raw: unknown,
) {
  await tplGuard(deps, ctx, true);
  const input = parseInput(templateSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    await ensureExerciseLibraryTx(tx, ctx.tenantId);
    await assertExercisesTx(tx, input.structure);
    const data = {
      name: input.name,
      description: input.description ?? null,
      level: input.level,
      structure: input.structure as unknown as Prisma.InputJsonValue,
    };
    if (templateId) {
      const t = await tx.workoutTemplate.findUnique({
        where: { id: templateId },
      });
      if (!t || t.archivedAt)
        throw new AppError("NOT_FOUND", "Template not found.");
      await tx.workoutTemplate.update({ where: { id: t.id }, data });
      await recordAudit(tx, ctx, {
        action: "workout_template.updated",
        entityType: "WorkoutTemplate",
        entityId: t.id,
        meta: { name: input.name },
      });
      return { id: t.id };
    }
    const t = await tx.workoutTemplate.create({
      data: { tenantId: ctx.tenantId, createdById: ctx.userId, ...data },
    });
    await recordAudit(tx, ctx, {
      action: "workout_template.created",
      entityType: "WorkoutTemplate",
      entityId: t.id,
      meta: { name: input.name },
    });
    return { id: t.id };
  });
}

export async function archiveWorkoutTemplate(
  deps: CoreDeps,
  ctx: AuthContext,
  templateId: string,
) {
  await tplGuard(deps, ctx, true);
  return inTenant(deps, ctx, async (tx) => {
    await tx.workoutTemplate.update({
      where: { id: templateId },
      data: { archivedAt: nowOf(deps) },
    });
    await recordAudit(tx, ctx, {
      action: "workout_template.archived",
      entityType: "WorkoutTemplate",
      entityId: templateId,
    });
  });
}

// --- plans (the member's own copy) -------------------------------------------------------------------

const assignSchema = z.object({
  templateId: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.uuid().optional(),
  ),
  structure: structureInput.optional(),
  name: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().trim().min(2).max(80).optional(),
  ),
  startDate: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  ),
  endDate: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  ),
});

/** Assign: copies the template (or a given structure) into a new plan, version 1. Ends any active plan. */
export async function assignWorkoutPlan(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  const input = parseInput(assignSchema, raw);
  if (!input.templateId && !input.structure)
    throw new AppError("VALIDATION_FAILED", "Pick a template.", {
      fields: { templateId: ["Pick a template."] },
    });
  return inStaffFitness(
    deps,
    ctx,
    memberId,
    "workouts.enabled",
    "write",
    async (tx) => {
      let structure = input.structure;
      let name = input.name;
      if (input.templateId) {
        const t = await tx.workoutTemplate.findUnique({
          where: { id: input.templateId },
        });
        if (!t || t.archivedAt)
          throw new AppError("NOT_FOUND", "Template not found.");
        structure ??= workoutStructureSchema.parse(t.structure);
        name ??= t.name;
      }
      await assertExercisesTx(tx, structure!);
      const today = todayIn(ctx.timezone, nowOf(deps));
      const start = input.startDate ?? today;
      if (input.endDate && input.endDate < start)
        throw new AppError("VALIDATION_FAILED", "Ends before it starts.", {
          fields: { endDate: ["Before the start."] },
        });
      await tx.workoutPlan.updateMany({
        where: { memberId, status: "ACTIVE" },
        data: { status: "ENDED", endDate: toDbDate(today) },
      });
      const plan = await tx.workoutPlan.create({
        data: {
          tenantId: ctx.tenantId,
          memberId,
          templateId: input.templateId ?? null,
          trainerUserId: ctx.userId,
          name: name ?? "Workout plan",
          startDate: toDbDate(start),
          endDate: input.endDate ? toDbDate(input.endDate) : null,
        },
      });
      const v = await tx.workoutPlanVersion.create({
        data: {
          tenantId: ctx.tenantId,
          planId: plan.id,
          version: 1,
          structure: structure as unknown as Prisma.InputJsonValue,
          createdById: ctx.userId,
          note: "Assigned",
        },
      });
      await tx.workoutPlan.update({
        where: { id: plan.id },
        data: { currentVersionId: v.id },
      });
      const member = await tx.memberProfile.findUniqueOrThrow({
        where: { id: memberId },
        select: { firstName: true, userId: true },
      });
      const trainer = await tx.user.findUnique({
        where: { id: ctx.userId },
        select: { name: true },
      });
      if (member.userId)
        await notify(tx, ctx.tenantId, {
          templateKey: "fitness.plan_assigned",
          recipient: { userId: member.userId },
          channels: ["IN_APP"],
          data: {
            name: member.firstName,
            plan: plan.name,
            trainer: trainer?.name ?? "Your trainer",
          },
          link: "/m/workouts",
          dedupeKey: `plan:${plan.id}`,
        });
      await recordAudit(tx, ctx, {
        action: "workout_plan.assigned",
        entityType: "WorkoutPlan",
        entityId: plan.id,
        meta: { memberId, templateId: input.templateId ?? null },
      });
      return { id: plan.id };
    },
  );
}

/** Editing an assigned plan never changes what was logged: it adds the next version. */
export async function updateWorkoutPlan(
  deps: CoreDeps,
  ctx: AuthContext,
  planId: string,
  raw: unknown,
) {
  const input = parseInput(
    z.object({
      structure: structureInput,
      note: z.string().trim().max(200).optional(),
    }),
    raw,
  );
  const plan = await inTenant(deps, ctx, (tx) =>
    tx.workoutPlan.findUnique({ where: { id: planId } }),
  );
  if (!plan) throw new AppError("NOT_FOUND", "Plan not found.");
  return inStaffFitness(
    deps,
    ctx,
    plan.memberId,
    "workouts.enabled",
    "write",
    async (tx) => {
      if (plan.status !== "ACTIVE")
        throw new AppError("CONFLICT", "This plan has ended.");
      await assertExercisesTx(tx, input.structure);
      const last = await tx.workoutPlanVersion.aggregate({
        where: { planId },
        _max: { version: true },
      });
      const v = await tx.workoutPlanVersion.create({
        data: {
          tenantId: ctx.tenantId,
          planId,
          version: (last._max.version ?? 0) + 1,
          structure: input.structure as unknown as Prisma.InputJsonValue,
          createdById: ctx.userId,
          note: input.note ?? null,
        },
      });
      await tx.workoutPlan.update({
        where: { id: planId },
        data: { currentVersionId: v.id },
      });
      await recordAudit(tx, ctx, {
        action: "workout_plan.updated",
        entityType: "WorkoutPlan",
        entityId: planId,
        meta: { version: v.version },
      });
      return { version: v.version };
    },
  );
}

export async function endWorkoutPlan(
  deps: CoreDeps,
  ctx: AuthContext,
  planId: string,
) {
  const plan = await inTenant(deps, ctx, (tx) =>
    tx.workoutPlan.findUnique({ where: { id: planId } }),
  );
  if (!plan) throw new AppError("NOT_FOUND", "Plan not found.");
  return inStaffFitness(
    deps,
    ctx,
    plan.memberId,
    "workouts.enabled",
    "write",
    async (tx) => {
      await tx.workoutPlan.update({
        where: { id: planId },
        data: {
          status: "ENDED",
          endDate: toDbDate(todayIn(ctx.timezone, nowOf(deps))),
        },
      });
      await recordAudit(tx, ctx, {
        action: "workout_plan.ended",
        entityType: "WorkoutPlan",
        entityId: planId,
      });
    },
  );
}

async function planViewTx(tx: TenantTransaction, memberId: string) {
  const plan = await tx.workoutPlan.findFirst({
    where: { memberId, status: "ACTIVE" },
    include: {
      versions: {
        orderBy: { version: "desc" },
        select: { id: true, version: true, note: true, createdAt: true },
      },
    },
  });
  if (!plan?.currentVersionId) return null;
  const version = await tx.workoutPlanVersion.findUniqueOrThrow({
    where: { id: plan.currentVersionId },
  });
  const structure = workoutStructureSchema.parse(version.structure);
  const exercises = await exercisesByIdTx(
    tx,
    structure.weeks.flatMap((w) =>
      w.days.flatMap((d) => d.items.map((i) => i.exerciseId)),
    ),
  );
  return {
    plan,
    version: version.version,
    versionId: version.id,
    structure,
    exercises: Object.fromEntries(
      [...exercises].map(([id, e]) => [
        id,
        {
          name: e.name,
          measure: e.measure,
          equipment: e.equipment,
          instructions: e.instructions,
          mediaUrl: e.mediaUrl,
        },
      ]),
    ),
  };
}

// --- member: today's workout and logging ---------------------------------------------------------------

export async function myWorkoutToday(deps: CoreDeps, mctx: MemberContext) {
  const today = todayIn(mctx.timezone, nowOf(deps));
  return inMemberFitness(deps, mctx, "workouts.enabled", {}, async (tx) => {
    const view = await planViewTx(tx, mctx.memberId);
    const open = await tx.workoutLog.findFirst({
      where: { memberId: mctx.memberId, status: "IN_PROGRESS" },
      orderBy: { startedAt: "desc" },
      include: {
        sets: { orderBy: [{ exerciseId: "asc" }, { setNumber: "asc" }] },
      },
    });
    if (!view) return { plan: null, next: null, open, today };
    const done = await tx.workoutLog.findMany({
      where: {
        memberId: mctx.memberId,
        planId: view.plan.id,
        status: "COMPLETED",
        performedOn: { gte: toDbDate(weekStart(today)) },
      },
      select: { dayKey: true },
    });
    const next = nextPlannedDay(
      view.structure,
      diffDays(fromDbDate(view.plan.startDate), today),
      new Set(done.map((d) => d.dayKey).filter((k): k is string => !!k)),
    );
    return { plan: view, next, open, today, doneThisWeek: done.length };
  });
}

const startSchema = z.object({
  dayKey: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^w\d+d\d+$/)
      .optional(),
  ),
});

export async function startWorkout(
  deps: CoreDeps,
  mctx: MemberContext,
  raw: unknown,
) {
  const { dayKey } = parseInput(startSchema, raw);
  const today = todayIn(mctx.timezone, nowOf(deps));
  return inMemberFitness(
    deps,
    mctx,
    "workouts.enabled",
    { write: true },
    async (tx) => {
      const open = await tx.workoutLog.findFirst({
        where: { memberId: mctx.memberId, status: "IN_PROGRESS" },
      });
      if (open) return { id: open.id };
      const view = await planViewTx(tx, mctx.memberId);
      const day = dayKey && view ? dayByKey(view.structure, dayKey) : null;
      if (dayKey && !day)
        throw new AppError("NOT_FOUND", "That day isn't in your plan.");
      const log = await tx.workoutLog.create({
        data: {
          tenantId: mctx.tenantId,
          memberId: mctx.memberId,
          planId: day ? view!.plan.id : null,
          versionId: day ? view!.versionId : null,
          dayKey: day ? dayKey : null,
          title: day?.title ?? "Free workout",
          performedOn: toDbDate(today),
          createdById: mctx.userId,
        },
      });
      return { id: log.id };
    },
  );
}

const setSchema = z.object({
  exerciseId: z.uuid(),
  planItemId: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().max(24).optional(),
  ),
  setNumber: z.coerce.number().int().min(1).max(50),
  reps: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(0).max(1000).optional(),
  ),
  weightKg: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().min(0).max(1000).optional(),
  ),
  durationSec: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(0).max(86400).optional(),
  ),
  distanceM: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(0).max(200000).optional(),
  ),
  notes: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().trim().max(200).optional(),
  ),
});

async function openLogTx(
  tx: TenantTransaction,
  mctx: MemberContext,
  logId: string,
) {
  const log = await tx.workoutLog.findUnique({ where: { id: logId } });
  // Another member's log looks exactly like a missing one.
  if (!log || log.memberId !== mctx.memberId)
    throw new AppError("NOT_FOUND", "Workout not found.");
  if (log.status !== "IN_PROGRESS")
    throw new AppError("CONFLICT", "This workout is already finished.");
  return log;
}

/** Records (or corrects) one set. Same exercise + set number = the same set. */
export async function logSet(
  deps: CoreDeps,
  mctx: MemberContext,
  logId: string,
  raw: unknown,
) {
  const input = parseInput(setSchema, raw);
  return inMemberFitness(
    deps,
    mctx,
    "workouts.enabled",
    { write: true },
    async (tx) => {
      await openLogTx(tx, mctx, logId);
      const ex = await tx.exercise.findUnique({
        where: { id: input.exerciseId },
      });
      if (!ex) throw new AppError("NOT_FOUND", "Exercise not found.");
      const data = {
        planItemId: input.planItemId ?? null,
        reps: input.reps ?? null,
        weightKg: input.weightKg ?? null,
        durationSec: input.durationSec ?? null,
        distanceM: input.distanceM ?? null,
        notes: input.notes ?? null,
      };
      const row = await tx.setLog.upsert({
        where: {
          tenantId_logId_exerciseId_setNumber: {
            tenantId: mctx.tenantId,
            logId,
            exerciseId: ex.id,
            setNumber: input.setNumber,
          },
        },
        create: {
          tenantId: mctx.tenantId,
          logId,
          exerciseId: ex.id,
          setNumber: input.setNumber,
          ...data,
        },
        update: data,
      });
      return { id: row.id };
    },
  );
}

export async function deleteSet(
  deps: CoreDeps,
  mctx: MemberContext,
  setId: string,
) {
  return inMemberFitness(
    deps,
    mctx,
    "workouts.enabled",
    { write: true },
    async (tx) => {
      const set = await tx.setLog.findUnique({ where: { id: setId } });
      if (!set) throw new AppError("NOT_FOUND", "Set not found.");
      await openLogTx(tx, mctx, set.logId);
      await tx.setLog.delete({ where: { id: set.id } });
    },
  );
}

/** Current bests per (exercise, kind) for a member. */
async function bestsTx(
  tx: TenantTransaction,
  memberId: string,
  exerciseIds: string[],
) {
  const rows = await tx.personalRecord.groupBy({
    by: ["exerciseId", "kind"],
    where: { memberId, exerciseId: { in: exerciseIds } },
    _max: { value: true },
  });
  const map = new Map<string, Partial<Record<RecordKind, number>>>();
  for (const r of rows) {
    const m = map.get(r.exerciseId) ?? {};
    m[r.kind] = Number(r._max.value);
    map.set(r.exerciseId, m);
  }
  return map;
}

const completeSchema = z.object({
  effort: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(1).max(10).optional(),
  ),
  notes: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().trim().max(1000).optional(),
  ),
});

/**
 * Finishes the workout: personal records are worked out from its sets (in order, each beating the
 * best so far), then engagement (points, milestones, challenges) in the same transaction.
 */
export async function completeWorkout(
  deps: CoreDeps,
  mctx: MemberContext,
  logId: string,
  raw: unknown = {},
) {
  const input = parseInput(completeSchema, raw);
  const now = nowOf(deps);
  return inMemberFitness(
    deps,
    mctx,
    "workouts.enabled",
    { write: true },
    async (tx) => {
      await openLogTx(tx, mctx, logId);
      const sets = await tx.setLog.findMany({
        where: { logId },
        orderBy: [{ createdAt: "asc" }, { setNumber: "asc" }],
        include: { exercise: { select: { measure: true, name: true } } },
      });
      if (!sets.length)
        throw new AppError("VALIDATION_FAILED", "Log at least one set first.");
      const claimed = await tx.workoutLog.updateMany({
        where: { id: logId, status: "IN_PROGRESS" },
        data: {
          status: "COMPLETED",
          completedAt: now,
          effort: input.effort ?? null,
          notes: input.notes ?? null,
        },
      });
      if (claimed.count === 0)
        throw new AppError("CONFLICT", "This workout is already finished.");
      const bests = await bestsTx(tx, mctx.memberId, [
        ...new Set(sets.map((s) => s.exerciseId)),
      ]);
      const records: {
        exercise: string;
        kind: RecordKind;
        value: number;
        previous: number | null;
      }[] = [];
      for (const s of sets) {
        const b = bests.get(s.exerciseId) ?? {};
        const found = detectRecords(
          {
            reps: s.reps,
            weightKg: s.weightKg === null ? null : Number(s.weightKg),
            durationSec: s.durationSec,
            distanceM: s.distanceM,
          },
          s.exercise.measure,
          b,
        );
        for (const r of found) {
          await tx.personalRecord.create({
            data: {
              tenantId: mctx.tenantId,
              memberId: mctx.memberId,
              exerciseId: s.exerciseId,
              kind: r.kind,
              value: r.value,
              previous: r.previous,
              setLogId: s.id,
              logId,
              achievedAt: now,
            },
          });
          b[r.kind] = r.value;
          records.push({ exercise: s.exercise.name, ...r });
        }
        bests.set(s.exerciseId, b);
      }
      const log = await tx.workoutLog.findUniqueOrThrow({
        where: { id: logId },
      });
      const engagement = await onWorkoutCompletedTx(
        tx,
        mctx.tenantId,
        mctx.memberId,
        {
          logId,
          performedOn: fromDbDate(log.performedOn),
          newRecords: records.length,
          now,
        },
      );
      return { records, engagement };
    },
  );
}

export async function myWorkoutLog(
  deps: CoreDeps,
  mctx: MemberContext,
  logId: string,
) {
  return inMemberFitness(deps, mctx, "workouts.enabled", {}, async (tx) => {
    const log = await tx.workoutLog.findUnique({
      where: { id: logId },
      include: {
        sets: {
          orderBy: [{ setNumber: "asc" }],
          include: { exercise: { select: { name: true, measure: true } } },
        },
        records: { include: { exercise: { select: { name: true } } } },
      },
    });
    if (!log || log.memberId !== mctx.memberId)
      throw new AppError("NOT_FOUND", "Workout not found.");
    const view = log.versionId
      ? await tx.workoutPlanVersion.findUnique({ where: { id: log.versionId } })
      : null;
    const day =
      view && log.dayKey
        ? dayByKey(workoutStructureSchema.parse(view.structure), log.dayKey)
        : null;
    const exercises = day
      ? await exercisesByIdTx(
          tx,
          day.items.map((i) => i.exerciseId),
        )
      : new Map();
    const feedback = await tx.trainerFeedback.findMany({
      where: {
        memberId: mctx.memberId,
        target: "WORKOUT_LOG",
        targetId: log.id,
      },
      orderBy: { createdAt: "asc" },
    });
    return {
      log,
      day,
      exercises: Object.fromEntries(
        [...exercises].map(([id, e]) => [
          id,
          {
            name: e.name,
            measure: e.measure,
            instructions: e.instructions,
            mediaUrl: e.mediaUrl,
          },
        ]),
      ),
      feedback,
    };
  });
}

export async function myWorkoutHistory(
  deps: CoreDeps,
  mctx: MemberContext,
  take = 30,
) {
  return inMemberFitness(deps, mctx, "workouts.enabled", {}, async (tx) => ({
    logs: await tx.workoutLog.findMany({
      where: { memberId: mctx.memberId, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      take,
      include: { _count: { select: { sets: true, records: true } } },
    }),
    records: await currentRecordsTx(tx, mctx.memberId),
  }));
}

/** The best per exercise and kind, with when it happened. */
export async function currentRecordsTx(
  tx: TenantTransaction,
  memberId: string,
) {
  const rows = await tx.personalRecord.findMany({
    where: { memberId },
    orderBy: { achievedAt: "desc" },
    include: { exercise: { select: { name: true } } },
  });
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.exerciseId}:${r.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Staff (trainer or view_all): the member's plan, recent workouts and records. Audited. */
export async function memberWorkouts(
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
    async (tx, access) => ({
      access,
      plan: await planViewTx(tx, memberId),
      logs: await tx.workoutLog.findMany({
        where: { memberId },
        orderBy: { startedAt: "desc" },
        take: 20,
        include: {
          sets: {
            include: { exercise: { select: { name: true, measure: true } } },
            orderBy: { setNumber: "asc" },
          },
          records: { select: { id: true } },
        },
      }),
      records: await currentRecordsTx(tx, memberId),
      planHistory: await tx.workoutPlan.findMany({
        where: { memberId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          name: true,
          status: true,
          startDate: true,
          endDate: true,
        },
      }),
    }),
    { action: "fitness.workouts_viewed" },
  );
}

/** Days since the plan started, as the member app counts them (for staff previews). */
export function planDay(startDate: Date, today: string) {
  return diffDays(fromDbDate(startDate), today);
}
