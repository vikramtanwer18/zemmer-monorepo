import type { TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import { inMemberFitness, inStaffFitness } from "../fitness/access";
import type { MemberContext } from "../members/self";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { addDays, fromDbDate, todayIn, toDbDate } from "../time/dates";
import { parseInput } from "../validation";
import { weekStart } from "../engagement/rules";
import { FOOD_LIBRARY } from "./food-library";
import {
  assumptionsFor,
  estimateMacros,
  macrosLookOff,
  sumMacros,
  weeklySummary,
  type Macros,
} from "./rules";

export const ESTIMATE_NOTE =
  "Calories and macros are estimates from typical values and your portion. Recipes and oil change them; correct any entry if you know better.";

export async function ensureFoodLibraryTx(
  tx: TenantTransaction,
  tenantId: string,
) {
  const has = await tx.foodItem.count({ where: { libraryKey: { not: null } } });
  if (has >= FOOD_LIBRARY.length) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('food-library'), hashtext(${tenantId}))`;
  await tx.foodItem.createMany({
    data: FOOD_LIBRARY.map((f) => ({
      tenantId,
      libraryKey: f.key,
      name: f.name,
      servingName: f.servingName,
      servingGrams: f.servingGrams,
      kcal100: f.kcal,
      protein100: f.protein,
      carbs100: f.carbs,
      fat100: f.fat,
      source: f.source,
    })),
    skipDuplicates: true,
  });
}

const per100 = (f: {
  kcal100: unknown;
  protein100: unknown;
  carbs100: unknown;
  fat100: unknown;
}) => ({
  kcal: Number(f.kcal100),
  protein: Number(f.protein100),
  carbs: Number(f.carbs100),
  fat: Number(f.fat100),
});

/** Food search for members and trainers (the gym's own list). */
async function searchFoodsTx(
  tx: TenantTransaction,
  tenantId: string,
  q: string | undefined,
) {
  await ensureFoodLibraryTx(tx, tenantId);
  const rows = await tx.foodItem.findMany({
    where: {
      archivedAt: null,
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
    },
    orderBy: { name: "asc" },
    take: q ? 30 : 200,
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    servingName: r.servingName,
    servingGrams: r.servingGrams,
    source: r.source,
    custom: r.custom,
    ...per100(r),
  }));
}

export async function searchFoods(
  deps: CoreDeps,
  mctx: MemberContext,
  q?: string,
) {
  return inMemberFitness(deps, mctx, "nutrition.enabled", {}, (tx) =>
    searchFoodsTx(tx, mctx.tenantId, q?.trim().slice(0, 60) || undefined),
  );
}

export async function listFoodLibrary(
  deps: CoreDeps,
  ctx: AuthContext,
  q?: string,
) {
  await guard(deps, ctx, {
    permission: "fitness.manage",
    entitlement: "nutrition.enabled",
  });
  return inTenant(deps, ctx, (tx) =>
    searchFoodsTx(tx, ctx.tenantId, q?.trim().slice(0, 60) || undefined),
  );
}

const foodSchema = z.object({
  name: z.string().trim().min(2).max(80),
  servingName: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().trim().max(40).optional(),
  ),
  servingGrams: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(1).max(2000).optional(),
  ),
  kcal: z.coerce.number().min(0).max(950),
  protein: z.coerce.number().min(0).max(100),
  carbs: z.coerce.number().min(0).max(100),
  fat: z.coerce.number().min(0).max(100),
  source: z
    .string()
    .trim()
    .min(2, "Say where the numbers come from (label, app, table).")
    .max(80),
});

export async function saveFoodItem(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, {
    permission: "fitness.manage",
    entitlement: "nutrition.enabled",
    write: true,
  });
  const f = parseInput(foodSchema, raw);
  if (f.protein + f.carbs + f.fat > 100)
    throw new AppError(
      "VALIDATION_FAILED",
      "Protein + carbs + fat can't be more than 100 g per 100 g.",
    );
  return inTenant(deps, ctx, async (tx) => {
    const row = await tx.foodItem.create({
      data: {
        tenantId: ctx.tenantId,
        name: f.name,
        servingName: f.servingName ?? null,
        servingGrams: f.servingGrams ?? null,
        kcal100: f.kcal,
        protein100: f.protein,
        carbs100: f.carbs,
        fat100: f.fat,
        source: f.source,
        custom: true,
        createdById: ctx.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: "food_item.created",
      entityType: "FoodItem",
      entityId: row.id,
      meta: { name: f.name },
    });
    return { id: row.id };
  });
}

// --- diet plans (trainer) -------------------------------------------------------------------------

const mealSchema = z.object({
  slot: z.enum([
    "BREAKFAST",
    "MORNING_SNACK",
    "LUNCH",
    "EVENING_SNACK",
    "DINNER",
    "OTHER",
  ]),
  time: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
  ),
  description: z.string().trim().min(2).max(200),
  foodItemId: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.uuid().optional(),
  ),
  portionGrams: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(1).max(2000).optional(),
  ),
});

const target = (max: number) =>
  z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(0).max(max).optional(),
  );

const planSchema = z.object({
  name: z.string().trim().min(2).max(80),
  startDate: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  ),
  kcalTarget: target(8000),
  proteinTarget: target(500),
  carbsTarget: target(1000),
  fatTarget: target(400),
  waterTargetMl: target(10000),
  notes: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().trim().max(1000).optional(),
  ),
  meals: z
    .preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.array(mealSchema).max(30),
    )
    .default([]),
});

/** A new diet plan replaces the active one. */
export async function assignNutritionPlan(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  const input = parseInput(planSchema, raw);
  return inStaffFitness(
    deps,
    ctx,
    memberId,
    "nutrition.enabled",
    "write",
    async (tx) => {
      const today = todayIn(ctx.timezone, nowOf(deps));
      await tx.nutritionPlan.updateMany({
        where: { memberId, status: "ACTIVE" },
        data: { status: "ENDED", endDate: toDbDate(today) },
      });
      const plan = await tx.nutritionPlan.create({
        data: {
          tenantId: ctx.tenantId,
          memberId,
          name: input.name,
          startDate: toDbDate(input.startDate ?? today),
          kcalTarget: input.kcalTarget ?? null,
          proteinTarget: input.proteinTarget ?? null,
          carbsTarget: input.carbsTarget ?? null,
          fatTarget: input.fatTarget ?? null,
          waterTargetMl: input.waterTargetMl ?? null,
          notes: input.notes ?? null,
          createdByUserId: ctx.userId,
        },
      });
      if (input.meals.length)
        await tx.mealPlanItem.createMany({
          data: input.meals.map((m, i) => ({
            tenantId: ctx.tenantId,
            planId: plan.id,
            position: i,
            slot: m.slot,
            time: m.time ?? null,
            description: m.description,
            foodItemId: m.foodItemId ?? null,
            portionGrams: m.portionGrams ?? null,
          })),
        });
      await recordAudit(tx, ctx, {
        action: "nutrition_plan.assigned",
        entityType: "NutritionPlan",
        entityId: plan.id,
        meta: { memberId },
      });
      return { id: plan.id };
    },
  );
}

async function activePlanTx(tx: TenantTransaction, memberId: string) {
  return tx.nutritionPlan.findFirst({
    where: { memberId, status: "ACTIVE" },
    include: {
      meals: {
        orderBy: [{ slot: "asc" }, { position: "asc" }],
        include: { foodItem: { select: { name: true } } },
      },
    },
  });
}

// --- food and water logs (member) -----------------------------------------------------------------

const logSchema = z
  .object({
    loggedOn: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    ),
    slot: z.enum([
      "BREAKFAST",
      "MORNING_SNACK",
      "LUNCH",
      "EVENING_SNACK",
      "DINNER",
      "OTHER",
    ]),
    foodItemId: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.uuid().optional(),
    ),
    servings: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().min(0.25).max(20).optional(),
    ),
    grams: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().min(1).max(3000).optional(),
    ),
    // Custom entry (no library item): the member's own numbers.
    name: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().trim().min(2).max(80).optional(),
    ),
    kcal: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().min(0).max(5000).optional(),
    ),
    proteinG: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().min(0).max(500).optional(),
    ),
    carbsG: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().min(0).max(1000).optional(),
    ),
    fatG: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().min(0).max(500).optional(),
    ),
  })
  .refine((v) => v.foodItemId || (v.name && v.kcal !== undefined), {
    message: "Pick a food, or enter a name and calories.",
    path: ["foodItemId"],
  });

/** Library item × portion (estimated, source + assumptions stored) or the member's own numbers. */
export async function logFood(
  deps: CoreDeps,
  mctx: MemberContext,
  raw: unknown,
) {
  const input = parseInput(logSchema, raw);
  const today = todayIn(mctx.timezone, nowOf(deps));
  const day =
    input.loggedOn &&
    input.loggedOn <= today &&
    input.loggedOn >= addDays(today, -7)
      ? input.loggedOn
      : today;
  return inMemberFitness(
    deps,
    mctx,
    "nutrition.enabled",
    { write: true },
    async (tx) => {
      if (input.foodItemId) {
        const food = await tx.foodItem.findUnique({
          where: { id: input.foodItemId },
        });
        if (!food) throw new AppError("NOT_FOUND", "Food not found.");
        const grams =
          input.grams ??
          (input.servings && food.servingGrams
            ? Math.round(input.servings * food.servingGrams * 10) / 10
            : (food.servingGrams ?? 100));
        const m = estimateMacros(per100(food), grams);
        const row = await tx.foodLog.create({
          data: {
            tenantId: mctx.tenantId,
            memberId: mctx.memberId,
            loggedOn: toDbDate(day),
            slot: input.slot,
            foodItemId: food.id,
            name: food.name,
            portionGrams: grams,
            kcal: m.kcal,
            proteinG: m.proteinG,
            carbsG: m.carbsG,
            fatG: m.fatG,
            source: "LIBRARY",
            assumptions: assumptionsFor({
              foodName: food.name,
              source: food.source,
              grams,
              servings: input.grams ? null : (input.servings ?? null),
              servingName: food.servingName,
            }),
          },
        });
        return { id: row.id, ...m };
      }
      const m: Macros = {
        kcal: input.kcal!,
        proteinG: input.proteinG ?? 0,
        carbsG: input.carbsG ?? 0,
        fatG: input.fatG ?? 0,
      };
      const row = await tx.foodLog.create({
        data: {
          tenantId: mctx.tenantId,
          memberId: mctx.memberId,
          loggedOn: toDbDate(day),
          slot: input.slot,
          name: input.name!,
          portionGrams: input.grams ?? null,
          ...m,
          source: "CUSTOM",
          assumptions: `Entered by you${input.grams ? ` for ${input.grams} g` : ""}.${macrosLookOff(m) ? " Calories don't match the macros (4/4/9 kcal per g); check the numbers." : ""}`,
          corrected: true,
        },
      });
      return { id: row.id, ...m };
    },
  );
}

const correctSchema = z.object({
  kcal: z.coerce.number().min(0).max(5000),
  proteinG: z.coerce.number().min(0).max(500),
  carbsG: z.coerce.number().min(0).max(1000),
  fatG: z.coerce.number().min(0).max(500),
});

/** The member corrects an estimate; the entry is marked corrected and keeps its original assumptions. */
export async function correctFoodLog(
  deps: CoreDeps,
  mctx: MemberContext,
  logId: string,
  raw: unknown,
) {
  const input = parseInput(correctSchema, raw);
  return inMemberFitness(
    deps,
    mctx,
    "nutrition.enabled",
    { write: true },
    async (tx) => {
      const row = await tx.foodLog.findUnique({ where: { id: logId } });
      if (!row || row.memberId !== mctx.memberId)
        throw new AppError("NOT_FOUND", "Entry not found.");
      await tx.foodLog.update({
        where: { id: row.id },
        data: {
          ...input,
          corrected: true,
          assumptions: row.corrected
            ? row.assumptions
            : `${row.assumptions} Corrected by you.`,
        },
      });
    },
  );
}

export async function deleteFoodLog(
  deps: CoreDeps,
  mctx: MemberContext,
  logId: string,
) {
  return inMemberFitness(
    deps,
    mctx,
    "nutrition.enabled",
    { write: true },
    async (tx) => {
      const row = await tx.foodLog.findUnique({ where: { id: logId } });
      if (!row || row.memberId !== mctx.memberId)
        throw new AppError("NOT_FOUND", "Entry not found.");
      await tx.foodLog.delete({ where: { id: row.id } });
    },
  );
}

export async function logWater(
  deps: CoreDeps,
  mctx: MemberContext,
  raw: unknown,
) {
  const { ml } = parseInput(
    z.object({ ml: z.coerce.number().int().min(50).max(2000) }),
    raw,
  );
  const today = todayIn(mctx.timezone, nowOf(deps));
  return inMemberFitness(
    deps,
    mctx,
    "nutrition.enabled",
    { write: true },
    async (tx) => {
      await tx.waterLog.create({
        data: {
          tenantId: mctx.tenantId,
          memberId: mctx.memberId,
          loggedOn: toDbDate(today),
          ml,
        },
      });
    },
  );
}

export async function undoLastWater(deps: CoreDeps, mctx: MemberContext) {
  const today = todayIn(mctx.timezone, nowOf(deps));
  return inMemberFitness(
    deps,
    mctx,
    "nutrition.enabled",
    { write: true },
    async (tx) => {
      const last = await tx.waterLog.findFirst({
        where: { memberId: mctx.memberId, loggedOn: toDbDate(today) },
        orderBy: { createdAt: "desc" },
      });
      if (last) await tx.waterLog.delete({ where: { id: last.id } });
    },
  );
}

async function dayTx(tx: TenantTransaction, memberId: string, date: string) {
  const [foods, water] = [
    await tx.foodLog.findMany({
      where: { memberId, loggedOn: toDbDate(date) },
      orderBy: { createdAt: "asc" },
    }),
    await tx.waterLog.aggregate({
      where: { memberId, loggedOn: toDbDate(date) },
      _sum: { ml: true },
    }),
  ];
  const items = foods.map((f) => ({
    ...f,
    kcal: Number(f.kcal),
    proteinG: Number(f.proteinG),
    carbsG: Number(f.carbsG),
    fatG: Number(f.fatG),
    portionGrams: f.portionGrams === null ? null : Number(f.portionGrams),
  }));
  return { date, items, totals: sumMacros(items), waterMl: water._sum.ml ?? 0 };
}

async function weekTx(
  tx: TenantTransaction,
  memberId: string,
  today: string,
  plan: Awaited<ReturnType<typeof activePlanTx>>,
) {
  const start = weekStart(today);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    if (d > today) break;
    const day = await dayTx(tx, memberId, d);
    days.push({ date: d, ...day.totals, waterMl: day.waterMl });
  }
  return {
    from: start,
    days,
    summary: weeklySummary(days, {
      kcal: plan?.kcalTarget ?? null,
      protein: plan?.proteinTarget ?? null,
      carbs: plan?.carbsTarget ?? null,
      fat: plan?.fatTarget ?? null,
      waterMl: plan?.waterTargetMl ?? null,
    }),
  };
}

export async function myNutritionDay(
  deps: CoreDeps,
  mctx: MemberContext,
  date?: string,
) {
  const today = todayIn(mctx.timezone, nowOf(deps));
  const day =
    date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today ? date : today;
  return inMemberFitness(deps, mctx, "nutrition.enabled", {}, async (tx) => {
    const plan = await activePlanTx(tx, mctx.memberId);
    return {
      today,
      plan,
      day: await dayTx(tx, mctx.memberId, day),
      week: await weekTx(tx, mctx.memberId, today, plan),
      note: ESTIMATE_NOTE,
    };
  });
}

/** Staff (trainer / view_all): the member's plan, this week and the last few days' logs. Audited. */
export async function memberNutrition(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
) {
  const today = todayIn(ctx.timezone, nowOf(deps));
  return inStaffFitness(
    deps,
    ctx,
    memberId,
    "nutrition.enabled",
    "read",
    async (tx) => {
      const plan = await activePlanTx(tx, memberId);
      const recent = [];
      for (let i = 0; i < 3; i++)
        recent.push(await dayTx(tx, memberId, addDays(today, -i)));
      return {
        plan,
        week: await weekTx(tx, memberId, today, plan),
        recent,
        note: ESTIMATE_NOTE,
      };
    },
    { action: "fitness.nutrition_viewed" },
  );
}
