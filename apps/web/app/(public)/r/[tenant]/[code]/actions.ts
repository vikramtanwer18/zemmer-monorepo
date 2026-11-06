"use server";

import { submitReferral } from "@gym/core/engagement";
import { AppError } from "@gym/core/errors";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { headers } from "next/headers";
import { runAction } from "@/lib/action";
import { clientIp } from "@/lib/lead-capture";
import { services } from "@/lib/services";

/** Public: a referred friend leaves their number. The code alone decides the gym and referrer. */
export async function submitReferralAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const { limiter, deps } = services();
    const code = String(form.get("code") ?? "");
    const [byIp, byCode] = [
      await limiter.hit("referral-form:ip", clientIp(await headers())),
      await limiter.hit("referral-form:code", code.toUpperCase()),
    ];
    if (!byIp.allowed || !byCode.allowed)
      throw new AppError(
        "RATE_LIMITED",
        "Too many sign-ups from here. Please try again later or call the gym.",
      );
    const body = formDataToObject(form);
    return submitReferral(deps, {
      slug: String(form.get("tenant") ?? ""),
      code,
      body,
      honeypot: typeof body.website === "string" ? body.website : undefined,
    });
  });
  if (!result.ok) return result;
  if (!result.data.ok)
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "This invite link isn't valid any more.",
      },
    };
  return { ok: true, message: "Thanks! The gym will call you soon." };
}
