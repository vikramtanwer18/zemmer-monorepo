import { enqueue } from "@gym/core/jobs";
import {
  processWebhookEvent,
  reconcileTenant,
  sendDuesReminders,
} from "@gym/core/payments";
import {
  processPlatformWebhook,
  runBillingLifecycle,
} from "@gym/core/saas-billing";
import { todayIn } from "@gym/core/time/dates";
import type { JobContext } from "../context";

const SLOT_MS = 15 * 60 * 1000;

function needDeps(ctx: { services: () => { deps?: unknown } }) {
  const deps = ctx.services().deps;
  if (!deps) throw new Error("Worker payment services are not configured");
  return deps as NonNullable<ReturnType<typeof ctx.services>["deps"]> &
    Parameters<typeof processWebhookEvent>[0];
}

/** A stored, verified gym webhook → payments/refunds (idempotent; reprocessing is a no-op). */
export async function paymentsWebhook(
  ctx: JobContext<"payments", "payments.webhook">,
) {
  const result = await processWebhookEvent(
    needDeps(ctx),
    ctx.envelope.tenantId!,
    ctx.envelope.data.webhookEventId,
  );
  ctx.log.info({ outcome: result.outcome }, "payment webhook processed");
  return result;
}

export async function paymentsReconcile(
  ctx: JobContext<"payments", "payments.reconcile">,
) {
  const run = await reconcileTenant(needDeps(ctx), ctx.envelope.tenantId!, {
    kind: ctx.envelope.data.kind,
    olderThanMinutes: ctx.envelope.data.kind === "QUICK" ? 10 : 0,
  });
  if (run.fixed || run.mismatches)
    ctx.log.warn(run, "reconciliation found differences");
  return run;
}

/** Daily: dues reminders, then a full reconciliation of the last two days. */
export async function paymentsDaily(
  ctx: JobContext<"payments", "payments.daily">,
) {
  const tenantId = ctx.envelope.tenantId!;
  const dues = await ctx.tenantDb((tx) =>
    sendDuesReminders(tx, tenantId, ctx.envelope.data.date),
  );
  const { redis } = ctx.services();
  await enqueue(redis, "payments", "payments.reconcile", {
    tenantId,
    actor: { type: "system" },
    idempotencyKey: `recon-daily-${tenantId}-${ctx.envelope.data.date}`,
    data: { kind: "DAILY" },
  });
  return dues;
}

/** Every 15 minutes: each active tenant's quick reconciliation (cheap when nothing is open). */
export async function paymentsScan(
  ctx: JobContext<"platform", "platform.payments-scan">,
) {
  const tenants = await ctx.platform().db.tenant.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });
  const { redis } = ctx.services();
  const slot = Math.floor(Date.now() / SLOT_MS);
  for (const t of tenants)
    await enqueue(redis, "payments", "payments.reconcile", {
      tenantId: t.id,
      actor: { type: "system" },
      idempotencyKey: `recon-${t.id}-${slot}`,
      data: { kind: "QUICK" },
    });
  return { tenants: tenants.length };
}

export async function billingWebhook(
  ctx: JobContext<"platform", "platform.billing-webhook">,
) {
  ctx.platform(); // platform-only job
  const billing = ctx.services().billing;
  if (!billing) throw new Error("Worker billing services are not configured");
  return processPlatformWebhook(billing, ctx.envelope.data.eventRowId);
}

export async function billingLifecycle(
  ctx: JobContext<"platform", "platform.billing-lifecycle">,
) {
  ctx.platform();
  const billing = ctx.services().billing;
  if (!billing) throw new Error("Worker billing services are not configured");
  const result = await runBillingLifecycle(billing);
  if (
    result.suspended ||
    result.cancelled ||
    result.reminders ||
    result.replayed
  )
    ctx.log.info(result, "billing lifecycle");
  return result;
}

/** Called from the hourly daily-scan next to the membership job. */
export async function enqueuePaymentsDaily(
  redis: Parameters<typeof enqueue>[0],
  tenantId: string,
  timezone: string,
  now: Date,
) {
  const date = todayIn(timezone, now);
  await enqueue(redis, "payments", "payments.daily", {
    tenantId,
    actor: { type: "system" },
    idempotencyKey: `payments-daily-${tenantId}-${date}`,
    data: { date },
  });
}
