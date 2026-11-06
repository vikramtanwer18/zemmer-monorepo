import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@gym/db";
import { z } from "zod";
import { redactForAudit } from "../audit";
import { FEATURES, type EntitlementCache } from "../entitlements";
import { AppError } from "../errors";
import { PLATFORM_SETTINGS, readPlatformSettings } from "../platform-settings";
import { findActivePlan, slugify } from "../tenancy/onboarding";
import { INVITATION_TTL_DAYS } from "../tenancy/staff";
import {
  currencySchema,
  emailSchema,
  parseInput,
  timezoneSchema,
} from "../validation";
import { requirePlatformPermission, type PlatformContext } from "./context";

export * from "./context";

/** Platform services use the gym_platform connection; tenant data only via platform_api.*. */
export type PlatformDeps = {
  db: PrismaClient;
  entitlements: EntitlementCache;
  now?: () => Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const nowOf = (deps: PlatformDeps) => (deps.now ? deps.now() : new Date());

type Tx = Prisma.TransactionClient;

export async function recordPlatformAudit(
  tx: Tx | PrismaClient,
  ctx: PlatformContext | null,
  entry: {
    action: string;
    entityType: string;
    entityId?: string | null;
    tenantId?: string | null;
    before?: unknown;
    after?: unknown;
    meta?: Record<string, unknown>;
  },
) {
  await tx.platformAuditLog.create({
    data: {
      actorId: ctx?.platformUserId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      tenantId: entry.tenantId ?? null,
      before:
        entry.before === undefined
          ? undefined
          : (redactForAudit(entry.before) as Prisma.InputJsonValue),
      after:
        entry.after === undefined
          ? undefined
          : (redactForAudit(entry.after) as Prisma.InputJsonValue),
      meta:
        entry.meta === undefined
          ? undefined
          : (redactForAudit(entry.meta) as Prisma.InputJsonValue),
      ipAddress: ctx?.request?.ip ?? null,
    },
  });
}

/** Mirrors a platform action into the tenant's own audit log (owners see it). */
async function recordTenantAudit(
  tx: Tx,
  ctx: PlatformContext | null,
  tenantId: string,
  action: string,
  meta: Record<string, unknown>,
) {
  await tx.$executeRaw`SELECT platform_api.record_tenant_audit(
    ${tenantId}::uuid, ${ctx?.platformUserId ?? null}::uuid, ${action}, 'Tenant', ${tenantId},
    ${JSON.stringify(redactForAudit(meta))}::jsonb)`;
}

// --- dashboard -----------------------------------------------------------------------

export async function getPlatformDashboard(
  deps: PlatformDeps,
  ctx: PlatformContext,
) {
  requirePlatformPermission(ctx, "platform.tenants.view");
  const now = nowOf(deps);
  const soon = new Date(now.getTime() + 7 * DAY_MS);
  const [byStatus, bySubscription, endingSoon, recent] = await Promise.all([
    deps.db.tenant.groupBy({ by: ["status"], _count: { _all: true } }),
    deps.db.tenantSubscription.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    deps.db.tenantSubscription.findMany({
      where: { status: "TRIALING", trialEndsAt: { gte: now, lte: soon } },
      include: { tenant: { select: { id: true, displayName: true } } },
      orderBy: { trialEndsAt: "asc" },
      take: 20,
    }),
    deps.db.tenant.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
  ]);
  return {
    tenantsByStatus: Object.fromEntries(
      byStatus.map((r) => [r.status, r._count._all]),
    ),
    subscriptionsByStatus: Object.fromEntries(
      bySubscription.map((r) => [r.status, r._count._all]),
    ),
    trialsEndingSoon: endingSoon.map((s) => ({
      tenantId: s.tenant.id,
      displayName: s.tenant.displayName,
      trialEndsAt: s.trialEndsAt,
    })),
    recentTenants: recent,
  };
}

// --- tenants -------------------------------------------------------------------------

const listTenantsSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z
    .enum(["PENDING_APPROVAL", "ACTIVE", "SUSPENDED", "CANCELLED"])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export async function listTenants(
  deps: PlatformDeps,
  ctx: PlatformContext,
  rawInput: unknown,
) {
  requirePlatformPermission(ctx, "platform.tenants.view");
  const input = parseInput(listTenantsSchema, rawInput);
  const pageSize = 20;
  const where: Prisma.TenantWhereInput = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.q
      ? {
          OR: [
            { displayName: { contains: input.q, mode: "insensitive" } },
            { legalName: { contains: input.q, mode: "insensitive" } },
            { slug: { contains: input.q.toLowerCase() } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    deps.db.tenant.findMany({
      where,
      include: {
        subscription: {
          include: {
            plan: { select: { name: true, code: true, version: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (input.page - 1) * pageSize,
      take: pageSize,
    }),
    deps.db.tenant.count({ where }),
  ]);
  return { rows, total, page: input.page, pageSize };
}

export async function getTenantDetail(
  deps: PlatformDeps,
  ctx: PlatformContext,
  tenantId: string,
) {
  requirePlatformPermission(ctx, "platform.tenants.view");
  const tenant = await deps.db.tenant.findUnique({
    where: { id: tenantId },
    include: {
      subscription: { include: { plan: true } },
      usageCounters: true,
      overrides: { orderBy: { createdAt: "desc" } },
      supportSessions: {
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { platformUser: { select: { name: true, email: true } } },
      },
    },
  });
  if (!tenant) throw new AppError("NOT_FOUND", "Tenant not found.");
  const [owners, audit] = await Promise.all([
    deps.db.$queryRaw<{ name: string; email: string }[]>`
      SELECT name, email FROM platform_api.tenant_owner_contacts(${tenantId}::uuid)`,
    deps.db.platformAuditLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { actor: { select: { name: true, email: true } } },
    }),
  ]);
  return { tenant, owners, audit };
}

const createTenantSchema = z.object({
  displayName: z.string().trim().min(2, "Enter the gym's name.").max(80),
  legalName: z.string().trim().max(120).optional(),
  ownerEmail: emailSchema,
  planCode: z.string().min(1),
  timezone: timezoneSchema.default("Asia/Kolkata"),
  currency: currencySchema.default("INR"),
});

export type OwnerInviteMailer = (message: {
  to: string;
  tenantName: string;
  token: string;
  expiresAt: Date;
}) => Promise<void>;

/** Platform-created tenant: ACTIVE, on trial, owner invited by email. */
export async function createTenantByPlatform(
  deps: PlatformDeps,
  mailer: OwnerInviteMailer,
  ctx: PlatformContext,
  rawInput: unknown,
) {
  requirePlatformPermission(ctx, "platform.tenants.manage");
  const input = parseInput(createTenantSchema, rawInput);
  const now = nowOf(deps);
  const settings = await readPlatformSettings(deps.db);
  const plan = await findActivePlan(deps.db, input.planCode);
  if (!plan) {
    throw new AppError("VALIDATION_FAILED", "Pick an active plan.", {
      fields: { planCode: ["Pick an active plan."] },
    });
  }
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * DAY_MS);
  const base = slugify(input.displayName);
  const taken = await deps.db.tenant.findMany({
    where: { slug: { startsWith: base } },
    select: { slug: true },
  });
  const takenSet = new Set(taken.map((t) => t.slug));
  let slug = base;
  for (let i = 2; takenSet.has(slug); i++) slug = `${base}-${i}`;

  const tenant = await deps.db.$transaction(async (tx) => {
    const created = await tx.tenant.create({
      data: {
        slug,
        displayName: input.displayName,
        legalName: input.legalName || input.displayName,
        status: "ACTIVE",
        approvedAt: now,
        timezone: input.timezone,
        currency: input.currency,
      },
    });
    await tx.tenantSubscription.create({
      data: {
        tenantId: created.id,
        planId: plan.id,
        status: "TRIALING",
        trialEndsAt: new Date(now.getTime() + settings["trial.days"] * DAY_MS),
      },
    });
    await tx.$queryRaw`SELECT platform_api.create_owner_invitation(
      ${created.id}::uuid, ${input.ownerEmail}, ${tokenHash}, ${expiresAt}::timestamptz,
      ${ctx.platformUserId}::uuid)`;
    await recordPlatformAudit(tx, ctx, {
      action: "tenant.created",
      entityType: "Tenant",
      entityId: created.id,
      tenantId: created.id,
      after: { ...input, slug, plan: `${plan.code}@${plan.version}` },
    });
    return created;
  });
  await mailer({
    to: input.ownerEmail,
    tenantName: tenant.displayName,
    token,
    expiresAt,
  });
  return tenant;
}

/** Sends a fresh owner invitation (the previous link stops working). */
export async function resendOwnerInvitation(
  deps: PlatformDeps,
  mailer: OwnerInviteMailer,
  ctx: PlatformContext,
  tenantId: string,
  rawEmail: unknown,
) {
  requirePlatformPermission(ctx, "platform.tenants.manage");
  const email = parseInput(emailSchema, rawEmail);
  const tenant = await deps.db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new AppError("NOT_FOUND", "Tenant not found.");
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(
    nowOf(deps).getTime() + INVITATION_TTL_DAYS * DAY_MS,
  );
  await deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT platform_api.create_owner_invitation(
      ${tenantId}::uuid, ${email}, ${tokenHash}, ${expiresAt}::timestamptz,
      ${ctx.platformUserId}::uuid)`;
    await recordPlatformAudit(tx, ctx, {
      action: "tenant.owner_invited",
      entityType: "Tenant",
      entityId: tenantId,
      tenantId,
      meta: { email },
    });
  });
  await mailer({ to: email, tenantName: tenant.displayName, token, expiresAt });
}

const reasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason (at least 5 characters).")
  .max(500);

type StatusChange = "approve" | "suspend" | "reactivate";

const PAST_TENSE: Record<StatusChange, string> = {
  approve: "approved",
  suspend: "suspended",
  reactivate: "reactivated",
};

/**
 * approve: PENDING_APPROVAL → ACTIVE (trial starts now).
 * suspend: → SUSPENDED (read-only; nothing deleted). reactivate: SUSPENDED → ACTIVE.
 */
export async function changeTenantStatus(
  deps: PlatformDeps,
  ctx: PlatformContext,
  tenantId: string,
  change: StatusChange,
  rawReason: unknown,
) {
  requirePlatformPermission(ctx, "platform.tenants.manage");
  const reason =
    change === "approve"
      ? typeof rawReason === "string" && rawReason.trim()
        ? rawReason.trim()
        : "Approved"
      : parseInput(reasonSchema, rawReason);
  const now = nowOf(deps);
  const settings = await readPlatformSettings(deps.db);
  const result = await deps.db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      include: { subscription: true },
    });
    if (!tenant) throw new AppError("NOT_FOUND", "Tenant not found.");
    const allowed: Record<StatusChange, string[]> = {
      approve: ["PENDING_APPROVAL"],
      suspend: ["ACTIVE", "PENDING_APPROVAL"],
      reactivate: ["SUSPENDED"],
    };
    if (!allowed[change].includes(tenant.status)) {
      throw new AppError(
        "CONFLICT",
        `A ${tenant.status.toLowerCase().replace("_", " ")} tenant can't be ${PAST_TENSE[change]}.`,
      );
    }
    const status = change === "suspend" ? "SUSPENDED" : "ACTIVE";
    const updated = await tx.tenant.update({
      where: { id: tenantId },
      data: {
        status,
        statusReason: change === "approve" ? null : reason,
        ...(change === "approve" ? { approvedAt: now } : {}),
      },
    });
    if (change === "approve" && tenant.subscription?.status === "TRIALING") {
      await tx.tenantSubscription.update({
        where: { tenantId },
        data: {
          trialEndsAt: new Date(
            now.getTime() + settings["trial.days"] * DAY_MS,
          ),
        },
      });
    }
    await recordPlatformAudit(tx, ctx, {
      action: `tenant.${PAST_TENSE[change]}`,
      entityType: "Tenant",
      entityId: tenantId,
      tenantId,
      before: { status: tenant.status },
      after: { status },
      meta: { reason },
    });
    await recordTenantAudit(
      tx,
      ctx,
      tenantId,
      `platform.tenant_${PAST_TENSE[change]}`,
      {
        reason,
        from: tenant.status,
        to: status,
      },
    );
    return updated;
  });
  await deps.entitlements.invalidate(tenantId).catch(() => {});
  return result;
}

const changePlanSchema = z.object({ planId: z.uuid() });

export async function changeTenantPlan(
  deps: PlatformDeps,
  ctx: PlatformContext,
  tenantId: string,
  rawInput: unknown,
) {
  requirePlatformPermission(ctx, "platform.plans.manage");
  const { planId } = parseInput(changePlanSchema, rawInput);
  await deps.db.$transaction(async (tx) => {
    const plan = await tx.saasPlan.findUnique({ where: { id: planId } });
    if (!plan || plan.status !== "ACTIVE")
      throw new AppError("VALIDATION_FAILED", "Pick an active plan.");
    const sub = await tx.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!sub)
      throw new AppError("NOT_FOUND", "This tenant has no subscription.");
    await tx.tenantSubscription.update({
      where: { tenantId },
      data: { planId },
    });
    await recordPlatformAudit(tx, ctx, {
      action: "tenant.plan_changed",
      entityType: "TenantSubscription",
      entityId: sub.id,
      tenantId,
      before: { plan: `${sub.plan.code}@${sub.plan.version}` },
      after: { plan: `${plan.code}@${plan.version}` },
    });
  });
  await deps.entitlements.invalidate(tenantId).catch(() => {});
}

// --- overrides -----------------------------------------------------------------------

const overrideSchema = z.object({
  featureKey: z.enum(Object.keys(FEATURES) as [string, ...string[]]),
  value: z.string().trim().min(1, "Enter a value."),
  reason: reasonSchema,
  expiresAt: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : null))
    .refine(
      (d) => d === null || !Number.isNaN(d.getTime()),
      "Enter a valid date.",
    ),
});

/** Parses a typed override value: true/false, a number or "unlimited", or JSON for CONFIG. */
export function parseFeatureValue(
  featureKey: string,
  raw: string,
): Prisma.InputJsonValue | null {
  const type = FEATURES[featureKey as keyof typeof FEATURES];
  const v = raw.trim().toLowerCase();
  if (type === "BOOLEAN") {
    if (v === "true" || v === "on" || v === "yes") return true;
    if (v === "false" || v === "off" || v === "no") return false;
    throw new AppError("VALIDATION_FAILED", "Use true or false.", {
      fields: { value: ["Use true or false."] },
    });
  }
  if (type === "QUOTA") {
    if (v === "unlimited" || v === "null" || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Use a whole number or 'unlimited'.",
        {
          fields: { value: ["Use a whole number or 'unlimited'."] },
        },
      );
    }
    return n;
  }
  try {
    return JSON.parse(raw) as Prisma.InputJsonValue;
  } catch {
    return raw;
  }
}

export async function addOverride(
  deps: PlatformDeps,
  ctx: PlatformContext,
  tenantId: string,
  rawInput: unknown,
) {
  requirePlatformPermission(ctx, "platform.plans.manage");
  const input = parseInput(overrideSchema, rawInput);
  if (input.expiresAt && input.expiresAt <= nowOf(deps)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The expiry must be in the future.",
      {
        fields: { expiresAt: ["The expiry must be in the future."] },
      },
    );
  }
  const value = parseFeatureValue(input.featureKey, input.value);
  const override = await deps.db.$transaction(async (tx) => {
    const created = await tx.subscriptionOverride.create({
      data: {
        tenantId,
        featureKey: input.featureKey,
        value: value === null ? undefined : value,
        reason: input.reason,
        expiresAt: input.expiresAt,
        createdById: ctx.platformUserId,
      },
    });
    if (value === null) {
      await tx.$executeRaw`UPDATE platform.subscription_override SET value = 'null'::jsonb WHERE id = ${created.id}::uuid`;
    }
    await recordPlatformAudit(tx, ctx, {
      action: "tenant.override_added",
      entityType: "SubscriptionOverride",
      entityId: created.id,
      tenantId,
      after: {
        featureKey: input.featureKey,
        value,
        expiresAt: input.expiresAt,
      },
      meta: { reason: input.reason },
    });
    return created;
  });
  await deps.entitlements.invalidate(tenantId).catch(() => {});
  return override;
}

export async function removeOverride(
  deps: PlatformDeps,
  ctx: PlatformContext,
  overrideId: string,
) {
  requirePlatformPermission(ctx, "platform.plans.manage");
  const removed = await deps.db.$transaction(async (tx) => {
    const override = await tx.subscriptionOverride.findUnique({
      where: { id: overrideId },
    });
    if (!override) throw new AppError("NOT_FOUND", "Override not found.");
    await tx.subscriptionOverride.delete({ where: { id: overrideId } });
    await recordPlatformAudit(tx, ctx, {
      action: "tenant.override_removed",
      entityType: "SubscriptionOverride",
      entityId: overrideId,
      tenantId: override.tenantId,
      before: override,
    });
    return override;
  });
  await deps.entitlements.invalidate(removed.tenantId).catch(() => {});
}

// --- plans ---------------------------------------------------------------------------

export async function listPlans(deps: PlatformDeps, ctx: PlatformContext) {
  requirePlatformPermission(ctx, "platform.tenants.view");
  const [plans, features, counts] = await Promise.all([
    deps.db.saasPlan.findMany({
      include: { features: true },
      orderBy: [{ code: "asc" }, { version: "desc" }],
    }),
    deps.db.feature.findMany({ orderBy: [{ module: "asc" }, { key: "asc" }] }),
    deps.db.tenantSubscription.groupBy({
      by: ["planId"],
      _count: { _all: true },
    }),
  ]);
  const subscribers = new Map(counts.map((c) => [c.planId, c._count._all]));
  return {
    plans: plans.map((p) => ({
      ...p,
      subscribers: subscribers.get(p.id) ?? 0,
    })),
    features,
  };
}

const newPlanSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9-]{1,30}$/, "Lowercase letters, digits and dashes."),
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional(),
});

/** A brand-new plan code, version 1, as a DRAFT with catalog defaults. */
export async function createPlan(
  deps: PlatformDeps,
  ctx: PlatformContext,
  rawInput: unknown,
) {
  requirePlatformPermission(ctx, "platform.plans.manage");
  const input = parseInput(newPlanSchema, rawInput);
  const exists = await deps.db.saasPlan.findFirst({
    where: { code: input.code },
  });
  if (exists) {
    throw new AppError(
      "CONFLICT",
      "That plan code exists. Create a new version instead.",
      {
        fields: { code: ["That plan code exists."] },
      },
    );
  }
  return deps.db.$transaction(async (tx) => {
    const plan = await tx.saasPlan.create({
      data: {
        code: input.code,
        version: 1,
        name: input.name,
        description: input.description ?? null,
      },
    });
    await recordPlatformAudit(tx, ctx, {
      action: "plan.created",
      entityType: "SaasPlan",
      entityId: plan.id,
      after: input,
    });
    return plan;
  });
}

/** Copies a plan into code@(latest+1) as a DRAFT, so live subscribers keep their terms. */
export async function createPlanVersion(
  deps: PlatformDeps,
  ctx: PlatformContext,
  planId: string,
) {
  requirePlatformPermission(ctx, "platform.plans.manage");
  return deps.db.$transaction(async (tx) => {
    const source = await tx.saasPlan.findUnique({
      where: { id: planId },
      include: { features: true },
    });
    if (!source) throw new AppError("NOT_FOUND", "Plan not found.");
    const latest = await tx.saasPlan.findFirst({
      where: { code: source.code },
      orderBy: { version: "desc" },
    });
    const plan = await tx.saasPlan.create({
      data: {
        code: source.code,
        version: (latest?.version ?? source.version) + 1,
        name: source.name,
        description: source.description,
        priceMonthlyMinor: source.priceMonthlyMinor,
        currency: source.currency,
      },
    });
    for (const f of source.features) {
      await tx.$executeRaw`INSERT INTO platform.plan_feature (plan_id, feature_key, value)
        VALUES (${plan.id}::uuid, ${f.featureKey}, ${JSON.stringify(f.value ?? null)}::jsonb)`;
    }
    await recordPlatformAudit(tx, ctx, {
      action: "plan.version_created",
      entityType: "SaasPlan",
      entityId: plan.id,
      meta: {
        from: `${source.code}@${source.version}`,
        to: `${plan.code}@${plan.version}`,
      },
    });
    return plan;
  });
}

/** Sets feature values on a DRAFT plan. Form keys are feature keys; values parsed by type. */
export async function updatePlanFeatures(
  deps: PlatformDeps,
  ctx: PlatformContext,
  planId: string,
  values: Record<string, string>,
) {
  requirePlatformPermission(ctx, "platform.plans.manage");
  await deps.db.$transaction(async (tx) => {
    const plan = await tx.saasPlan.findUnique({
      where: { id: planId },
      include: { features: true },
    });
    if (!plan) throw new AppError("NOT_FOUND", "Plan not found.");
    if (plan.status !== "DRAFT") {
      throw new AppError(
        "CONFLICT",
        "Only draft plans can be edited. Create a new version.",
      );
    }
    const changes: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(values)) {
      if (!(key in FEATURES)) continue;
      const value = parseFeatureValue(key, raw);
      changes[key] = value;
      await tx.$executeRaw`INSERT INTO platform.plan_feature (plan_id, feature_key, value)
        VALUES (${planId}::uuid, ${key}, ${JSON.stringify(value)}::jsonb)
        ON CONFLICT (plan_id, feature_key) DO UPDATE SET value = EXCLUDED.value`;
    }
    await recordPlatformAudit(tx, ctx, {
      action: "plan.features_updated",
      entityType: "SaasPlan",
      entityId: planId,
      after: changes,
    });
  });
}

export async function setPlanStatus(
  deps: PlatformDeps,
  ctx: PlatformContext,
  planId: string,
  status: "ACTIVE" | "RETIRED",
) {
  requirePlatformPermission(ctx, "platform.plans.manage");
  return deps.db.$transaction(async (tx) => {
    const plan = await tx.saasPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new AppError("NOT_FOUND", "Plan not found.");
    const allowed =
      status === "ACTIVE" ? plan.status === "DRAFT" : plan.status === "ACTIVE";
    if (!allowed)
      throw new AppError(
        "CONFLICT",
        `A ${plan.status.toLowerCase()} plan can't be set to ${status.toLowerCase()}.`,
      );
    const updated = await tx.saasPlan.update({
      where: { id: planId },
      data: { status },
    });
    await recordPlatformAudit(tx, ctx, {
      action: status === "ACTIVE" ? "plan.published" : "plan.retired",
      entityType: "SaasPlan",
      entityId: planId,
    });
    return updated;
  });
}

// --- platform settings ---------------------------------------------------------------

const settingsInputSchema = z.object({
  approvalRequired: z.boolean(),
  embeddedSignupEnabled: z.boolean().default(false),
  trialDays: z.coerce.number().int().min(0).max(365),
  trialPlanCode: z.string().min(1),
  trialExpiredStatus: PLATFORM_SETTINGS["trial.expired_status"],
});

export async function getPlatformSettingsForAdmin(
  deps: PlatformDeps,
  ctx: PlatformContext,
) {
  requirePlatformPermission(ctx, "platform.tenants.view");
  return readPlatformSettings(deps.db);
}

export async function updatePlatformSettings(
  deps: PlatformDeps,
  ctx: PlatformContext,
  rawInput: unknown,
) {
  requirePlatformPermission(ctx, "platform.settings.manage");
  const input = parseInput(settingsInputSchema, rawInput);
  const plan = await findActivePlan(deps.db, input.trialPlanCode);
  if (!plan) {
    throw new AppError("VALIDATION_FAILED", "Pick an active plan.", {
      fields: { trialPlanCode: ["Pick an active plan."] },
    });
  }
  const before = await readPlatformSettings(deps.db);
  const next = {
    "tenant.approval_required": input.approvalRequired,
    "trial.days": input.trialDays,
    "trial.plan_code": input.trialPlanCode,
    "trial.expired_status": input.trialExpiredStatus,
    "whatsapp.embedded_signup_enabled": input.embeddedSignupEnabled,
  };
  await deps.db.$transaction(async (tx) => {
    for (const [key, value] of Object.entries(next)) {
      await tx.platformSetting.upsert({
        where: { key },
        create: { key, value, updatedById: ctx.platformUserId },
        update: { value, updatedById: ctx.platformUserId },
      });
    }
    await recordPlatformAudit(tx, ctx, {
      action: "platform.settings_updated",
      entityType: "PlatformSetting",
      before,
      after: next,
    });
  });
}

// --- audit -----------------------------------------------------------------------------

export async function listPlatformAudit(
  deps: PlatformDeps,
  ctx: PlatformContext,
  filters: { action?: string; tenantId?: string; page?: number },
) {
  requirePlatformPermission(ctx, "platform.audit.view");
  const pageSize = 30;
  const page = Math.max(filters.page ?? 1, 1);
  const where: Prisma.PlatformAuditLogWhereInput = {
    ...(filters.action ? { action: { startsWith: filters.action } } : {}),
    ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
  };
  const [rows, total, actions] = await Promise.all([
    deps.db.platformAuditLog.findMany({
      where,
      include: { actor: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    deps.db.platformAuditLog.count({ where }),
    deps.db.platformAuditLog.findMany({
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    }),
  ]);
  return { rows, total, page, pageSize, actions: actions.map((a) => a.action) };
}

// --- support sessions ----------------------------------------------------------------

export const SUPPORT_MAX_MINUTES = 120;

const supportSchema = z.object({
  reason: reasonSchema,
  minutes: z.coerce
    .number()
    .int()
    .min(5)
    .max(SUPPORT_MAX_MINUTES, "At most 2 hours."),
});

export async function startSupportSession(
  deps: PlatformDeps,
  ctx: PlatformContext,
  tenantId: string,
  rawInput: unknown,
) {
  requirePlatformPermission(ctx, "platform.support.access");
  const input = parseInput(supportSchema, rawInput);
  const now = nowOf(deps);
  return deps.db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new AppError("NOT_FOUND", "Tenant not found.");
    const session = await tx.supportSession.create({
      data: {
        tenantId,
        platformUserId: ctx.platformUserId,
        reason: input.reason,
        expiresAt: new Date(now.getTime() + input.minutes * 60_000),
      },
    });
    const meta = {
      supportSessionId: session.id,
      reason: input.reason,
      minutes: input.minutes,
      mode: "READ_ONLY",
    };
    await recordPlatformAudit(tx, ctx, {
      action: "support.session_started",
      entityType: "SupportSession",
      entityId: session.id,
      tenantId,
      meta,
    });
    await recordTenantAudit(
      tx,
      ctx,
      tenantId,
      "platform.support_session_started",
      meta,
    );
    return session;
  });
}

export async function endSupportSession(
  deps: PlatformDeps,
  ctx: PlatformContext,
  sessionId: string,
) {
  requirePlatformPermission(ctx, "platform.support.access");
  await deps.db.$transaction(async (tx) => {
    const session = await tx.supportSession.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.platformUserId !== ctx.platformUserId) {
      throw new AppError("NOT_FOUND", "Support session not found.");
    }
    if (session.endedAt) return;
    await tx.supportSession.update({
      where: { id: sessionId },
      data: { endedAt: nowOf(deps) },
    });
    await recordPlatformAudit(tx, ctx, {
      action: "support.session_ended",
      entityType: "SupportSession",
      entityId: sessionId,
      tenantId: session.tenantId,
    });
    await recordTenantAudit(
      tx,
      ctx,
      session.tenantId,
      "platform.support_session_ended",
      { supportSessionId: sessionId },
    );
  });
}

export type SupportSnapshot = {
  settings: Record<string, unknown> | null;
  branches: {
    name: string;
    code: string;
    city: string | null;
    stateCode: string;
    timezone: string | null;
    status: string;
  }[];
  activeMembershipsByRole: Record<string, number>;
  pendingInvitations: number;
};

/** Read-only troubleshooting view; the database refuses unless the session is live and ours. */
export async function getSupportSnapshot(
  deps: PlatformDeps,
  ctx: PlatformContext,
  sessionId: string,
) {
  requirePlatformPermission(ctx, "platform.support.access");
  const session = await deps.db.supportSession.findUnique({
    where: { id: sessionId },
    include: { tenant: true },
  });
  if (!session || session.platformUserId !== ctx.platformUserId) {
    throw new AppError("NOT_FOUND", "Support session not found.");
  }
  if (session.endedAt || session.expiresAt <= nowOf(deps)) {
    throw new AppError("FORBIDDEN", "This support session has ended.");
  }
  const rows = await deps.db.$queryRaw<{ snapshot: SupportSnapshot }[]>`
    SELECT platform_api.support_tenant_snapshot(${sessionId}::uuid, ${ctx.platformUserId}::uuid) AS snapshot`;
  await recordPlatformAudit(deps.db, ctx, {
    action: "support.snapshot_viewed",
    entityType: "SupportSession",
    entityId: sessionId,
    tenantId: session.tenantId,
  });
  return { session, snapshot: rows[0]?.snapshot ?? null };
}

export async function listMySupportSessions(
  deps: PlatformDeps,
  ctx: PlatformContext,
) {
  requirePlatformPermission(ctx, "platform.support.access");
  return deps.db.supportSession.findMany({
    where: { platformUserId: ctx.platformUserId },
    include: { tenant: { select: { displayName: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

// --- jobs ----------------------------------------------------------------------------

/**
 * Trial expiry (worker, platform connection): TRIALING subscriptions past trialEndsAt move to
 * the configured status. Returns the affected tenant ids.
 */
export async function expireDueTrials(deps: PlatformDeps): Promise<string[]> {
  const now = nowOf(deps);
  const settings = await readPlatformSettings(deps.db);
  const target = settings["trial.expired_status"];
  const due = await deps.db.tenantSubscription.findMany({
    where: { status: "TRIALING", trialEndsAt: { lte: now } },
    select: { id: true, tenantId: true },
    take: 500,
  });
  const expired: string[] = [];
  for (const sub of due) {
    await deps.db.$transaction(async (tx) => {
      const { count } = await tx.tenantSubscription.updateMany({
        where: { id: sub.id, status: "TRIALING", trialEndsAt: { lte: now } },
        data: { status: target },
      });
      if (count === 0) return;
      await recordPlatformAudit(tx, null, {
        action: "subscription.trial_expired",
        entityType: "TenantSubscription",
        entityId: sub.id,
        tenantId: sub.tenantId,
        after: { status: target },
      });
      await recordTenantAudit(
        tx,
        null,
        sub.tenantId,
        "subscription.trial_expired",
        { status: target },
      );
      expired.push(sub.tenantId);
    });
  }
  await Promise.all(
    expired.map((id) => deps.entitlements.invalidate(id).catch(() => {})),
  );
  return expired;
}
