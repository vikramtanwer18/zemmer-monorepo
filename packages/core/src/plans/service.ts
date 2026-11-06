import type { Prisma, TenantTransaction } from "@gym/db";
import { inOrder } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { requirePermission, type AuthContext } from "../authz";
import { AppError } from "../errors";
import { parseMajorToMinor } from "../money";
import { slugify } from "../tenancy/onboarding";
import { guard, inTenant, type CoreDeps } from "../tenancy/deps";
import { isLocalDate, toDbDate } from "../time/dates";
import { parseInput } from "../validation";

const rupees = (label: string, required = true) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (!v) {
        if (required)
          ctx.addIssue({ code: "custom", message: `Enter the ${label}.` });
        return 0;
      }
      const minor = parseMajorToMinor(v);
      if (minor === null) {
        ctx.addIssue({
          code: "custom",
          message: `Enter the ${label} in rupees, e.g. 1180 or 1180.50.`,
        });
        return 0;
      }
      return minor;
    });

const intField = (min: number, max: number, fallback: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({
          code: "custom",
          message: `Use a whole number from ${min} to ${max}.`,
        });
        return fallback;
      }
      return n;
    });

const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true");

/** Entitlements consumed from M3 (class credits, PT sessions). null = unlimited, 0 = none. */
export const entitlementsSchema = z.object({
  classCredits: z.number().int().min(0).nullable().default(0),
  ptSessions: z.number().int().min(0).nullable().default(0),
});
export type PlanEntitlements = z.infer<typeof entitlementsSchema>;

const optionalCount = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx): number | null => {
    if (!v || v.toLowerCase() === "unlimited") return v ? null : 0;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      ctx.addIssue({
        code: "custom",
        message: "Use a whole number, or 'unlimited'.",
      });
      return 0;
    }
    return n;
  });

export const GST_RATES_BPS = [0, 500, 1200, 1800, 2800] as const;

export const planInputSchema = z
  .object({
    name: z.string().trim().min(2, "Enter the plan name.").max(80),
    description: z.string().trim().max(500).optional(),
    price: rupees("price"),
    joiningFee: rupees("joining fee", false),
    durationUnit: z.enum(["DAY", "MONTH", "YEAR"]),
    durationCount: intField(1, 120, 1),
    taxRateBps: z.coerce
      .number()
      .int()
      .refine(
        (v) => (GST_RATES_BPS as readonly number[]).includes(v),
        "Pick a GST rate.",
      ),
    sacCode: z
      .string()
      .trim()
      .regex(/^\d{4,8}$/, "SAC codes are 4–8 digits, e.g. 999723."),
    isTrial: checkbox,
    accessScope: z.enum(["ALL_BRANCHES", "HOME_BRANCH", "LISTED_BRANCHES"]),
    /** Where it's sold (and, for LISTED_BRANCHES, where it gives access). Empty = all. */
    branchIds: z
      .union([z.uuid(), z.array(z.uuid())])
      .optional()
      .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
    freezeMaxDays: intField(0, 365, 0),
    freezeMaxTimes: intField(0, 12, 0),
    freezeFee: rupees("freeze fee", false),
    graceDays: intField(0, 60, 0),
    allowAddOn: checkbox,
    refundRule: z.enum(["NONE", "PRORATA", "FULL_BEFORE_START"]),
    cancellationPolicy: z.string().trim().max(1000).optional(),
    classCredits: optionalCount,
    ptSessions: optionalCount,
  })
  .refine(
    (v) => v.accessScope !== "LISTED_BRANCHES" || v.branchIds.length > 0,
    {
      path: ["branchIds"],
      message: "Pick the branches this plan gives access to.",
    },
  );

function toPlanData(input: z.infer<typeof planInputSchema>) {
  return {
    name: input.name,
    description: input.description || null,
    priceMinor: input.price,
    joiningFeeMinor: input.joiningFee,
    durationUnit: input.durationUnit,
    durationCount: input.durationCount,
    taxRateBps: input.taxRateBps,
    sacCode: input.sacCode,
    isTrial: input.isTrial,
    accessScope: input.accessScope,
    freezeMaxDays: input.freezeMaxDays,
    freezeMaxTimes: input.freezeMaxTimes,
    freezeFeeMinor: input.freezeFee,
    graceDays: input.graceDays,
    allowAddOn: input.allowAddOn,
    refundRule: input.refundRule,
    cancellationPolicy: input.cancellationPolicy || null,
    entitlements: entitlementsSchema.parse({
      classCredits: input.classCredits,
      ptSessions: input.ptSessions,
    }),
  } satisfies Omit<
    Prisma.MembershipPlanUncheckedCreateInput,
    "tenantId" | "code"
  >;
}

async function setPlanBranches(
  tx: TenantTransaction,
  tenantId: string,
  planId: string,
  branchIds: string[],
) {
  if (branchIds.length) {
    const found = await tx.branch.count({
      where: { id: { in: branchIds }, status: "ACTIVE" },
    });
    if (found !== new Set(branchIds).size)
      throw new AppError("VALIDATION_FAILED", "Pick active branches.");
  }
  await tx.planBranch.deleteMany({ where: { planId } });
  if (branchIds.length) {
    await tx.planBranch.createMany({
      data: [...new Set(branchIds)].map((branchId) => ({
        tenantId,
        planId,
        branchId,
      })),
    });
  }
}

export async function createPlan(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "plans.manage", write: true });
  const input = parseInput(planInputSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const base = slugify(input.name).slice(0, 30);
    let code = base;
    for (let i = 2; await tx.membershipPlan.findFirst({ where: { code } }); i++)
      code = `${base}-${i}`;
    const plan = await tx.membershipPlan.create({
      data: { tenantId: ctx.tenantId, code, version: 1, ...toPlanData(input) },
    });
    await setPlanBranches(tx, ctx.tenantId, plan.id, input.branchIds);
    await recordAudit(tx, ctx, {
      action: "plan.created",
      entityType: "MembershipPlan",
      entityId: plan.id,
      after: { code, ...toPlanData(input) },
    });
    return plan;
  });
}

/**
 * Edits a plan. If it has been sold, the edit becomes code@version+1 and the old version is
 * archived, so existing memberships keep the terms they bought.
 */
export async function updatePlan(
  deps: CoreDeps,
  ctx: AuthContext,
  planId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "plans.manage", write: true });
  const input = parseInput(planInputSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const plan = await tx.membershipPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new AppError("NOT_FOUND", "Plan not found.");
    if (plan.status !== "ACTIVE")
      throw new AppError("CONFLICT", "Restore the plan before editing it.");
    const latest = await tx.membershipPlan.findFirst({
      where: { code: plan.code },
      orderBy: { version: "desc" },
    });
    if (latest && latest.id !== plan.id)
      throw new AppError("CONFLICT", "Edit the newest version of this plan.");
    const sold = await tx.membership.count({ where: { planId } });
    const data = toPlanData(input);
    if (sold === 0) {
      const updated = await tx.membershipPlan.update({
        where: { id: planId },
        data,
      });
      await setPlanBranches(tx, ctx.tenantId, planId, input.branchIds);
      await recordAudit(tx, ctx, {
        action: "plan.updated",
        entityType: "MembershipPlan",
        entityId: planId,
        after: data,
      });
      return { plan: updated, newVersion: false };
    }
    await tx.membershipPlan.update({
      where: { id: planId },
      data: { status: "ARCHIVED" },
    });
    const next = await tx.membershipPlan.create({
      data: {
        tenantId: ctx.tenantId,
        code: plan.code,
        version: plan.version + 1,
        ...data,
      },
    });
    await setPlanBranches(tx, ctx.tenantId, next.id, input.branchIds);
    await recordAudit(tx, ctx, {
      action: "plan.version_created",
      entityType: "MembershipPlan",
      entityId: next.id,
      meta: {
        code: plan.code,
        from: plan.version,
        to: next.version,
        soldOnPrevious: sold,
      },
      after: data,
    });
    return { plan: next, newVersion: true };
  });
}

export async function setPlanArchived(
  deps: CoreDeps,
  ctx: AuthContext,
  planId: string,
  archived: boolean,
) {
  await guard(deps, ctx, { permission: "plans.manage", write: true });
  return inTenant(deps, ctx, async (tx) => {
    const plan = await tx.membershipPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new AppError("NOT_FOUND", "Plan not found.");
    if (!archived) {
      const latest = await tx.membershipPlan.findFirst({
        where: { code: plan.code },
        orderBy: { version: "desc" },
      });
      if (latest?.id !== plan.id)
        throw new AppError(
          "CONFLICT",
          "Only the newest version of a plan can be restored.",
        );
    }
    const updated = await tx.membershipPlan.update({
      where: { id: planId },
      data: { status: archived ? "ARCHIVED" : "ACTIVE" },
    });
    await recordAudit(tx, ctx, {
      action: archived ? "plan.archived" : "plan.restored",
      entityType: "MembershipPlan",
      entityId: planId,
    });
    return updated;
  });
}

/** Newest version of each plan code, sellable first. */
export async function listPlans(
  deps: CoreDeps,
  ctx: AuthContext,
  options: { includeArchived?: boolean } = {},
) {
  requirePermission(ctx, "memberships.view");
  return inTenant(deps, ctx, async (tx) => {
    const plans = await tx.membershipPlan.findMany({
      include: {
        branches: { include: { branch: { select: { name: true } } } },
        _count: { select: { memberships: true } },
      },
      orderBy: [{ code: "asc" }, { version: "desc" }],
    });
    const newest = new Map<string, (typeof plans)[number]>();
    for (const p of plans) if (!newest.has(p.code)) newest.set(p.code, p);
    return [...newest.values()]
      .filter((p) => options.includeArchived || p.status === "ACTIVE")
      .sort((a, b) =>
        a.status === b.status
          ? a.name.localeCompare(b.name)
          : a.status === "ACTIVE"
            ? -1
            : 1,
      );
  });
}

export async function getPlan(
  deps: CoreDeps,
  ctx: AuthContext,
  planId: string,
) {
  requirePermission(ctx, "memberships.view");
  return inTenant(deps, ctx, async (tx) => {
    const plan = await tx.membershipPlan.findUnique({
      where: { id: planId },
      include: { branches: true },
    });
    if (!plan) throw new AppError("NOT_FOUND", "Plan not found.");
    const [versions, sold] = await inOrder([
      tx.membershipPlan.findMany({
        where: { code: plan.code },
        orderBy: { version: "desc" },
        select: { id: true, version: true, status: true, createdAt: true },
      }),
      tx.membership.count({ where: { planId } }),
    ]);
    return { plan, versions, sold };
  });
}

/** Plans the context can sell at a branch (PlanBranch empty = every branch). */
export async function sellablePlans(tx: TenantTransaction, branchId: string) {
  return tx.membershipPlan.findMany({
    where: {
      status: "ACTIVE",
      OR: [{ branches: { none: {} } }, { branches: { some: { branchId } } }],
    },
    orderBy: { name: "asc" },
  });
}

// --- coupons ----------------------------------------------------------------------------------

export const couponInputSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{3,20}$/, "3–20 letters, digits or dashes."),
    kind: z.enum(["PERCENT", "FLAT"]),
    percent: z.string().trim().optional(),
    amount: rupees("amount", false),
    validFrom: z
      .string()
      .optional()
      .refine((v) => !v || isLocalDate(v), "Enter a valid date."),
    validTo: z
      .string()
      .optional()
      .refine((v) => !v || isLocalDate(v), "Enter a valid date."),
    maxRedemptions: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? Number(v) : null))
      .refine(
        (v) => v === null || (Number.isInteger(v) && v > 0),
        "Use a whole number.",
      ),
    planCodes: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
  })
  .transform((v, ctx) => {
    let value = v.amount;
    if (v.kind === "PERCENT") {
      const pct = Number(v.percent);
      if (
        !v.percent ||
        !Number.isFinite(pct) ||
        pct <= 0 ||
        pct > 100 ||
        Math.round(pct * 100) !== pct * 100
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["percent"],
          message: "Enter a percentage from 0.01 to 100.",
        });
      }
      value = Math.round(pct * 100);
    } else if (value <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: "Enter the discount in rupees.",
      });
    }
    if (v.validFrom && v.validTo && v.validTo < v.validFrom) {
      ctx.addIssue({
        code: "custom",
        path: ["validTo"],
        message: "The end date is before the start date.",
      });
    }
    return { ...v, value };
  });

export async function createCoupon(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "plans.manage", write: true });
  const input = parseInput(couponInputSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    if (
      await tx.coupon.findUnique({
        where: { tenantId_code: { tenantId: ctx.tenantId, code: input.code } },
      })
    ) {
      throw new AppError("CONFLICT", "That code is already used.", {
        fields: { code: ["That code is already used."] },
      });
    }
    const coupon = await tx.coupon.create({
      data: {
        tenantId: ctx.tenantId,
        code: input.code,
        kind: input.kind,
        value: input.value,
        validFrom: input.validFrom ? toDbDate(input.validFrom) : null,
        validTo: input.validTo ? toDbDate(input.validTo) : null,
        maxRedemptions: input.maxRedemptions,
        planCodes: input.planCodes,
      },
    });
    await recordAudit(tx, ctx, {
      action: "coupon.created",
      entityType: "Coupon",
      entityId: coupon.id,
      after: { code: coupon.code, kind: coupon.kind, value: coupon.value },
    });
    return coupon;
  });
}

export async function setCouponArchived(
  deps: CoreDeps,
  ctx: AuthContext,
  couponId: string,
  archived: boolean,
) {
  await guard(deps, ctx, { permission: "plans.manage", write: true });
  return inTenant(deps, ctx, async (tx) => {
    const coupon = await tx.coupon.update({
      where: { id: couponId },
      data: { status: archived ? "ARCHIVED" : "ACTIVE" },
    });
    await recordAudit(tx, ctx, {
      action: archived ? "coupon.archived" : "coupon.restored",
      entityType: "Coupon",
      entityId: couponId,
    });
    return coupon;
  });
}

export async function listCoupons(deps: CoreDeps, ctx: AuthContext) {
  requirePermission(ctx, "memberships.view");
  return inTenant(deps, ctx, (tx) =>
    tx.coupon.findMany({ orderBy: [{ status: "asc" }, { createdAt: "desc" }] }),
  );
}
