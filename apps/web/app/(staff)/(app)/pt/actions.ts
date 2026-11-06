"use server";

import {
  bookPtAppointment,
  cancelPtAppointment,
  createPtPackage,
  markPtAppointment,
  sellPtPackage,
  setPtPackageArchived,
  updatePtPackage,
} from "@gym/core/staff";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

/** Only back to our own pages. */
function safeBack(value: FormDataEntryValue | null, fallback: string) {
  const v = typeof value === "string" ? value : "";
  return /^\/(pt|members|my-day)(\/|\?|$)/.test(v) ? v : fallback;
}

function flash(path: string, ok: boolean, message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(
    `${path}${sep}${new URLSearchParams({ [ok ? "notice" : "error"]: message })}`,
  );
}

export async function createPackageAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () =>
    createPtPackage(
      services().deps,
      await getAuthContext(),
      formDataToObject(form),
    ),
  );
  if (!result.ok) return result;
  flash("/pt/packages", true, `${result.data.name} created.`);
}

export async function updatePackageAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const id = z.uuid().parse(form.get("packageId"));
  const result = await runAction(async () =>
    updatePtPackage(
      services().deps,
      await getAuthContext(),
      id,
      formDataToObject(form),
    ),
  );
  if (!result.ok) return result;
  flash(
    "/pt/packages",
    true,
    "Package saved. Packages already sold keep their terms.",
  );
}

export async function archivePackageAction(form: FormData) {
  const id = z.uuid().parse(form.get("packageId"));
  const archived = form.get("archived") === "true";
  const result = await runAction(async () =>
    setPtPackageArchived(services().deps, await getAuthContext(), id, archived),
  );
  flash(
    "/pt/packages",
    result.ok,
    result.ok
      ? archived
        ? "Package archived."
        : "Package restored."
      : result.error.message,
  );
}

export async function sellPackageAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const input = formDataToObject(form) as Record<string, unknown>;
  const memberId = z.uuid().parse(input.memberId);
  const amount = String(input.payAmount ?? "").trim();
  const payment =
    amount && input.payMethod
      ? {
          method: input.payMethod,
          amountMinor: Math.round(Number(amount) * 100),
          reference: input.payReference || undefined,
        }
      : undefined;
  const result = await runAction(async () =>
    sellPtPackage(services().deps, await getAuthContext(), {
      memberId,
      packageId: input.packageId,
      trainerId: input.trainerId,
      payment,
    }),
  );
  if (!result.ok) return result;
  flash(
    `/members/${memberId}`,
    true,
    result.data.balance.status === "ACTIVE"
      ? `PT package sold and active. Invoice ${result.data.invoice.number}.`
      : `PT package sold. It becomes active when invoice ${result.data.invoice.number} is paid.`,
  );
}

export async function bookAppointmentAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const back = safeBack(form.get("back"), "/pt");
  const result = await runAction(async () =>
    bookPtAppointment(
      services().deps,
      await getAuthContext(),
      formDataToObject(form),
    ),
  );
  if (!result.ok) return result;
  flash(back, true, "PT session booked. The member has been told.");
}

export async function markAppointmentAction(form: FormData) {
  const id = z.uuid().parse(form.get("appointmentId"));
  const back = safeBack(form.get("back"), "/pt");
  const result = await runAction(async () =>
    markPtAppointment(services().deps, await getAuthContext(), id, {
      status: form.get("status"),
      notes: form.get("notes") || undefined,
    }),
  );
  flash(back, result.ok, result.ok ? "Session saved." : result.error.message);
}

export async function cancelAppointmentAction(form: FormData) {
  const id = z.uuid().parse(form.get("appointmentId"));
  const back = safeBack(form.get("back"), "/pt");
  const result = await runAction(async () =>
    cancelPtAppointment(services().deps, await getAuthContext(), id, {
      reason: form.get("reason"),
    }),
  );
  flash(
    back,
    result.ok,
    result.ok
      ? result.data.late
        ? "Cancelled inside the cutoff, so it counts as a no-show."
        : "Session cancelled. The member has been told."
      : result.error.message,
  );
}
