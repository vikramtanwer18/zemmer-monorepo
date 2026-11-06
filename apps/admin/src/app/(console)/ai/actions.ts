"use server";

import { saveAiProvider, testAiProvider } from "@gym/core/copilot";
import { formDataToObject } from "@gym/core/validation";
import { createOpenAiClient } from "@gym/integrations/ai";
import type { FormActionResult } from "@gym/ui";
import { formAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getPlatformContext } from "@/lib/session";

function aiDeps() {
  const s = services();
  return { ...s.deps, secrets: s.billing.secrets };
}

export async function saveAiProviderAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    await saveAiProvider(
      aiDeps(),
      await getPlatformContext(),
      formDataToObject(form),
    );
  }, "AI provider saved.");
}

/** Calls the provider (a tiny completion + a tool-calling probe) and records what it supports. */
export async function testAiProviderAction(
  _: FormActionResult | null,
  _form: FormData,
): Promise<FormActionResult> {
  void _form;
  let test: { ok: boolean; message: string } = { ok: false, message: "" };
  const result = await formAction(async () => {
    test = await testAiProvider(
      aiDeps(),
      await getPlatformContext(),
      createOpenAiClient,
    );
  });
  if (!result.ok) return result;
  return test.ok
    ? { ok: true, message: test.message }
    : { ok: false, error: { code: "PROVIDER_ERROR", message: test.message } };
}
