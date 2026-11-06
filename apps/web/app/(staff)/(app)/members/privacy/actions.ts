"use server";

import { completeDeletion, rejectDataRequest } from "@gym/core/members";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

function flash(ok: boolean, message: string): never {
  redirect(
    `/members/privacy?${new URLSearchParams({ [ok ? "notice" : "error"]: message })}`,
  );
}

export async function completeDeletionAction(form: FormData) {
  const id = z.uuid().parse(form.get("requestId"));
  const result = await runAction(async () =>
    completeDeletion(services().deps, await getAuthContext(), id),
  );
  flash(
    result.ok,
    result.ok
      ? "Personal details removed and app access ended. Invoices and payments are kept for the tax records."
      : result.error.message,
  );
}

export async function rejectDataRequestAction(form: FormData) {
  const id = z.uuid().parse(form.get("requestId"));
  const result = await runAction(async () =>
    rejectDataRequest(services().deps, await getAuthContext(), id, {
      note: form.get("note"),
    }),
  );
  flash(result.ok, result.ok ? "Request declined." : result.error.message);
}
