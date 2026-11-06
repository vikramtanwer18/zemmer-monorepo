import type { Prisma, TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";
import { EQUIPMENT, EXERCISE_LIBRARY, MUSCLES } from "./exercise-library";

/**
 * The gym's exercise library: the built-in list is copied in on first use (each gym can then hide or
 * add its own), so plans always point at the gym's own rows and RLS stays the same for everything.
 */
export async function ensureExerciseLibraryTx(
  tx: TenantTransaction,
  tenantId: string,
) {
  const has = await tx.exercise.count({ where: { libraryKey: { not: null } } });
  if (has >= EXERCISE_LIBRARY.length) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('exercise-library'), hashtext(${tenantId}))`;
  await tx.exercise.createMany({
    data: EXERCISE_LIBRARY.map((e) => ({
      tenantId,
      libraryKey: e.key,
      name: e.name,
      primaryMuscle: e.primaryMuscle,
      muscleGroups: e.muscleGroups,
      equipment: e.equipment,
      measure: e.measure,
      level: e.level,
      instructions: e.instructions,
    })),
    skipDuplicates: true,
  });
}

const libGuard = (deps: CoreDeps, ctx: AuthContext, write = false) =>
  guard(deps, ctx, {
    permission: "fitness.manage",
    entitlement: "workouts.enabled",
    write,
  });

const listSchema = z.object({
  q: z.string().trim().max(60).optional(),
  muscle: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(MUSCLES).optional(),
  ),
  equipment: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(EQUIPMENT).optional(),
  ),
  includeArchived: z.boolean().optional(),
});

export async function listExercises(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown = {},
) {
  await libGuard(deps, ctx);
  const f = parseInput(listSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    await ensureExerciseLibraryTx(tx, ctx.tenantId);
    return tx.exercise.findMany({
      where: {
        ...(f.includeArchived ? {} : { archivedAt: null }),
        ...(f.q
          ? { name: { contains: f.q, mode: "insensitive" as const } }
          : {}),
        ...(f.muscle
          ? {
              OR: [
                { primaryMuscle: f.muscle },
                { muscleGroups: { has: f.muscle } },
              ],
            }
          : {}),
        ...(f.equipment ? { equipment: f.equipment } : {}),
      },
      orderBy: [{ primaryMuscle: "asc" }, { name: "asc" }],
      take: 500,
    });
  });
}

const httpsUrl = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z
    .url()
    .refine((u) => u.startsWith("https://"), "Use an https:// link.")
    .optional(),
);

const exerciseSchema = z.object({
  name: z.string().trim().min(2, "Name it.").max(80),
  primaryMuscle: z.enum(MUSCLES),
  muscleGroups: z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : (v ?? []),
    z.array(z.enum(MUSCLES)).max(6),
  ),
  equipment: z.enum(EQUIPMENT),
  measure: z.enum(["REPS", "TIME", "DISTANCE"]).default("REPS"),
  level: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]).default("BEGINNER"),
  instructions: z.string().trim().min(10, "Describe how to do it.").max(1500),
  mediaUrl: httpsUrl,
});

export async function saveExercise(
  deps: CoreDeps,
  ctx: AuthContext,
  exerciseId: string | null,
  raw: unknown,
) {
  await libGuard(deps, ctx, true);
  const input = parseInput(exerciseSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const data = {
      ...input,
      muscleGroups: input.muscleGroups.filter((m) => m !== input.primaryMuscle),
      mediaUrl: input.mediaUrl ?? null,
    };
    if (exerciseId) {
      const row = await tx.exercise.findUnique({ where: { id: exerciseId } });
      if (!row) throw new AppError("NOT_FOUND", "Exercise not found.");
      await tx.exercise.update({ where: { id: row.id }, data });
      await recordAudit(tx, ctx, {
        action: "exercise.updated",
        entityType: "Exercise",
        entityId: row.id,
        after: data,
      });
      return { id: row.id };
    }
    const row = await tx.exercise.create({
      data: {
        tenantId: ctx.tenantId,
        custom: true,
        createdById: ctx.userId,
        ...data,
      },
    });
    await recordAudit(tx, ctx, {
      action: "exercise.created",
      entityType: "Exercise",
      entityId: row.id,
      after: data,
    });
    return { id: row.id };
  });
}

export async function setExerciseArchived(
  deps: CoreDeps,
  ctx: AuthContext,
  exerciseId: string,
  archived: boolean,
) {
  await libGuard(deps, ctx, true);
  return inTenant(deps, ctx, async (tx) => {
    await tx.exercise.update({
      where: { id: exerciseId },
      data: { archivedAt: archived ? nowOf(deps) : null },
    });
    await recordAudit(tx, ctx, {
      action: archived ? "exercise.archived" : "exercise.restored",
      entityType: "Exercise",
      entityId: exerciseId,
    });
  });
}

/** Exercises by id (for showing a plan): archived ones still resolve, so old plans keep their names. */
export async function exercisesByIdTx(
  tx: TenantTransaction,
  ids: readonly string[],
) {
  const rows = await tx.exercise.findMany({
    where: { id: { in: [...new Set(ids)] } },
  });
  return new Map(rows.map((r) => [r.id, r] as const));
}

export type ExerciseRow = Prisma.ExerciseGetPayload<object>;
