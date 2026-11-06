import {
  runAutomationScansTx,
  runExecution,
  resumeDueExecutionsTx,
} from "@gym/core/automation";
import { dispatchCampaigns } from "@gym/core/growth";
import { enqueue } from "@gym/core/jobs";
import {
  deliverMessage,
  EventNotReadyError,
  failStaleSendsTx,
  processMessageEvent,
  RetryableSendError,
  syncTemplates,
} from "@gym/core/messaging";
import { runEngagementDailyTx } from "@gym/core/engagement";
import { runRetentionTx } from "@gym/core/retention";
import type { CoreDeps } from "@gym/core/tenancy";
import { todayIn } from "@gym/core/time/dates";
import { withTenant } from "@gym/db";
import type { Job } from "bullmq";
import type { JobContext } from "../context";

const MINUTE = 60_000;

function deps(ctx: { services: () => { deps?: CoreDeps } }): CoreDeps {
  const d = ctx.services().deps;
  if (!d?.whatsapp)
    throw new Error("Worker WhatsApp services are not configured");
  return d;
}

/** True on the job's last try: a retryable failure then becomes final. */
const finalAttempt = (job: Job) =>
  job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

/** One WhatsApp message: gate re-checked now, then the provider (never twice: see deliverMessage). */
export async function messagingSend(
  ctx: JobContext<"messaging", "messaging.send">,
) {
  try {
    const result = await deliverMessage(
      deps(ctx),
      ctx.envelope.tenantId!,
      ctx.envelope.data.outboundId,
      {
        finalAttempt: finalAttempt(ctx.job),
      },
    );
    if (result.status === "FAILED")
      ctx.log.warn({ code: result.code }, "whatsapp send failed");
    return result;
  } catch (err) {
    if (err instanceof RetryableSendError)
      ctx.log.info({ code: err.code }, "whatsapp send will retry");
    throw err;
  }
}

/** A verified, stored Meta webhook item (status, inbound message, template update). */
export async function messagingEvent(
  ctx: JobContext<"messaging", "messaging.event">,
) {
  try {
    return await processMessageEvent(
      deps(ctx),
      ctx.envelope.tenantId!,
      ctx.envelope.data.messageEventId,
      {
        finalAttempt: finalAttempt(ctx.job),
      },
    );
  } catch (err) {
    if (err instanceof EventNotReadyError)
      ctx.log.debug("status arrived before the send finished; retrying");
    throw err;
  }
}

export async function messagingSyncTemplates(
  ctx: JobContext<"messaging", "messaging.sync-templates">,
) {
  return syncTemplates(
    deps(ctx),
    ctx.envelope.tenantId!,
    ctx.envelope.data.accountId,
  );
}

/** Every minute per tenant: campaign batches (throttled), automation waits that are over, stuck sends. */
export async function messagingTick(
  ctx: JobContext<"messaging", "messaging.tick">,
) {
  const d = deps(ctx);
  const tenantId = ctx.envelope.tenantId!;
  const now = new Date();
  const campaigns = await dispatchCampaigns(d, tenantId);
  const { resumed, stale } = await withTenant(d.db, tenantId, async (tx) => ({
    resumed: await resumeDueExecutionsTx(tx, tenantId, now),
    stale: await failStaleSendsTx(tx, now),
  }));
  if (campaigns.queued || campaigns.started || resumed || stale)
    ctx.log.info({ ...campaigns, resumed, stale }, "messaging tick");
  return { ...campaigns, resumed, stale };
}

export async function messagingScan(
  ctx: JobContext<"platform", "platform.messaging-scan">,
) {
  const tenants = await ctx
    .platform()
    .db.tenant.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const { redis } = ctx.services();
  const slot = Math.floor(Date.now() / MINUTE);
  for (const t of tenants)
    await enqueue(redis, "messaging", "messaging.tick", {
      tenantId: t.id,
      actor: { type: "system" },
      idempotencyKey: `msg-tick-${t.id}-${slot}`,
      data: {},
    });
  return { tenants: tenants.length };
}

export async function automationRun(
  ctx: JobContext<"automation", "automation.run">,
) {
  return {
    outcome: await runExecution(
      deps(ctx),
      ctx.envelope.tenantId!,
      ctx.envelope.data.executionId,
      { finalAttempt: finalAttempt(ctx.job) },
    ),
  };
}

/** Nightly on the tenant's local date: template sync, scan-triggered workflows, retention flags. */
export async function growthDaily(ctx: JobContext<"growth", "growth.daily">) {
  const d = deps(ctx);
  const tenantId = ctx.envelope.tenantId!;
  const now = new Date();
  const account = await ctx.tenantDb((tx) =>
    tx.whatsAppAccount.findFirst({
      where: { status: { not: "DISCONNECTED" } },
      select: { id: true },
    }),
  );
  let templates: unknown = null;
  if (account)
    templates = await syncTemplates(d, tenantId, account.id).catch(
      (err: unknown) => {
        ctx.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "nightly template sync failed",
        );
        return null;
      },
    );
  const scans = await ctx.tenantDb((tx) =>
    runAutomationScansTx(tx, tenantId, ctx.envelope.data.date, now),
  );
  const retention = await ctx.tenantDb((tx) =>
    runRetentionTx(tx, tenantId, ctx.envelope.data.date, now),
  );
  ctx.log.info({ scans, retention }, "growth daily");
  return { templates, scans, retention };
}

/** M7: streaks, streak milestones, ending challenges, on the tenant's local date. */
export async function engagementDaily(
  ctx: JobContext<"engagement", "engagement.daily">,
) {
  const tenantId = ctx.envelope.tenantId!;
  const result = await ctx.tenantDb((tx) =>
    runEngagementDailyTx(tx, tenantId, ctx.envelope.data.date, new Date()),
  );
  if (result.streaks || result.challengesEnded)
    ctx.log.info(result, "engagement daily");
  return result;
}

/** Called from the hourly daily-scan: queues growth.daily (and engagement.daily) once per tenant local date. */
export async function enqueueGrowthDaily(
  redis: Parameters<typeof enqueue>[0],
  tenantId: string,
  timeZone: string,
  now: Date,
) {
  const date = todayIn(timeZone, now);
  await enqueue(redis, "growth", "growth.daily", {
    tenantId,
    actor: { type: "system" },
    idempotencyKey: `growth-${tenantId}-${date}`,
    data: { date },
  });
  await enqueue(redis, "engagement", "engagement.daily", {
    tenantId,
    actor: { type: "system" },
    idempotencyKey: `engagement-${tenantId}-${date}`,
    data: { date },
  });
}
