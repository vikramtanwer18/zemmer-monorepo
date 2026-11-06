"use server";

import {
  createTaskForFlag,
  dismissFlag,
  saveRetentionRules,
} from "@gym/core/retention";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

const go = (params: Record<string, string>) =>
  redirect(`/retention?${new URLSearchParams(params)}`);

export async function taskForFlagAction(form: FormData) {
  const result = await runAction(async () =>
    createTaskForFlag(
      services().deps,
      await getAuthContext(),
      String(form.get("flagId")),
      {},
    ),
  );
  go(
    result.ok
      ? { notice: "Task created for you, due tomorrow." }
      : { error: result.error.message },
  );
}

export async function dismissFlagAction(form: FormData) {
  const result = await runAction(async () =>
    dismissFlag(
      services().deps,
      await getAuthContext(),
      String(form.get("flagId")),
      formDataToObject(form),
    ),
  );
  go(result.ok ? { notice: "Dismissed." } : { error: result.error.message });
}

export async function saveRulesAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  const input: Record<string, { enabled: string; threshold: string }> = {};
  for (const [k, v] of Object.entries(raw)) {
    const [kind, field] = k.split(".");
    if (!kind || !field) continue;
    input[kind] ??= { enabled: "false", threshold: "" };
    input[kind][field as "enabled" | "threshold"] = v;
  }
  return formAction(
    async () =>
      saveRetentionRules(services().deps, await getAuthContext(), input),
    "Saved. Flags update tonight.",
  );
}
