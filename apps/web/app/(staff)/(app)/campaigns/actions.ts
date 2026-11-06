"use server";

import { saveCampaign } from "@gym/core/crm";
import {
  archiveSegment,
  cancelCampaign,
  configureCampaignSend,
  launchCampaign,
  saveSegment,
  testSendCampaign,
} from "@gym/core/growth";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { formAction, runAction } from "@/lib/action";
import { definitionFromParams } from "@/lib/segment-form";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

function formParams(form: FormData) {
  const p: Record<string, string | string[]> = {};
  for (const key of new Set(form.keys())) {
    const all = form.getAll(key).map(String);
    p[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return p;
}

const go = (path: string, params: Record<string, string>) =>
  redirect(`${path}?${new URLSearchParams(params)}`);

export async function createCampaignAction(form: FormData) {
  const raw = formDataToObject(form);
  const result = await runAction(async () =>
    saveCampaign(services().deps, await getAuthContext(), null, {
      channel: "WHATSAPP",
      ...raw,
    }),
  );
  if (result.ok)
    go(`/campaigns/${result.data.id}`, {
      notice: "Campaign created. Choose the audience and template.",
    });
  go("/campaigns", { error: result.ok ? "" : result.error.message });
}

export async function saveSegmentAction(form: FormData) {
  const p = formParams(form);
  const id =
    typeof p.segmentId === "string" && p.segmentId ? p.segmentId : null;
  const result = await runAction(async () =>
    saveSegment(services().deps, await getAuthContext(), id, {
      name: p.name,
      definition: definitionFromParams(p),
    }),
  );
  if (result.ok) go("/campaigns/audiences", { notice: "Audience saved." });
  const back = new URLSearchParams();
  for (const [k, v] of Object.entries(p))
    for (const x of Array.isArray(v) ? v : [v]) back.append(k, x);
  back.set("error", result.ok ? "" : result.error.message);
  redirect(`/campaigns/audiences/edit?${back}`);
}

export async function archiveSegmentAction(form: FormData) {
  const result = await runAction(async () =>
    archiveSegment(
      services().deps,
      await getAuthContext(),
      String(form.get("segmentId")),
    ),
  );
  go(
    "/campaigns/audiences",
    result.ok
      ? { notice: "Audience archived." }
      : { error: result.error.message },
  );
}

/** var_<placeholder> = a field key, or "text" with text_<placeholder> holding literal text. */
export async function configureAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  const variableMap: Record<string, { source: string } | { text: string }> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith("var_") || !v) continue;
    const ph = k.slice(4);
    variableMap[ph] =
      v === "text" ? { text: raw[`text_${ph}`] ?? "" } : { source: v };
  }
  return formAction(
    async () =>
      configureCampaignSend(
        services().deps,
        await getAuthContext(),
        raw.campaignId ?? "",
        {
          segmentId: raw.segmentId,
          templateId: raw.templateId,
          variableMap,
          throttlePerMinute: raw.throttlePerMinute,
          attributionDays: raw.attributionDays,
        },
      ),
    "Saved. Check the numbers below, then launch.",
  );
}

export async function launchAction(form: FormData) {
  const raw = formDataToObject(form) as Record<string, string>;
  const id = raw.campaignId ?? "";
  if (raw.confirm !== "on")
    go(`/campaigns/${id}`, {
      error: "Tick the box to confirm the recipients and message type.",
    });
  const result = await runAction(async () =>
    launchCampaign(services().deps, await getAuthContext(), id, {
      scheduledAt: raw.scheduledAt ?? "",
      confirmRecipients: raw.confirmRecipients,
    }),
  );
  go(
    `/campaigns/${id}`,
    result.ok
      ? {
          notice: raw.scheduledAt
            ? "Scheduled."
            : "Launched: messages go out within a minute, at the throttle you set.",
        }
      : { error: result.error.message },
  );
}

export async function cancelCampaignAction(form: FormData) {
  const id = String(form.get("campaignId"));
  const result = await runAction(async () =>
    cancelCampaign(services().deps, await getAuthContext(), id),
  );
  go(
    `/campaigns/${id}`,
    result.ok
      ? {
          notice: `Cancelled. ${result.data.pending + result.data.queued} message(s) won't be sent.`,
        }
      : { error: result.error.message },
  );
}

export async function testSendAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  return formAction(
    async () =>
      testSendCampaign(
        services().deps,
        await getAuthContext(),
        raw.campaignId ?? "",
        raw,
      ),
    "Test message queued to the staff number(s).",
  );
}
