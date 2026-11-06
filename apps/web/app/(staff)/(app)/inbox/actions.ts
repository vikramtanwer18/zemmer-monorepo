"use server";

import {
  assignConversation,
  replyToConversation,
  sendTemplateToContact,
} from "@gym/core/messaging";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

export async function replyAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  return formAction(
    async () =>
      replyToConversation(
        services().deps,
        await getAuthContext(),
        raw.conversationId ?? "",
        raw,
      ),
    "Sent.",
  );
}

export async function assignToMeAction(form: FormData) {
  const ctx = await getAuthContext();
  const id = String(form.get("conversationId") ?? "");
  const result = await runAction(async () =>
    assignConversation(services().deps, ctx, id, {
      userId: form.get("unassign") ? null : ctx.userId,
    }),
  );
  redirect(
    `/inbox/${id}?${new URLSearchParams(result.ok ? { notice: "Updated." } : { error: result.error.message })}`,
  );
}

/** Template to one person; placeholders map to fields (var_<placeholder> = source key). */
export async function sendTemplateAction(form: FormData) {
  const raw = formDataToObject(form) as Record<string, string>;
  const variables: Record<string, { source: string }> = {};
  for (const [k, v] of Object.entries(raw))
    if (k.startsWith("var_") && v) variables[k.slice(4)] = { source: v };
  const result = await runAction(async () =>
    sendTemplateToContact(
      services().deps,
      await getAuthContext(),
      {
        templateId: raw.templateId,
        memberId: raw.memberId || undefined,
        leadId: raw.leadId || undefined,
        phone: raw.phone || undefined,
        variables,
      },
      { flagId: raw.flagId || undefined },
    ),
  );
  // Only our own pages (no open redirect).
  const back =
    raw.back?.startsWith("/") && !raw.back.startsWith("//")
      ? raw.back
      : "/inbox";
  redirect(
    `${back}${back.includes("?") ? "&" : "?"}${new URLSearchParams(result.ok ? { notice: "Queued. Consent and opt-outs are checked when it's sent." } : { error: result.error.message })}`,
  );
}
