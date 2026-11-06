"use server";

import {
  cancelMySubscription,
  changeMySubscription,
} from "@gym/core/saas-billing";
import { redirect } from "next/navigation";
import { runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

function flash(ok: boolean, message: string): never {
  redirect(
    `/settings/plan?${new URLSearchParams({ [ok ? "notice" : "error"]: message })}`,
  );
}

const transport = () => ({
  adminUrl: services().adminUrl,
  secret: services().internalSecret,
});

export async function choosePlanAction(form: FormData) {
  const res = await runAction(async () =>
    changeMySubscription(
      services().deps,
      await getAuthContext(),
      { priceId: form.get("priceId") },
      transport(),
    ),
  );
  if (!res.ok) flash(false, res.error.message);
  // A new subscription: off to the payment page (Razorpay, or the dev test checkout).
  if (res.data.kind === "checkout") redirect(res.data.url);
  flash(
    true,
    res.data.when === "now"
      ? "Upgraded. The new features are on now."
      : "Done. You move to the new plan at the end of this billing period.",
  );
}

export async function cancelPlanAction() {
  const res = await runAction(async () =>
    cancelMySubscription(services().deps, await getAuthContext(), transport()),
  );
  flash(
    res.ok,
    res.ok
      ? "Cancelled. Everything keeps working until the end of this billing period."
      : res.error.message,
  );
}
