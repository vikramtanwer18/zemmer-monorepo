import "server-only";
import { isAppError } from "@gym/core/errors";
import { verifyInternalRequest } from "@gym/core/saas-billing";
import { createLogger } from "@gym/core/logger";
import type { z } from "zod";
import { getEnv } from "@/env";
import { services } from "@/lib/services";

let log: ReturnType<typeof createLogger> | undefined;

/**
 * Signed requests from apps/web (owner billing). The gym app has already checked the owner's
 * permission; here we only trust what the shared-secret signature covers, and re-read the rest.
 */
export function internalRoute<S extends z.ZodType, T>(
  path: string,
  schema: S,
  handler: (input: z.infer<S>) => Promise<T>,
) {
  return async function POST(request: Request) {
    log ??= createLogger({ name: "internal", level: getEnv().LOG_LEVEL });
    const body = await request.text();
    if (body.length > 10_000) return new Response("Too large", { status: 413 });
    const ok = verifyInternalRequest(services().internalSecret, path, body, {
      timestamp: request.headers.get("x-internal-timestamp"),
      signature: request.headers.get("x-internal-signature"),
    });
    if (!ok) {
      log.warn({ path }, "internal request with a bad signature");
      return Response.json({ error: "Not allowed." }, { status: 401 });
    }
    let parsed;
    try {
      parsed = schema.parse(JSON.parse(body));
    } catch {
      return Response.json({ error: "Bad request." }, { status: 400 });
    }
    try {
      return Response.json(await handler(parsed));
    } catch (err) {
      if (isAppError(err))
        return Response.json(
          { error: err.message, code: err.code },
          { status: err.status },
        );
      log.error({ err, path }, "internal request failed");
      return Response.json(
        { error: "Billing couldn't do that. Try again in a minute." },
        { status: 500 },
      );
    }
  };
}
