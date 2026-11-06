import type { PrismaClient } from "@gym/db";
import type { Redis } from "ioredis";
import { z } from "zod";
import { AppError } from "../errors";
import { QUEUE_NAMES, type QueueName } from "../jobs/catalogue";
import { getQueue } from "../jobs/queue";
import {
  requirePlatformPermission,
  type PlatformContext,
} from "../platform/context";
import { recordPlatformAudit } from "../platform/services";
import { parseInput } from "../validation";

const METRICS = [
  "webhook_received",
  "webhook_rejected",
  "platform_webhook_received",
  "platform_webhook_rejected",
] as const;

/**
 * System health for operators (platform.system.view): queue depths, recent failed jobs, webhook
 * counters and stuck/failed webhook events. Shows job names, ids and errors only, never job data.
 */
export async function systemHealth(
  db: PrismaClient,
  redis: Redis,
  ctx: PlatformContext,
) {
  requirePlatformPermission(ctx, "platform.system.view");
  const queues = [];
  for (const name of QUEUE_NAMES) {
    const q = getQueue(name, redis);
    const counts = await q.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
      "completed",
    );
    const failed = await q.getFailed(0, 9);
    queues.push({
      name,
      counts,
      failed: failed.map((j) => ({
        id: j.id ?? "",
        name: j.name,
        attempts: j.attemptsMade,
        failedAt: j.finishedOn ? new Date(j.finishedOn) : null,
        reason: (j.failedReason ?? "").slice(0, 300),
      })),
    });
  }
  const values = await redis.mget(...METRICS.map((m) => `gym:metrics:${m}`));
  const metrics = Object.fromEntries(
    METRICS.map((m, i) => [m, Number(values[i] ?? 0)]),
  ) as Record<(typeof METRICS)[number], number>;
  const platformWebhooks = await db.platformWebhookEvent.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  return {
    queues,
    metrics,
    platformWebhooks: platformWebhooks.map(
      (g): { status: string; count: number } => ({
        status: g.status,
        count: g._count._all,
      }),
    ),
    checkedAt: new Date(),
  };
}

const retrySchema = z.object({
  queue: z.enum(QUEUE_NAMES as [QueueName, ...QueueName[]]),
  jobId: z.string().min(1).max(200),
});

/** Re-runs one failed job (handlers are idempotent). platform.system.view is not enough. */
export async function retryFailedJob(
  db: PrismaClient,
  redis: Redis,
  ctx: PlatformContext,
  raw: unknown,
) {
  requirePlatformPermission(ctx, "platform.billing.manage");
  const { queue, jobId } = parseInput(retrySchema, raw);
  const job = await getQueue(queue, redis).getJob(jobId);
  if (!job)
    throw new AppError(
      "NOT_FOUND",
      "That job is gone (cleaned up or already retried).",
    );
  if (!(await job.isFailed()))
    throw new AppError("CONFLICT", "That job isn't in the failed list.");
  await job.retry("failed");
  await db.$transaction((tx) =>
    recordPlatformAudit(tx, ctx, {
      action: "platform.job_retried",
      entityType: "Job",
      entityId: null,
      meta: { queue, jobId, name: job.name },
    }),
  );
}

/**
 * M5: the outbox side of system health. Dead letters are outbox rows that gave up after their
 * retries (topic, attempts, last error; never the payload). Retry puts one back in the queue.
 */
export async function outboxHealth(db: PrismaClient, ctx: PlatformContext) {
  requirePlatformPermission(ctx, "platform.system.view");
  const [stats, dead] = [
    await db.$queryRaw<
      { status: string; topic: string; count: bigint; oldest: Date | null }[]
    >`
      SELECT status, topic, count, oldest FROM platform_api.outbox_stats()`,
    await db.$queryRaw<
      {
        id: string;
        tenant_id: string;
        tenant_name: string;
        topic: string;
        attempts: number;
        last_error: string | null;
        created_at: Date;
      }[]
    >`SELECT id::text, tenant_id::text, tenant_name, topic, attempts, last_error, created_at FROM platform_api.outbox_dead_letters(50)`,
  ];
  return {
    stats: stats.map((s) => ({
      status: s.status,
      topic: s.topic,
      count: Number(s.count),
      oldest: s.oldest,
    })),
    deadLetters: dead.map((d) => ({
      id: d.id,
      tenantId: d.tenant_id,
      tenantName: d.tenant_name,
      topic: d.topic,
      attempts: d.attempts,
      lastError: (d.last_error ?? "").slice(0, 300),
      createdAt: d.created_at,
    })),
  };
}

export async function retryOutboxRow(
  db: PrismaClient,
  ctx: PlatformContext,
  raw: unknown,
) {
  requirePlatformPermission(ctx, "platform.billing.manage");
  const { id } = parseInput(z.object({ id: z.uuid() }), raw);
  const [row] = await db.$queryRaw<
    { outbox_retry: boolean | null }[]
  >`SELECT platform_api.outbox_retry(${id}::uuid)`;
  if (!row?.outbox_retry)
    throw new AppError(
      "CONFLICT",
      "That item isn't waiting for a retry any more.",
    );
  await db.$transaction((tx) =>
    recordPlatformAudit(tx, ctx, {
      action: "platform.outbox_retried",
      entityType: "Outbox",
      entityId: id,
    }),
  );
}
