import { apiCreateLead, parseApiKey } from "@gym/core/crm";
import { services } from "@/lib/services";

/**
 * POST /api/public/v1/leads — website enquiries (docs/API_DESIGN.md, OpenAPI at ./openapi.json).
 * Bearer API key → one gym and one branch. Rate-limited per key. Idempotency-Key supported.
 */
export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  const key = parseApiKey(
    /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1] ?? null,
  );
  if (key) {
    const limit = await services().limiter.hit("lead-api:key", key.prefix);
    if (!limit.allowed)
      return Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests for this key.",
          },
        },
        {
          status: 429,
          headers: { "Retry-After": String(limit.retryAfterSeconds) },
        },
      );
  }
  const text = await request.text();
  if (text.length > 20_000)
    return Response.json(
      { error: { code: "VALIDATION_FAILED", message: "Body too large." } },
      { status: 413 },
    );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Send JSON (Content-Type: application/json).",
        },
      },
      { status: 400 },
    );
  }
  const result = await apiCreateLead(services().deps, {
    authorization,
    body,
    idempotencyKey: request.headers.get("idempotency-key"),
  });
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
