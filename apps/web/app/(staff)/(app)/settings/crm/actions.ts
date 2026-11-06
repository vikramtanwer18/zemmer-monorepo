"use server";

import {
  archiveCampaign,
  archiveCaptureForm,
  archiveLostReason,
  archiveStage,
  confirmLeadImport,
  createApiKey,
  createLostReason,
  createSource,
  createStage,
  registerLeadImport,
  renameStage,
  reorderStages,
  revokeApiKey,
  saveCampaign,
  saveCaptureForm,
  updateCrmSettings,
  updateSourcePoints,
} from "@gym/core/crm";
import { AppError } from "@gym/core/errors";
import { enqueue } from "@gym/core/jobs";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { getRedis } from "@/lib/queue";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

const uuid = (v: FormDataEntryValue | null) => z.uuid().parse(v);

function backTo(form: FormData, fallback: string) {
  const v = String(form.get("back") ?? "");
  return /^\/(settings\/crm|leads)(\/|\?|$)/.test(v) ? v : fallback;
}

async function run(
  form: FormData,
  fallback: string,
  fn: () => Promise<unknown>,
  notice: string,
): Promise<never> {
  const result = await runAction(fn);
  const path = backTo(form, fallback);
  redirect(
    `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams(result.ok ? { notice } : { error: result.error.message })}`,
  );
}

// --- pipeline ------------------------------------------------------------------------------------

export async function createStageAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      createStage(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Stage added.",
  );
}

export async function renameStageAction(form: FormData) {
  return run(
    form,
    "/settings/crm",
    async () =>
      renameStage(
        services().deps,
        await getAuthContext(),
        uuid(form.get("stageId")),
        { name: form.get("name") },
      ),
    "Stage renamed.",
  );
}

/** Up/down buttons: swap with the neighbour, then save the whole order. */
export async function moveStageAction(form: FormData) {
  const ids = String(form.get("order") ?? "")
    .split(",")
    .filter(Boolean);
  const id = String(form.get("stageId"));
  const dir = form.get("dir") === "up" ? -1 : 1;
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i >= 0 && j >= 0 && j < ids.length) [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  return run(
    form,
    "/settings/crm",
    async () => reorderStages(services().deps, await getAuthContext(), { ids }),
    "Order saved.",
  );
}

export async function archiveStageAction(form: FormData) {
  return run(
    form,
    "/settings/crm",
    async () =>
      archiveStage(
        services().deps,
        await getAuthContext(),
        uuid(form.get("stageId")),
        { moveTo: form.get("moveTo") || undefined },
      ),
    "Stage removed.",
  );
}

export async function createSourceAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      createSource(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Source added.",
  );
}

export async function sourcePointsAction(form: FormData) {
  return run(
    form,
    "/settings/crm",
    async () =>
      updateSourcePoints(
        services().deps,
        await getAuthContext(),
        uuid(form.get("sourceId")),
        { points: form.get("points") },
      ),
    "Points saved.",
  );
}

export async function createLostReasonAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      createLostReason(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Reason added.",
  );
}

export async function archiveLostReasonAction(form: FormData) {
  return run(
    form,
    "/settings/crm",
    async () =>
      archiveLostReason(
        services().deps,
        await getAuthContext(),
        uuid(form.get("reasonId")),
      ),
    "Reason removed.",
  );
}

export async function crmSettingsAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      updateCrmSettings(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Saved.",
  );
}

// --- campaigns ------------------------------------------------------------------------------------

export async function saveCampaignAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const id = form.get("campaignId") ? uuid(form.get("campaignId")) : null;
  return formAction(
    async () =>
      saveCampaign(
        services().deps,
        await getAuthContext(),
        id,
        formDataToObject(form),
      ),
    id ? "Campaign saved." : "Campaign added.",
  );
}

export async function archiveCampaignAction(form: FormData) {
  return run(
    form,
    "/leads/campaigns",
    async () =>
      archiveCampaign(
        services().deps,
        await getAuthContext(),
        uuid(form.get("campaignId")),
      ),
    "Campaign archived.",
  );
}

// --- capture forms and API keys --------------------------------------------------------------------

export async function saveFormAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const id = form.get("formId") ? uuid(form.get("formId")) : null;
  let savedId: string | null = null;
  const result = await formAction(async () => {
    const raw = formDataToObject(form) as Record<string, unknown>;
    savedId = (
      await saveCaptureForm(services().deps, await getAuthContext(), id, {
        ...raw,
        fields: form.getAll("fields").map(String),
      })
    ).id;
  }, "Form saved.");
  if (result.ok && !id && savedId)
    redirect(
      `/settings/crm/forms/${savedId}?notice=${encodeURIComponent("Form created. Share the link or embed it below.")}`,
    );
  return result;
}

export async function archiveFormAction(form: FormData) {
  return run(
    form,
    "/settings/crm/forms",
    async () =>
      archiveCaptureForm(
        services().deps,
        await getAuthContext(),
        uuid(form.get("formId")),
      ),
    "Form switched off.",
  );
}

/** Shows the new key once (in the redirect to the keys page, never stored readable). */
export async function createApiKeyAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () =>
    createApiKey(
      services().deps,
      await getAuthContext(),
      formDataToObject(form),
    ),
  );
  if (!result.ok) return result;
  return {
    ok: true,
    message: "Key created. Copy it now: it won't be shown again.",
    data: { key: result.data.key },
  };
}

export async function revokeApiKeyAction(form: FormData) {
  return run(
    form,
    "/settings/crm/api",
    async () =>
      revokeApiKey(
        services().deps,
        await getAuthContext(),
        uuid(form.get("keyId")),
      ),
    "Key revoked. Requests with it now fail.",
  );
}

// --- import -------------------------------------------------------------------------------------------

export async function requestLeadImportUploadAction(input: { size: number }) {
  return runAction(async () => {
    const ctx = await getAuthContext();
    if (input.size > 5 * 1024 * 1024)
      throw new AppError(
        "VALIDATION_FAILED",
        "The file must be 5 MB or smaller.",
      );
    const key = `tenants/${ctx.tenantId}/imports/${crypto.randomUUID()}.csv`;
    const upload = await services().storage.createUpload({
      key,
      contentType: "text/csv",
      maxBytes: 5 * 1024 * 1024,
    });
    return { key, ...upload };
  });
}

export async function startLeadImportAction(input: {
  key: string;
  filename: string;
  size: number;
  dryRun: boolean;
}) {
  return runAction(async () => {
    const ctx = await getAuthContext();
    const head = await services().storage.head(input.key);
    if (!head)
      throw new AppError(
        "VALIDATION_FAILED",
        "The upload didn't arrive. Try again.",
      );
    const job = await registerLeadImport(services().deps, ctx, {
      ...input,
      size: head.size,
    });
    await enqueue(getRedis(), "data", "leads.import", {
      tenantId: ctx.tenantId,
      actor: { type: "user", id: ctx.userId },
      idempotencyKey: `lead-import-${job.id}`,
      data: { dataJobId: job.id },
    });
    return { jobId: job.id };
  });
}

export async function confirmLeadImportAction(form: FormData) {
  return run(
    form,
    "/leads/import",
    async () => {
      const ctx = await getAuthContext();
      const job = await confirmLeadImport(
        services().deps,
        ctx,
        uuid(form.get("jobId")),
      );
      await enqueue(getRedis(), "data", "leads.import", {
        tenantId: ctx.tenantId,
        actor: { type: "user", id: ctx.userId },
        idempotencyKey: `lead-import-${job.id}`,
        data: { dataJobId: job.id },
      });
    },
    "Import started.",
  );
}
