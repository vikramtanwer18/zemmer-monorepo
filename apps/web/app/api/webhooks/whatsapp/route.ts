import { createLogger } from "@gym/core/logger";
import {
  answerWebhookChallenge,
  receiveWhatsAppWebhook,
} from "@gym/core/messaging";
import { getEnv } from "@/env";
import { getRedis } from "@/lib/queue";
import { services } from "@/lib/services";

let log: ReturnType<typeof createLogger> | undefined;

/**
 * The one WhatsApp webhook for every gym (D-12). GET: Meta's subscription handshake (verify
 * token). POST: `X-Hub-Signature-256` is checked over the raw body with the Meta app secret
 * before anything is read; items are routed to their gym by phone number id, stored once and
 * queued. Meta retries anything that isn't 200, so verified bodies always get 200 quickly.
 */
export async function GET(request: Request) {
  const result = answerWebhookChallenge(
    new URL(request.url).searchParams,
    services().meta.verifyToken ?? undefined,
  );
  if (result.status !== 200) return new Response("Forbidden", { status: 403 });
  return new Response(result.body, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(request: Request) {
  log ??= createLogger({ name: "webhooks", level: getEnv().LOG_LEVEL });
  const rawBody = await request.text();
  if (rawBody.length > 3_000_000)
    return new Response("Too large", { status: 413 });
  const redis = getRedis();
  const { db, meta } = services();
  const result = await receiveWhatsAppWebhook(db, {
    rawBody,
    signature: request.headers.get("x-hub-signature-256"),
    appSecret: meta.appSecret ?? undefined,
  });
  if (!result.ok) {
    await redis
      .incr("gym:metrics:whatsapp_webhook_rejected")
      .catch(() => undefined);
    // Never log the body or the signature.
    log.warn({ status: result.status }, "whatsapp webhook rejected");
    return new Response(
      result.status === 401 ? "Invalid signature" : "Bad request",
      { status: result.status },
    );
  }
  await redis
    .incr("gym:metrics:whatsapp_webhook_received")
    .catch(() => undefined);
  if (result.unrouted)
    log.info(
      { unrouted: result.unrouted },
      "whatsapp webhook items for unknown numbers dropped",
    );
  return Response.json({
    ok: true,
    accepted: result.accepted,
    duplicates: result.duplicates,
  });
}
