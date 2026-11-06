"use server";

import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { headers } from "next/headers";
import { runAction } from "@/lib/action";
import { captureLead } from "@/lib/lead-capture";

/** Public: a website visitor's enquiry. The form key alone decides the gym and branch. */
export async function submitLeadFormAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () =>
    captureLead({
      tenantSlug: String(form.get("tenant") ?? ""),
      key: String(form.get("formKey") ?? ""),
      body: formDataToObject(form),
      headers: await headers(),
    }),
  );
  if (!result.ok) return result;
  if (!result.data.ok)
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "This form isn't available any more.",
      },
    };
  return { ok: true, message: result.data.thankYou };
}
