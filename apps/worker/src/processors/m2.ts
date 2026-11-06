import { randomUUID } from "node:crypto";
import { enqueueGrowthDaily } from "./m6";
import { enqueueMetricsRollup } from "./m8";
import { authContextFor } from "@gym/auth/context";
import { entitlementsFor } from "@gym/core/tenancy";
import { noEntitlementCache } from "@gym/core/entitlements";
import { enqueue } from "@gym/core/jobs";
import {
  exportMembersCsv,
  importMembers,
  listMembersSchema,
} from "@gym/core/members";
import { runDailyMembershipJob } from "@gym/core/memberships";
import { deliverEmailNotification } from "@gym/core/notifications";
import { todayIn } from "@gym/core/time/dates";
import { escapeHtml } from "@gym/integrations/email";
import { Prisma, withTenant } from "@gym/db";
import type { JobContext } from "../context";
import { enqueueClassesDaily } from "./m3";
import { enqueuePaymentsDaily } from "./m4";

const OUTBOX_BATCH = 100;
const OUTBOX_LEASE_SECONDS = 60;
const OUTBOX_MAX_ATTEMPTS = 10;

/**
 * Outbox relay (every few seconds): claims due rows across tenants through app.outbox_claim and
 * turns each into a queue job whose id is the outbox id, so a crash between enqueue and
 * "complete" can never create two jobs (docs/ARCHITECTURE.md).
 */
export async function outboxRelay(ctx: JobContext<"outbox", "outbox.relay">) {
  const { db, redis } = ctx.services();
  const rows = await db.$queryRaw<
    {
      id: string;
      tenant_id: string;
      topic: string;
      payload: Record<string, unknown>;
    }[]
  >`
    SELECT id::text, tenant_id::text, topic, payload FROM app.outbox_claim(${OUTBOX_BATCH}, ${OUTBOX_LEASE_SECONDS}, ${OUTBOX_MAX_ATTEMPTS})`;
  let relayed = 0;
  for (const row of rows) {
    try {
      if (row.topic === "notification.email") {
        await enqueue(redis, "notifications", "notifications.send-email", {
          tenantId: row.tenant_id,
          actor: { type: "system" },
          idempotencyKey: `outbox-${row.id}`,
          data: { notificationId: String(row.payload.notificationId) },
        });
      } else if (row.topic === "event") {
        // M5 domain events: the job id is the event id, so a relay retry never doubles it.
        await enqueue(redis, "events", "events.dispatch", {
          tenantId: row.tenant_id,
          actor: { type: "system" },
          idempotencyKey: `event-${row.id}`,
          data: { eventId: row.id, type: String(row.payload.type) },
        });
      } else if (row.topic === "message.send") {
        // M6: the job id is the outbox id, so a relay retry never sends twice.
        await enqueue(redis, "messaging", "messaging.send", {
          tenantId: row.tenant_id,
          actor: { type: "system" },
          idempotencyKey: `outbox-${row.id}`,
          data: { outboundId: String(row.payload.outboundId) },
        });
      } else if (row.topic === "message.event") {
        await enqueue(redis, "messaging", "messaging.event", {
          tenantId: row.tenant_id,
          actor: { type: "system" },
          idempotencyKey: `outbox-${row.id}`,
          data: { messageEventId: String(row.payload.messageEventId) },
        });
      } else if (row.topic === "automation.run") {
        await enqueue(redis, "automation", "automation.run", {
          tenantId: row.tenant_id,
          actor: { type: "system" },
          idempotencyKey: `outbox-${row.id}`,
          data: { executionId: String(row.payload.executionId) },
        });
      } else {
        throw new Error(`Unknown outbox topic "${row.topic}"`);
      }
      // $executeRaw: these functions return void, which $queryRaw can't deserialize.
      await db.$executeRaw`SELECT app.outbox_complete(${row.id}::uuid)`;
      relayed++;
    } catch (err) {
      ctx.log.error({ err, outboxId: row.id }, "outbox relay failed");
      await db.$executeRaw`SELECT app.outbox_fail(${row.id}::uuid, ${err instanceof Error ? err.message : "error"})`;
    }
  }
  if (relayed) ctx.log.debug({ relayed }, "outbox relayed");
  return { relayed };
}

/** Sends one email notification; idempotent (only PENDING rows are sent). */
export async function sendEmail(
  ctx: JobContext<"notifications", "notifications.send-email">,
) {
  const { email, brand } = ctx.services();
  const result = await ctx.tenantDb((tx) =>
    deliverEmailNotification(
      tx,
      ctx.envelope.data.notificationId,
      async (message) => {
        const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0b1b33">${message.text
          .split("\n\n")
          .map(
            (p) =>
              `<p style="line-height:1.5">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`,
          )
          .join(
            "",
          )}<p style="font-size:12px;color:#5b6475">${escapeHtml(brand)}</p></body></html>`;
        await email.send({
          to: message.to,
          subject: message.subject,
          text: message.text,
          html,
        });
      },
    ),
  );
  return { result };
}

/** Hourly: queue each active tenant's daily job for its local date (once per tenant per day). */
export async function dailyScan(
  ctx: JobContext<"platform", "platform.daily-scan">,
) {
  const platform = ctx.platform();
  const { redis } = ctx.services();
  const tenants = await platform.db.tenant.findMany({
    where: { status: { in: ["ACTIVE", "SUSPENDED"] } },
    select: { id: true, timezone: true, status: true },
  });
  const now = new Date();
  for (const t of tenants) {
    const date = todayIn(t.timezone, now);
    await enqueue(redis, "memberships", "memberships.daily", {
      tenantId: t.id,
      actor: { type: "system" },
      idempotencyKey: `daily-${t.id}-${date}`,
      data: { date },
    });
    // M3: class schedules and PT expiry run on the same local date.
    await enqueueClassesDaily(redis, t.id, t.timezone, now);
    // M4: dues reminders + daily reconciliation.
    await enqueuePaymentsDaily(redis, t.id, t.timezone, now);
    // M6: template sync, scan-triggered automations, retention flags (ACTIVE tenants only).
    if (t.status === "ACTIVE")
      await enqueueGrowthDaily(redis, t.id, t.timezone, now);
    // M8: KPI rollup (also for suspended gyms: their reports stay readable).
    await enqueueMetricsRollup(redis, t.id, t.timezone, now);
  }
  return { tenants: tenants.length };
}

export async function membershipsDaily(
  ctx: JobContext<"memberships", "memberships.daily">,
) {
  const tenantId = ctx.envelope.tenantId!;
  const result = await ctx.tenantDb((tx) =>
    runDailyMembershipJob(tx, tenantId, ctx.envelope.data.date),
  );
  if (result.expired || result.reminded || result.frozen || result.unfrozen)
    ctx.log.info(result, "daily membership job");
  return result;
}

async function loadDataJob(
  ctx: JobContext<"data", "members.import" | "members.export">,
) {
  const job = await ctx.tenantDb((tx) =>
    tx.dataJob.findUnique({ where: { id: ctx.envelope.data.dataJobId } }),
  );
  if (!job) throw new Error("Data job not found");
  return job;
}

async function finish(
  ctx: JobContext<"data", "members.import" | "members.export">,
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

/** CSV import, as the staff user who uploaded it (their permissions apply, re-checked now). */
export async function membersImport(ctx: JobContext<"data", "members.import">) {
  const { db, storage } = ctx.services();
  const tenantId = ctx.envelope.tenantId!;
  const job = await loadDataJob(ctx);
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
    const ent = await entitlementsFor(
      { db, entitlements: noEntitlementCache },
      tenantId,
    );
    const summary = await importMembers(actor, ent, csv, {
      dryRun: job.dryRun,
      runRow: (fn) => withTenant(db, tenantId, fn, { userId: actor.userId }),
    });
    await finish(ctx, job.id, "SUCCEEDED", {
      ...summary,
      rows: summary.rows.slice(0, 500),
    });
    return { imported: summary.imported, errors: summary.errors };
  } catch (err) {
    await finish(ctx, job.id, "FAILED", {
      error: err instanceof Error ? err.message : "Import failed",
    });
    throw err;
  }
}

/** CSV export to private storage; the file and its link expire after 24 hours. */
export async function membersExport(ctx: JobContext<"data", "members.export">) {
  const { db, storage } = ctx.services();
  const tenantId = ctx.envelope.tenantId!;
  const job = await loadDataJob(ctx);
  if (job.status !== "PENDING") return { skipped: job.status };
  await ctx.tenantDb((tx) =>
    tx.dataJob.update({ where: { id: job.id }, data: { status: "RUNNING" } }),
  );
  try {
    const actor = await authContextFor(db, job.createdById, tenantId);
    if (!actor)
      throw new Error("The user who started this export no longer has access.");
    const filters = listMembersSchema.parse(job.params ?? {});
    const { csv, count } = await withTenant(db, tenantId, (tx) =>
      exportMembersCsv(tx, actor, {
        ...(filters.status !== "all" ? { status: filters.status } : {}),
        ...(filters.branchId ? { homeBranchId: filters.branchId } : {}),
      }),
    );
    const key = `tenants/${tenantId}/exports/${randomUUID()}.csv`;
    const { size } = await storage.put(key, csv, "text/csv");
    const file = await ctx.tenantDb((tx) =>
      tx.fileRecord.create({
        data: {
          tenantId,
          key,
          filename: `members-${new Date().toISOString().slice(0, 10)}.csv`,
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
