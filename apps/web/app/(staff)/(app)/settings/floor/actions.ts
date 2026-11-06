"use server";

import {
  archiveScanDevice,
  createScanDevice,
  updateFloorSettings,
} from "@gym/core/attendance";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

export async function updateFloorSettingsAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const input: Record<string, unknown> = formDataToObject(form);
  input.checkoutBranchIds = form.getAll("checkoutBranchIds").map(String);
  return formAction(
    async () =>
      updateFloorSettings(services().deps, await getAuthContext(), input),
    "Saved.",
  );
}

export async function createDeviceAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      createScanDevice(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Scanner added. Pick it on the Scan page of that device.",
  );
}

export async function archiveDeviceAction(form: FormData) {
  const id = z.uuid().parse(form.get("deviceId"));
  const result = await runAction(async () =>
    archiveScanDevice(services().deps, await getAuthContext(), id),
  );
  redirect(
    `/settings/floor?${new URLSearchParams(result.ok ? { notice: "Scanner removed." } : { error: result.error.message })}`,
  );
}
