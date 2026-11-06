import type { TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import { guard, inTenant, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";
import {
  DEFAULT_LOST_REASONS,
  DEFAULT_SOURCES,
  DEFAULT_STAGES,
  STAGE_CATEGORIES,
  type StageCategory,
} from "./rules";

/** Every CRM read and write is behind the plan feature and a permission. */
export const crmGuard = (
  deps: CoreDeps,
  ctx: AuthContext,
  permission: Parameters<typeof guard>[2]["permission"],
  options: { write?: boolean; branchId?: string | null } = {},
) => guard(deps, ctx, { permission, entitlement: "crm.enabled", ...options });

/**
 * Creates the default pipeline, sources and lost reasons the first time a gym uses the CRM
 * (existing gyms have none). Idempotent; safe under concurrency (advisory lock per tenant).
 */
export async function ensureCrmDefaults(
  tx: TenantTransaction,
  tenantId: string,
) {
  const has = await tx.leadStage.count();
  if (has > 0) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('crm-defaults'), hashtext(${tenantId}))`;
  if ((await tx.leadStage.count()) > 0) return;
  await tx.leadStage.createMany({
    data: DEFAULT_STAGES.map((s, i) => ({
      tenantId,
      name: s.name,
      category: s.category,
      position: i,
    })),
  });
  if ((await tx.leadSource.count()) === 0)
    await tx.leadSource.createMany({
      data: DEFAULT_SOURCES.map((s) => ({ tenantId, ...s })),
    });
  if ((await tx.lostReason.count()) === 0)
    await tx.lostReason.createMany({
      data: DEFAULT_LOST_REASONS.map((name, position) => ({
        tenantId,
        name,
        position,
      })),
    });
}

/** First live stage of a category (the pipeline's default landing stage for it). */
export async function stageFor(
  tx: TenantTransaction,
  tenantId: string,
  category: StageCategory,
) {
  await ensureCrmDefaults(tx, tenantId);
  const stage = await tx.leadStage.findFirst({
    where: { category, archivedAt: null },
    orderBy: { position: "asc" },
  });
  if (stage) return stage;
  // A category with no live stage (all archived): recreate one so the flow never breaks.
  const last = await tx.leadStage.aggregate({ _max: { position: true } });
  return tx.leadStage.create({
    data: {
      tenantId,
      name: STAGE_CATEGORIES.includes(category)
        ? category.charAt(0) +
          category.slice(1).toLowerCase().replace(/_/g, " ")
        : category,
      category,
      position: (last._max.position ?? 0) + 1,
    },
  });
}

/** Stages, sources, lost reasons, campaigns and settings for the CRM screens. */
export async function getCrmSetup(deps: CoreDeps, ctx: AuthContext) {
  await crmGuard(deps, ctx, "leads.view");
  return inTenant(deps, ctx, async (tx) => {
    await ensureCrmDefaults(tx, ctx.tenantId);
    const [stages, sources, lostReasons, campaigns, settings] = [
      await tx.leadStage.findMany({
        where: { archivedAt: null },
        orderBy: { position: "asc" },
      }),
      await tx.leadSource.findMany({
        where: { archivedAt: null },
        orderBy: { name: "asc" },
      }),
      await tx.lostReason.findMany({
        where: { archivedAt: null },
        orderBy: { position: "asc" },
      }),
      await tx.campaign.findMany({
        where: { archivedAt: null },
        orderBy: { createdAt: "desc" },
      }),
      await tx.tenantSettings.findUnique({ where: { tenantId: ctx.tenantId } }),
    ];
    const counts = await tx.lead.groupBy({
      by: ["stageId"],
      _count: { _all: true },
    });
    return {
      stages: stages.map((s) => ({
        ...s,
        leads: counts.find((c) => c.stageId === s.id)?._count._all ?? 0,
      })),
      sources,
      lostReasons,
      campaigns,
      settings: {
        leadAssignment: settings?.leadAssignment ?? "MANUAL",
        leadFirstContactMinutes: settings?.leadFirstContactMinutes ?? 15,
        taskReminderMinutes: settings?.taskReminderMinutes ?? 30,
      },
    };
  });
}

// --- stages ------------------------------------------------------------------------------------

const stageSchema = z.object({
  name: z.string().trim().min(2, "Name the stage.").max(40),
  category: z.enum(STAGE_CATEGORIES),
});

export async function createStage(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  const input = parseInput(stageSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    await ensureCrmDefaults(tx, ctx.tenantId);
    await assertNameFree(tx, input.name);
    // New stages go right after the last live stage of the same category.
    const sameCategory = await tx.leadStage.findFirst({
      where: { category: input.category, archivedAt: null },
      orderBy: { position: "desc" },
    });
    const max = await tx.leadStage.aggregate({ _max: { position: true } });
    const position = sameCategory
      ? sameCategory.position + 1
      : (max._max.position ?? 0) + 1;
    await tx.leadStage.updateMany({
      where: { position: { gte: position } },
      data: { position: { increment: 1 } },
    });
    const stage = await tx.leadStage.create({
      data: {
        tenantId: ctx.tenantId,
        name: input.name,
        category: input.category,
        position,
      },
    });
    await recordAudit(tx, ctx, {
      action: "crm.stage_created",
      entityType: "LeadStage",
      entityId: stage.id,
      after: input,
    });
    return stage;
  });
}

async function assertNameFree(
  tx: TenantTransaction,
  name: string,
  exceptId?: string,
) {
  const clash = await tx.leadStage.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      archivedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });
  if (clash)
    throw new AppError(
      "VALIDATION_FAILED",
      "There's already a stage with that name.",
      {
        fields: { name: ["Already used."] },
      },
    );
}

/** Rename only: a stage's category is fixed once leads may be in it (reports depend on it). */
export async function renameStage(
  deps: CoreDeps,
  ctx: AuthContext,
  stageId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  const { name } = parseInput(z.object({ name: stageSchema.shape.name }), raw);
  return inTenant(deps, ctx, async (tx) => {
    const stage = await tx.leadStage.findUnique({ where: { id: stageId } });
    if (!stage || stage.archivedAt)
      throw new AppError("NOT_FOUND", "Stage not found.");
    await assertNameFree(tx, name, stage.id);
    await tx.leadStage.update({ where: { id: stage.id }, data: { name } });
    await recordAudit(tx, ctx, {
      action: "crm.stage_renamed",
      entityType: "LeadStage",
      entityId: stage.id,
      before: { name: stage.name },
      after: { name },
    });
  });
}

/** New order of all live stages (ids top to bottom). Categories must stay in funnel order. */
export async function reorderStages(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  const { ids } = parseInput(
    z.object({ ids: z.array(z.uuid()).min(1).max(50) }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const live = await tx.leadStage.findMany({ where: { archivedAt: null } });
    if (live.length !== ids.length || !live.every((s) => ids.includes(s.id)))
      throw new AppError(
        "CONFLICT",
        "The stages changed meanwhile. Reload and try again.",
      );
    const byId = new Map(live.map((s) => [s.id, s]));
    const ranks = ids.map((id) =>
      STAGE_CATEGORIES.indexOf(byId.get(id)!.category),
    );
    if (ranks.some((r, i) => i > 0 && r < ranks[i - 1]!))
      throw new AppError(
        "VALIDATION_FAILED",
        "Keep stages in funnel order: New → Contacted → Trial scheduled → Trial attended → Offer sent → Won → Lost. Reorder within a step.",
      );
    for (const [position, id] of ids.entries())
      await tx.leadStage.update({ where: { id }, data: { position } });
    await recordAudit(tx, ctx, {
      action: "crm.stages_reordered",
      entityType: "LeadStage",
      after: { ids },
    });
  });
}

/** Archive a stage. Its leads must go somewhere first; the last stage of a category stays. */
export async function archiveStage(
  deps: CoreDeps,
  ctx: AuthContext,
  stageId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  const { moveTo } = parseInput(z.object({ moveTo: z.uuid().optional() }), raw);
  return inTenant(deps, ctx, async (tx) => {
    const stage = await tx.leadStage.findUnique({ where: { id: stageId } });
    if (!stage || stage.archivedAt)
      throw new AppError("NOT_FOUND", "Stage not found.");
    const siblings = await tx.leadStage.count({
      where: { category: stage.category, archivedAt: null },
    });
    if (siblings <= 1)
      throw new AppError(
        "CONFLICT",
        "Every step of the funnel needs at least one stage. Rename it instead.",
      );
    const leads = await tx.lead.count({ where: { stageId: stage.id } });
    if (leads > 0) {
      if (!moveTo)
        throw new AppError(
          "VALIDATION_FAILED",
          `${leads} lead(s) are in this stage. Pick a stage to move them to.`,
          {
            fields: { moveTo: ["Pick a stage."] },
          },
        );
      const target = await tx.leadStage.findUnique({ where: { id: moveTo } });
      if (!target || target.archivedAt || target.id === stage.id)
        throw new AppError("VALIDATION_FAILED", "Pick another live stage.", {
          fields: { moveTo: ["Pick another stage."] },
        });
      if (target.category !== stage.category)
        throw new AppError(
          "VALIDATION_FAILED",
          "Move leads to a stage of the same kind, so reports stay right.",
          {
            fields: { moveTo: ["Same kind of stage only."] },
          },
        );
      await tx.lead.updateMany({
        where: { stageId: stage.id },
        data: { stageId: target.id },
      });
    }
    await tx.leadStage.update({
      where: { id: stage.id },
      data: { archivedAt: new Date() },
    });
    await recordAudit(tx, ctx, {
      action: "crm.stage_archived",
      entityType: "LeadStage",
      entityId: stage.id,
      meta: { movedLeads: leads, moveTo: moveTo ?? null },
    });
  });
}

// --- sources & lost reasons ----------------------------------------------------------------------

const sourceSchema = z.object({
  name: z.string().trim().min(2, "Name it.").max(40),
  points: z.coerce
    .number()
    .int()
    .min(-20, "-20 to 30.")
    .max(30, "-20 to 30.")
    .default(0),
});

export async function createSource(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  const input = parseInput(sourceSchema, raw);
  const code =
    input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "source";
  return inTenant(deps, ctx, async (tx) => {
    await ensureCrmDefaults(tx, ctx.tenantId);
    if (await tx.leadSource.findFirst({ where: { code } }))
      throw new AppError("VALIDATION_FAILED", "That source already exists.", {
        fields: { name: ["Already exists."] },
      });
    const row = await tx.leadSource.create({
      data: {
        tenantId: ctx.tenantId,
        name: input.name,
        code,
        points: input.points,
      },
    });
    await recordAudit(tx, ctx, {
      action: "crm.source_created",
      entityType: "LeadSource",
      entityId: row.id,
      after: { ...input, code },
    });
    return row;
  });
}

export async function updateSourcePoints(
  deps: CoreDeps,
  ctx: AuthContext,
  sourceId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  const { points } = parseInput(
    z.object({ points: sourceSchema.shape.points }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const row = await tx.leadSource.findUnique({ where: { id: sourceId } });
    if (!row) throw new AppError("NOT_FOUND", "Source not found.");
    await tx.leadSource.update({ where: { id: row.id }, data: { points } });
    await recordAudit(tx, ctx, {
      action: "crm.source_points",
      entityType: "LeadSource",
      entityId: row.id,
      before: { points: row.points },
      after: { points },
    });
  });
}

export async function createLostReason(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  const { name } = parseInput(
    z.object({
      name: z.string().trim().min(3, "Describe the reason.").max(80),
    }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    await ensureCrmDefaults(tx, ctx.tenantId);
    const max = await tx.lostReason.aggregate({ _max: { position: true } });
    const row = await tx.lostReason.create({
      data: {
        tenantId: ctx.tenantId,
        name,
        position: (max._max.position ?? 0) + 1,
      },
    });
    await recordAudit(tx, ctx, {
      action: "crm.lost_reason_created",
      entityType: "LostReason",
      entityId: row.id,
      after: { name },
    });
    return row;
  });
}

export async function archiveLostReason(
  deps: CoreDeps,
  ctx: AuthContext,
  id: string,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  return inTenant(deps, ctx, async (tx) => {
    const row = await tx.lostReason.findUnique({ where: { id } });
    if (!row) throw new AppError("NOT_FOUND", "Reason not found.");
    if ((await tx.lostReason.count({ where: { archivedAt: null } })) <= 1)
      throw new AppError("CONFLICT", "Keep at least one reason.");
    await tx.lostReason.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    await recordAudit(tx, ctx, {
      action: "crm.lost_reason_archived",
      entityType: "LostReason",
      entityId: id,
    });
  });
}

// --- settings ------------------------------------------------------------------------------------

const settingsSchema = z.object({
  leadAssignment: z.enum(["MANUAL", "ROUND_ROBIN"]),
  leadFirstContactMinutes: z.coerce
    .number()
    .int()
    .min(1, "1 minute to 7 days.")
    .max(10080, "1 minute to 7 days."),
  taskReminderMinutes: z.coerce
    .number()
    .int()
    .min(0, "0 to 1440.")
    .max(1440, "0 to 1440."),
});

export async function updateCrmSettings(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  const input = parseInput(settingsSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const before = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    await tx.tenantSettings.update({
      where: { tenantId: ctx.tenantId },
      data: input,
    });
    await recordAudit(tx, ctx, {
      action: "crm.settings_updated",
      entityType: "TenantSettings",
      before: before && {
        leadAssignment: before.leadAssignment,
        leadFirstContactMinutes: before.leadFirstContactMinutes,
        taskReminderMinutes: before.taskReminderMinutes,
      },
      after: input,
    });
  });
}
