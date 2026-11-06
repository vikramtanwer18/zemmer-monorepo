import { randomUUID } from "node:crypto";
import { enqueue } from "@gym/core/jobs";
import { getEnv } from "@/env";
import { getRedis } from "@/lib/queue";

/** Development only: queues a system.ping job so you can watch the worker log "pong". */
export async function POST() {
  if (getEnv().NODE_ENV === "production") {
    return new Response(null, { status: 404 });
  }
  const job = await enqueue(getRedis(), "system", "system.ping", {
    tenantId: null,
    actor: { type: "system" },
    idempotencyKey: `dev-ping-${randomUUID()}`,
    data: { message: "hello from web" },
  });
  return Response.json({ jobId: job.id });
}
