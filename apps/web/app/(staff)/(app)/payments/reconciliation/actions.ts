"use server";

import {
  resolveReconciliationItem,
  runReconciliationNow,
} from "@gym/core/payments";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

function flash(ok: boolean, message: string): never {
  redirect(
    `/payments/reconciliation?${new URLSearchParams({ [ok ? "notice" : "error"]: message })}`,
  );
}

export async function runReconciliationAction() {
  const result = await runAction(async () =>
    runReconciliationNow(services().deps, await getAuthContext()),
  );
  flash(
    result.ok,
    result.ok
      ? `Checked ${result.data.checked} with Razorpay: ${result.data.fixed} fixed, ${result.data.mismatches} to look at.`
      : result.error.message,
  );
}

export async function resolveItemAction(form: FormData) {
  const id = z.uuid().parse(form.get("itemId"));
  const result = await runAction(async () =>
    resolveReconciliationItem(services().deps, await getAuthContext(), id, {
      note: form.get("note"),
    }),
  );
  flash(result.ok, result.ok ? "Marked as sorted." : result.error.message);
}
