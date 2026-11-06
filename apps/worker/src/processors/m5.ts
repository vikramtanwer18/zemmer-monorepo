import { randomUUID } from "node:crypto";
import { authContextFor } from "@gym/auth/context";
import {
  CRM_EVENT_HANDLERS,
  crmTick as runCrmTick,
  exportLeadsCsv,
  importLeads,
  leadListSchema,
} from "@gym/core/crm";
import { AUTOMATION_EVENT_HANDLER } from "@gym/core/automation";
import { ENGAGEMENT_EVENT_HANDLER } from "@gym/core/engagement";
import { dispatchEvent } from "@gym/core/events";
import { enqueue } from "@gym/core/jobs";
import { Prisma, withTenant } from "@gym/db";
import type { JobContext } from "../context";

const SLOT_MS = 5 * 60 * 1000;

/** A domain event from the outbox: every registered handler runs once (idempotent consumers). */
export async function eventsDispatch(
  ctx: JobContext<"events", "events.dispatch">,
) {
  const { db } = ctx.services();
  const result = await dispatchEvent(
    db,
    ctx.envelope.tenantId!,
    ctx.envelope.data.eventId,
    // M6: automations subscribe to the same events (their own consumption claim).
    [...CRM_EVENT_HANDLERS, AUTOMATION_EVENT_HANDLER, ENGAGEMENT_EVENT_HANDLER],
  );
  if (result.ran.length)
    ctx.log.debug(
      { type: ctx.envelope.data.type, ...result },
      "event dispatched",
    );
  return result;
}

/** Every 5 minutes: each active tenant's CRM tick (cheap when there's nothing due). */
export async function crmScan(
  ctx: JobContext<"platform", "platform.crm-scan">,
) {
  const tenants = await ctx
    .platform()
    .db.tenant.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const { redis } = ctx.services();
  const slot = Math.floor(Date.now() / SLOT_MS);
  for (const t of tenants)
    await enqueue(redis, "crm", "crm.tick", {
      tenantId: t.id,
      actor: { type: "system" },
      idempotencyKey: `crm-tick-${t.id}-${slot}`,
      data: {},
    });
  return { tenants: tenants.length };
}

export async function crmTick(ctx: JobContext<"crm", "crm.tick">) {
  const tenantId = ctx.envelope.tenantId!;
  const result = await ctx.tenantDb((tx) =>
    runCrmTick(tx, tenantId, new Date()),
  );
  if (result.slaBreached || result.reminded || result.noShows)
    ctx.log.info(result, "crm tick");
  return result;
}

async function loadJob(
  ctx: JobContext<"data", "leads.import" | "leads.export">,
) {
  const job = await ctx.tenantDb((tx) =>
    tx.dataJob.findUnique({ where: { id: ctx.envelope.data.dataJobId } }),
  );
  if (!job) throw new Error("Data job not found");
  return job;
}

async function finish(
  ctx: JobContext<"data", "leads.import" | "leads.export">,
  id: string,
  status: "SUCCEEDED" | "FAILED",
  summary: Record<string, unknown>,
  resultFileId?: string,
) {
  await ctx.tenantDb((tx) =>
    tx.dataJob.update({
      where: { id },
      data: {
        status,
        summary: summary as Prisma.InputJsonValue,
        finishedAt: new Date(),
        ...(resultFileId ? { resultFileId } : {}),
      },
    }),
  );
}

/** Lead CSV import, as the staff user who uploaded it (their permissions re-checked now). */
export async function leadsImport(ctx: JobContext<"data", "leads.import">) {
  const { db, storage } = ctx.services();
  const tenantId = ctx.envelope.tenantId!;
  const job = await loadJob(ctx);
  if (job.status !== "PENDING") return { skipped: job.status };
  await ctx.tenantDb((tx) =>
    tx.dataJob.update({ where: { id: job.id }, data: { status: "RUNNING" } }),
  );
  try {
    const actor = await authContextFor(db, job.createdById, tenantId);
    if (!actor)
      throw new Error("The user who started this import no longer has access.");
    const file = await ctx.tenantDb((tx) =>
      tx.fileRecord.findUniqueOrThrow({ where: { id: job.inputFileId! } }),
    );
    const csv = await storage.getText(file.key);
    const summary = await importLeads(actor, csv, {
      dryRun: job.dryRun,
      now: new Date(),
      runRow: (fn) => withTenant(db, tenantId, fn, { userId: actor.userId }),
    });
    await finish(ctx, job.id, "SUCCEEDED", {
      ...summary,
      rows: summary.rows.slice(0, 500),
    });
    return {
      imported: summary.imported,
      merged: summary.merged,
      errors: summary.errors,
    };
  } catch (err) {
    await finish(ctx, job.id, "FAILED", {
      error: err instanceof Error ? err.message : "Import failed",
    });
    throw err;
  }
}

/** Lead CSV export to private storage; the file and its link expire after 24 hours. */
export async function leadsExport(ctx: JobContext<"data", "leads.export">) {
  const { db, storage } = ctx.services();
  const tenantId = ctx.envelope.tenantId!;
  const job = await loadJob(ctx);
  if (job.status !== "PENDING") return { skipped: job.status };
  await ctx.tenantDb((tx) =>
    tx.dataJob.update({ where: { id: job.id }, data: { status: "RUNNING" } }),
  );
  try {
    const actor = await authContextFor(db, job.createdById, tenantId);
    if (!actor)
      throw new Error("The user who started this export no longer has access.");
    const filters = leadListSchema.parse(job.params ?? {});
    const { csv, count } = await withTenant(
      db,
      tenantId,
      (tx) => exportLeadsCsv(tx, actor, filters),
      { userId: actor.userId },
    );
    const key = `tenants/${tenantId}/exports/${randomUUID()}.csv`;
    const { size } = await storage.put(key, csv, "text/csv");
    const file = await ctx.tenantDb((tx) =>
      tx.fileRecord.create({
        data: {
          tenantId,
          key,
          filename: `leads-${new Date().toISOString().slice(0, 10)}.csv`,
          contentType: "text/csv",
          size,
          purpose: "EXPORT",
          scanStatus: "SKIPPED",
          uploadedByUserId: actor.userId,
          expiresAt: new Date(Date.now() + 24 * 3_600_000),
        },
      }),
    );
    await finish(ctx, job.id, "SUCCEEDED", { count }, file.id);
    return { count };
  } catch (err) {
    await finish(ctx, job.id, "FAILED", {
      error: err instanceof Error ? err.message : "Export failed",
    });
    throw err;
  }
}
