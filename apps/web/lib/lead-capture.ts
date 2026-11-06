import "server-only";
import { submitPublicForm, type PublicSubmitResult } from "@gym/core/crm";
import { AppError } from "@gym/core/errors";
import { services } from "@/lib/services";

/** The visitor's IP (first hop set by the reverse proxy). */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Shared by the hosted page and the embed: rate limits (per IP and per form) first, then the core
 * service (honeypot, consent, tenant from the form key only). A captcha can be plugged in here.
 */
export async function captureLead(input: {
  tenantSlug: string;
  key: string;
  body: Record<string, unknown>;
  headers: Headers;
}): Promise<PublicSubmitResult> {
  const { limiter, deps } = services();
  const ip = clientIp(input.headers);
  const [byIp, byForm] = [
    await limiter.hit("lead-form:ip", ip),
    await limiter.hit("lead-form:form", input.key),
  ];
  if (!byIp.allowed || !byForm.allowed)
    throw new AppError(
      "RATE_LIMITED",
      "Too many enquiries from here. Please try again later or call the gym.",
    );
  const honeypot =
    typeof input.body.website === "string" ? input.body.website : null;
  return submitPublicForm(deps, {
    tenantSlug: input.tenantSlug,
    key: input.key,
    body: input.body,
    honeypot,
  });
}
