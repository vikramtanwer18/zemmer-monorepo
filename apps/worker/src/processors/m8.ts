import { randomUUID } from "node:crypto";
import { authContextFor } from "@gym/auth/context";
import { enqueue } from "@gym/core/jobs";
import { runMetricsRollupTx } from "@gym/core/metrics";
import { buildReportExport } from "@gym/core/reports";
import { todayIn } from "@gym/core/time/dates";
import { Prisma } from "@gym/db";
import type { JobContext } from "../context";

/** Nightly on the tenant's local date: KPI rollup for yesterday, and Copilot log retention. */
export async function metricsRollup(
  ctx: JobContext<"metrics", "metrics.rollup">,
) {
  const tenantId = ctx.envelope.tenantId!;
  const now = new Date();
  const result = await ctx.tenantDb(async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const rollup = await runMetricsRollupTx(
      tx,
      tenantId,
      tenant?.timezone ?? "Asia/Kolkata",
      ctx.envelope.data.date,
      now,
    );
    // Request logs hold no question/answer text, but are still kept only as long as the operator set.
    const provider = await tx.aiProvider.findUnique({
      where: { id: "default" },
      select: { logRetentionDays: true },
    });
    const cutoff = new Date(
      now.getTime() - (provider?.logRetentionDays ?? 90) * 86_400_000,
    );
    const purged = await tx.aiRequestLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return { ...rollup, aiLogsPurged: purged.count };
  });
  ctx.log.info(result, "metrics rollup");
  return result;
}

/** Queued by the hourly daily-scan with the other per-tenant nightly jobs (once per local date). */
export async function enqueueMetricsRollup(
  redis: Parameters<typeof enqueue>[0],
  tenantId: string,
  timeZone: string,
  now: Date,
) {
  const date = todayIn(timeZone, now);
  await enqueue(redis, "metrics", "metrics.rollup", {
    tenantId,
    actor: { type: "system" },
    idempotencyKey: `metrics-${tenantId}-${date}`,
    data: { date },
  });
}

/**
 * A report export (CSV or XLSX) as the user who asked for it, with their permissions as they are
 * now. Private storage; the file and its download link expire after 24 hours.
 */
export async function reportsExport(ctx: JobContext<"data", "reports.export">) {
  const { db, storage, deps } = ctx.services();
  if (!deps) throw new Error("Worker core services are not configured");
  const tenantId = ctx.envelope.tenantId!;
  const id = ctx.envelope.data.dataJobId;
  const job = await ctx.tenantDb((tx) =>
    tx.dataJob.findUnique({ where: { id } }),
  );
  if (!job || job.kind !== "REPORT_EXPORT")
    throw new Error("Report export job not found");
  if (job.status !== "PENDING") return { skipped: job.status };
  const update = (data: Prisma.DataJobUpdateInput) =>
    ctx.tenantDb((tx) => tx.dataJob.update({ where: { id }, data }));
  await update({ status: "RUNNING", progress: 1 });
  try {
    const actor = await authContextFor(db, job.createdById, tenantId);
    if (!actor)
      throw new Error("The user who started this export no longer has access.");
    let last = 0;
    const file = await buildReportExport(
      deps,
      actor,
      job.params,
      async (pct) => {
        if (pct - last >= 10) {
          last = pct;
          await update({ progress: pct });
        }
      },
    );
    const key = `tenants/${tenantId}/exports/${randomUUID()}.${file.filename.endsWith(".xlsx") ? "xlsx" : "csv"}`;
    const { size } = await storage.put(key, file.bytes, file.contentType);
    const record = await ctx.tenantDb((tx) =>
      tx.fileRecord.create({
        data: {
          tenantId,
          key,
          filename: file.filename,
          contentType: file.contentType,
          size,
          purpose: "EXPORT",
          scanStatus: "SKIPPED",
          uploadedByUserId: actor.userId,
          expiresAt: new Date(Date.now() + 24 * 3_600_000),
        },
      }),
    );
    const summary = {
      count: file.rows,
      truncated: file.truncated,
      kpiVersion: file.version,
    };
    await update({
      status: "SUCCEEDED",
      progress: 100,
      summary: summary as Prisma.InputJsonValue,
      finishedAt: new Date(),
      resultFileId: record.id,
    });
    return summary;
  } catch (err) {
    await update({
      status: "FAILED",
      summary: { error: err instanceof Error ? err.message : "Export failed" },
      finishedAt: new Date(),
    });
    throw err;
  }
}
