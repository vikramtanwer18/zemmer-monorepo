"use server";

import { approveRefund, rejectRefund, requestRefund } from "@gym/core/payments";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

function flash(ok: boolean, message: string): never {
  redirect(
    `/payments/refunds?${new URLSearchParams({ [ok ? "notice" : "error"]: message })}`,
  );
}

const STATUS_TEXT: Record<string, string> = {
  PENDING_APPROVAL:
    "Refund requested. Someone else with refund access must approve it.",
  PENDING:
    "Refund sent to Razorpay. It shows as processed once Razorpay confirms.",
  PROCESSED: "Refund done.",
  FAILED: "The refund failed. The member's credit was put back.",
};

export async function requestRefundAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const result = await requestRefund(
      services().deps,
      await getAuthContext(),
      {
        paymentId: form.get("paymentId"),
        amount: form.get("amount"),
        reason: form.get("reason"),
        method: form.get("method") ?? "",
        reference: form.get("reference") ?? "",
        cancelMembership: form.get("cancelMembership") ?? "",
      },
    );
    flash(true, STATUS_TEXT[result.refund.status] ?? "Refund recorded.");
  });
}

export async function approveRefundAction(form: FormData) {
  const id = z.uuid().parse(form.get("refundId"));
  const result = await runAction(async () =>
    approveRefund(services().deps, await getAuthContext(), id),
  );
  flash(
    result.ok,
    result.ok
      ? (STATUS_TEXT[result.data.status] ?? "Refund approved.")
      : result.error.message,
  );
}

export async function rejectRefundAction(form: FormData) {
  const id = z.uuid().parse(form.get("refundId"));
  const result = await runAction(async () =>
    rejectRefund(services().deps, await getAuthContext(), id, {
      reason: form.get("reason"),
    }),
  );
  flash(
    result.ok,
    result.ok ? "Refund rejected. Nothing was paid out." : result.error.message,
  );
}
