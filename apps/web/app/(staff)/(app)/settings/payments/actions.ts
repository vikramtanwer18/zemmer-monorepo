"use server";

import {
  connectPaymentIntegration,
  disconnectPaymentIntegration,
  updatePaymentPolicies,
  verifyPaymentIntegration,
} from "@gym/core/payments";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

export async function connectAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      connectPaymentIntegration(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
        {
          allowFake: services().fakePayments,
        },
      ),
    "Connected. Now add the webhook in Razorpay (below).",
  );
}

export async function verifyAction() {
  const result = await runAction(async () =>
    verifyPaymentIntegration(services().deps, await getAuthContext()),
  );
  const ok = result.ok && result.data.ok;
  redirect(
    `/settings/payments?${new URLSearchParams(
      ok
        ? { notice: "Razorpay accepted the keys." }
        : {
            error: result.ok
              ? result.data.ok
                ? ""
                : result.data.reason
              : result.error.message,
          },
    )}`,
  );
}

export async function disconnectAction(form: FormData) {
  const result = await runAction(async () =>
    disconnectPaymentIntegration(
      services().deps,
      await getAuthContext(),
      formDataToObject(form),
    ),
  );
  redirect(
    `/settings/payments?${new URLSearchParams(result.ok ? { notice: "Disconnected. Members now pay at the desk." } : { error: result.error.message })}`,
  );
}

export async function policiesAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      updatePaymentPolicies(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Saved.",
  );
}
