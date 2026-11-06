"use server";

import {
  addAvailabilityException,
  addCertification,
  createCertificateUpload,
  removeAvailabilityException,
  removeCertification,
  setWeeklyAvailability,
  updateStaffProfile,
  upsertTrainerProfile,
} from "@gym/core/staff";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

const uid = (form: FormData) => z.uuid().parse(form.get("userId"));

export async function updateStaffProfileAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const userId = uid(form);
  const input = formDataToObject(form);
  delete input.userId;
  return formAction(
    async () =>
      updateStaffProfile(
        services().deps,
        await getAuthContext(),
        userId,
        input,
      ),
    "Saved.",
  );
}

export async function saveTrainerAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const userId = uid(form);
  return formAction(
    async () =>
      upsertTrainerProfile(
        services().deps,
        await getAuthContext(),
        userId,
        formDataToObject(form),
      ),
    "Trainer profile saved.",
  );
}

/** The weekly form has one row per day: dayN_on, dayN_from, dayN_to. */
export async function saveWeeklyAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const userId = uid(form);
  const slots = [1, 2, 3, 4, 5, 6, 7]
    .filter((d) => form.get(`day${d}_on`) === "on")
    .map((d) => ({
      dayOfWeek: d,
      from: String(form.get(`day${d}_from`) ?? ""),
      to: String(form.get(`day${d}_to`) ?? ""),
    }));
  return formAction(
    async () =>
      setWeeklyAvailability(services().deps, await getAuthContext(), userId, {
        slots,
      }),
    "Working hours saved.",
  );
}

export async function addExceptionAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const userId = uid(form);
  const input = formDataToObject(form);
  if (!input.from) delete input.from;
  if (!input.to) delete input.to;
  return formAction(
    async () =>
      addAvailabilityException(
        services().deps,
        await getAuthContext(),
        userId,
        input,
      ),
    "Added.",
  );
}

export async function removeExceptionAction(form: FormData) {
  const userId = uid(form);
  const id = z.uuid().parse(form.get("id"));
  const result = await runAction(async () =>
    removeAvailabilityException(services().deps, await getAuthContext(), id),
  );
  redirect(
    `/staff/${userId}?${new URLSearchParams(result.ok ? { notice: "Removed." } : { error: result.error.message })}`,
  );
}

export async function requestCertificateUploadAction(
  trainerId: string,
  input: { contentType: string; size: number },
) {
  return runAction(async () =>
    createCertificateUpload(
      services().deps,
      services().storage,
      await getAuthContext(),
      z.uuid().parse(trainerId),
      input,
    ),
  );
}

export async function addCertificationAction(
  trainerId: string,
  input: Record<string, unknown>,
) {
  return runAction(async () => {
    await addCertification(
      services().deps,
      services().storage,
      await getAuthContext(),
      z.uuid().parse(trainerId),
      input,
    );
    return true;
  });
}

export async function removeCertificationAction(form: FormData) {
  const userId = uid(form);
  const id = z.uuid().parse(form.get("id"));
  const result = await runAction(async () =>
    removeCertification(services().deps, await getAuthContext(), id),
  );
  redirect(
    `/staff/${userId}?${new URLSearchParams(result.ok ? { notice: "Certification removed." } : { error: result.error.message })}`,
  );
}
