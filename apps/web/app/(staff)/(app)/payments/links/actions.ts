"use server";

import {
  cancelPaymentLink,
  recheckPaymentLink,
  sendPaymentLink,
} from "@gym/core/payments";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

const back = (form: FormData, fallback: string) => {
  const v = String(form.get("back") ?? "");
  return /^\/(payments|invoices|members)(\/|\?|$)/.test(v) ? v : fallback;
};

function flash(path: string, ok: boolean, message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(
    `${path}${sep}${new URLSearchParams({ [ok ? "notice" : "error"]: message })}`,
  );
}

export async function sendLinkAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const input: Record<string, unknown> = {
      invoiceIds: form.getAll("invoiceIds").map(String),
      acceptPartial: form.get("acceptPartial") ?? "",
      minPartial: form.get("minPartial") ?? "",
      sendEmail: form.get("sendEmail") ?? "",
    };
    return sendPaymentLink(services().deps, await getAuthContext(), input);
  }, "Payment link created. Copy it below, or the member has been emailed.");
}

export async function cancelLinkAction(form: FormData) {
  const id = z.uuid().parse(form.get("linkId"));
  const result = await runAction(async () =>
    cancelPaymentLink(services().deps, await getAuthContext(), id),
  );
  flash(
    back(form, "/payments/links"),
    result.ok,
    result.ok ? "Link cancelled." : result.error.message,
  );
}

export async function recheckLinkAction(form: FormData) {
  const id = z.uuid().parse(form.get("linkId"));
  const result = await runAction(async () =>
    recheckPaymentLink(services().deps, await getAuthContext(), id),
  );
  flash(
    back(form, "/payments/links"),
    result.ok,
    result.ok
      ? result.data.fetched
        ? `Checked with Razorpay: ${result.data.status.replace("_", " ").toLowerCase()}${result.data.recorded ? `, ${result.data.recorded} payment(s) recorded` : ""}.`
        : "Couldn't reach Razorpay. Try again later."
      : result.error.message,
  );
}
