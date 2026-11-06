import { enqueue } from "@gym/core/jobs";
import { createLogger } from "@gym/core/logger";
import { receiveWebhook } from "@gym/core/payments";
import { getEnv } from "@/env";
import { getRedis } from "@/lib/queue";
import { services } from "@/lib/services";

let log: ReturnType<typeof createLogger> | undefined;

/**
 * Razorpay webhooks for one gym's account (D-10). Verifies the signature over the raw body before
 * trusting anything, stores each event once (provider event id), queues processing and answers
 * 200 fast. A bad signature gets 400 and nothing is written (only counted, for System health).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ integrationId: string }> },
) {
  log ??= createLogger({ name: "webhooks", level: getEnv().LOG_LEVEL });
  const { integrationId } = await params;
  const rawBody = await request.text();
  if (rawBody.length > 1_000_000)
    return new Response("Too large", { status: 413 });
  const redis = getRedis();
  const result = await receiveWebhook(services().deps, {
    integrationId,
    rawBody,
    signature: request.headers.get("x-razorpay-signature"),
    eventIdHeader: request.headers.get("x-razorpay-event-id"),
  });
  if (result.status !== 200) {
    await redis.incr("gym:metrics:webhook_rejected").catch(() => undefined);
    // Never log the body or signature.
    log.warn({ integrationId, reason: result.reason }, "webhook rejected");
    return new Response(result.reason, { status: result.status });
  }
  await redis.incr("gym:metrics:webhook_received").catch(() => undefined);
  if (result.webhookEventId) {
    try {
      await enqueue(redis, "payments", "payments.webhook", {
        tenantId: result.tenantId,
        actor: { type: "system" },
        idempotencyKey: `webhook-${result.webhookEventId}`,
        data: { webhookEventId: result.webhookEventId },
      });
    } catch (err) {
      // Stored already: reconciliation reprocesses stuck events, so still answer 200.
      log.error({ err, integrationId }, "webhook stored but not queued");
    }
  }
  return Response.json({ ok: true, duplicate: result.duplicate });
}
