import { enqueue } from "@gym/core/jobs";
import { createLogger } from "@gym/core/logger";
import { receivePlatformWebhook } from "@gym/core/saas-billing";
import { getEnv } from "@/env";
import { services } from "@/lib/services";

let log: ReturnType<typeof createLogger> | undefined;

/**
 * Razorpay webhooks for the platform's own account (gym subscriptions). Signature first; each
 * event stored once by its id; the worker applies it. Never logs the body or signature.
 */
export async function POST(request: Request) {
  log ??= createLogger({
    name: "platform-webhooks",
    level: getEnv().LOG_LEVEL,
  });
  const rawBody = await request.text();
  if (rawBody.length > 1_000_000)
    return new Response("Too large", { status: 413 });
  const { billing, redis } = services();
  const result = await receivePlatformWebhook(billing, {
    rawBody,
    signature: request.headers.get("x-razorpay-signature"),
    eventIdHeader: request.headers.get("x-razorpay-event-id"),
  });
  if (result.status !== 200) {
    await redis
      .incr("gym:metrics:platform_webhook_rejected")
      .catch(() => undefined);
    log.warn({ reason: result.reason }, "platform webhook rejected");
    return new Response(result.reason, { status: result.status });
  }
  await redis
    .incr("gym:metrics:platform_webhook_received")
    .catch(() => undefined);
  if (result.eventRowId) {
    try {
      await enqueue(redis, "platform", "platform.billing-webhook", {
        tenantId: null,
        actor: { type: "system" },
        idempotencyKey: `platform-webhook-${result.eventRowId}`,
        data: { eventRowId: result.eventRowId },
      });
    } catch (err) {
      // Stored: the hourly billing job replays unprocessed events.
      log.error({ err }, "platform webhook stored but not queued");
    }
  }
  return Response.json({ ok: true, duplicate: result.duplicate });
}
