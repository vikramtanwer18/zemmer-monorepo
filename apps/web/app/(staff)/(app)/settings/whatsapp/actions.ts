"use server";

import {
  addSuppression,
  connectWhatsAppAccount,
  disconnectWhatsAppAccount,
  liftSuppression,
  saveMessagingSettings,
  saveNotificationTemplate,
  syncTemplatesNow,
  verifyWhatsAppAccount,
} from "@gym/core/messaging";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

const back = (params: Record<string, string>, path = "/settings/whatsapp") =>
  redirect(`${path}?${new URLSearchParams(params)}`);

export async function connectAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      connectWhatsAppAccount(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
        { allowFake: services().fakeWhatsApp },
      ),
    "Connected. Templates are synced; point the Meta app's webhook at the URL below if you haven't.",
  );
}

export async function verifyAction() {
  const result = await runAction(async () =>
    verifyWhatsAppAccount(services().deps, await getAuthContext()),
  );
  const ok = result.ok && result.data.ok;
  back(
    ok
      ? { notice: "WhatsApp accepted the connection." }
      : {
          error: result.ok
            ? result.data.ok
              ? ""
              : result.data.reason
            : result.error.message,
        },
  );
}

export async function syncAction() {
  const result = await runAction(async () =>
    syncTemplatesNow(services().deps, await getAuthContext()),
  );
  back(
    result.ok
      ? { notice: `Templates synced (${result.data.synced}).` }
      : { error: result.error.message },
  );
}

export async function disconnectAction(form: FormData) {
  const result = await runAction(async () =>
    disconnectWhatsAppAccount(
      services().deps,
      await getAuthContext(),
      formDataToObject(form),
    ),
  );
  back(
    result.ok
      ? { notice: "Disconnected. Nothing more is sent on WhatsApp." }
      : { error: result.error.message },
  );
}

export async function messagingSettingsAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      saveMessagingSettings(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Saved.",
  );
}

export async function mapNotificationAction(form: FormData) {
  const raw = formDataToObject(form) as Record<string, string>;
  const variables: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw))
    if (k.startsWith("var_") && v) variables[k.slice(4)] = v;
  const result = await runAction(async () =>
    saveNotificationTemplate(services().deps, await getAuthContext(), {
      key: raw.key,
      templateId: raw.templateId ?? "",
      variables,
    }),
  );
  back(
    result.ok
      ? {
          notice: raw.templateId
            ? "WhatsApp template set for this message."
            : "This message no longer goes on WhatsApp.",
        }
      : { error: result.error.message, map: raw.key ?? "" },
  );
}

export async function addSuppressionAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      addSuppression(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Opted out. Nothing more goes to that number on WhatsApp.",
  );
}

export async function liftSuppressionAction(form: FormData) {
  const result = await runAction(async () =>
    liftSuppression(
      services().deps,
      await getAuthContext(),
      formDataToObject(form),
    ),
  );
  back(
    result.ok
      ? { notice: "Opt-out lifted with the consent you recorded." }
      : { error: result.error.message },
  );
}
