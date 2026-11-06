"use server";

import {
  addOverride,
  changeTenantPlan,
  changeTenantStatus,
  createPlan,
  createPlanVersion,
  createTenantByPlatform,
  endSupportSession,
  removeOverride,
  resendOwnerInvitation,
  setPlanStatus,
  startSupportSession,
  updatePlanFeatures,
  updatePlatformSettings,
} from "@gym/core/platform";
import { checkboxSchema, formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getPlatformContext } from "@/lib/session";

const uuid = (value: FormDataEntryValue | null) => z.uuid().parse(value);

async function runAndReturn(
  path: string,
  fn: () => Promise<unknown>,
  notice: string,
): Promise<never> {
  const result = await runAction(fn);
  const params = new URLSearchParams(
    result.ok ? { notice } : { error: result.error.message.slice(0, 200) },
  );
  redirect(`${path}?${params}`);
}

// --- tenants -------------------------------------------------------------------------

export async function createTenantAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const { deps, ownerInviteMailer } = services();
    return createTenantByPlatform(
      deps,
      ownerInviteMailer,
      await getPlatformContext(),
      formDataToObject(form),
    );
  });
  if (!result.ok) return result;
  redirect(
    `/tenants/${result.data.id}?notice=${encodeURIComponent("Tenant created and owner invited.")}`,
  );
}

export async function tenantStatusAction(form: FormData) {
  const tenantId = String(form.get("tenantId"));
  const change = z
    .enum(["approve", "suspend", "reactivate"])
    .parse(form.get("change"));
  return runAndReturn(
    `/tenants/${tenantId}`,
    async () =>
      changeTenantStatus(
        services().deps,
        await getPlatformContext(),
        uuid(tenantId),
        change,
        form.get("reason"),
      ),
    change === "approve"
      ? "Tenant approved."
      : change === "suspend"
        ? "Tenant suspended."
        : "Tenant reactivated.",
  );
}

export async function resendOwnerInviteAction(form: FormData) {
  const tenantId = String(form.get("tenantId"));
  return runAndReturn(
    `/tenants/${tenantId}`,
    async () => {
      const { deps, ownerInviteMailer } = services();
      await resendOwnerInvitation(
        deps,
        ownerInviteMailer,
        await getPlatformContext(),
        uuid(tenantId),
        form.get("email"),
      );
    },
    "Owner invitation sent.",
  );
}

export async function changePlanAction(form: FormData) {
  const tenantId = String(form.get("tenantId"));
  return runAndReturn(
    `/tenants/${tenantId}`,
    async () =>
      changeTenantPlan(
        services().deps,
        await getPlatformContext(),
        uuid(tenantId),
        { planId: form.get("planId") },
      ),
    "Plan changed.",
  );
}

export async function addOverrideAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const tenantId = uuid(form.get("tenantId"));
    await addOverride(
      services().deps,
      await getPlatformContext(),
      tenantId,
      formDataToObject(form),
    );
  }, "Override added. It applies within a few seconds.");
}

export async function removeOverrideAction(form: FormData) {
  const tenantId = String(form.get("tenantId"));
  return runAndReturn(
    `/tenants/${tenantId}`,
    async () =>
      removeOverride(
        services().deps,
        await getPlatformContext(),
        uuid(form.get("overrideId")),
      ),
    "Override removed.",
  );
}

// --- plans ---------------------------------------------------------------------------

export async function createPlanAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      createPlan(
        services().deps,
        await getPlatformContext(),
        formDataToObject(form),
      ),
    "Draft plan created. Set its features, then publish it.",
  );
}

export async function newPlanVersionAction(form: FormData) {
  return runAndReturn(
    "/plans",
    async () =>
      createPlanVersion(
        services().deps,
        await getPlatformContext(),
        uuid(form.get("planId")),
      ),
    "New draft version created.",
  );
}

export async function updatePlanFeaturesAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const planId = uuid(form.get("planId"));
    const values: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (key.startsWith("f:") && typeof value === "string")
        values[key.slice(2)] = value;
    }
    await updatePlanFeatures(
      services().deps,
      await getPlatformContext(),
      planId,
      values,
    );
  }, "Plan features saved.");
}

export async function setPlanStatusAction(form: FormData) {
  const status = z.enum(["ACTIVE", "RETIRED"]).parse(form.get("status"));
  return runAndReturn(
    "/plans",
    async () =>
      setPlanStatus(
        services().deps,
        await getPlatformContext(),
        uuid(form.get("planId")),
        status,
      ),
    status === "ACTIVE" ? "Plan published." : "Plan retired.",
  );
}

// --- settings ------------------------------------------------------------------------

export async function updateSettingsAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const raw = formDataToObject(form);
    await updatePlatformSettings(services().deps, await getPlatformContext(), {
      ...raw,
      approvalRequired: checkboxSchema.parse(raw.approvalRequired),
      embeddedSignupEnabled: checkboxSchema.parse(raw.embeddedSignupEnabled),
    });
  }, "Platform settings saved.");
}

// --- support -------------------------------------------------------------------------

export async function startSupportAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const tenantId = uuid(form.get("tenantId"));
    return startSupportSession(
      services().deps,
      await getPlatformContext(),
      tenantId,
      formDataToObject(form),
    );
  });
  if (!result.ok) return result;
  redirect(`/support/${result.data.id}`);
}

export async function endSupportAction(form: FormData) {
  const id = String(form.get("sessionId"));
  return runAndReturn(
    "/support",
    async () =>
      endSupportSession(services().deps, await getPlatformContext(), uuid(id)),
    "Support session ended.",
  );
}
