"use server";

import { connectViaEmbeddedSignup } from "@gym/core/messaging";
import { revalidatePath } from "next/cache";
import { runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

export async function embeddedSignupAction(input: {
  code: string;
  wabaId: string;
  phoneNumberId: string;
}) {
  const result = await runAction(async () => {
    const { deps, meta } = services();
    return connectViaEmbeddedSignup(deps, await getAuthContext(), input, meta);
  });
  if (result.ok) revalidatePath("/settings/whatsapp");
  return result.ok
    ? { ok: true as const }
    : { ok: false as const, error: result.error };
}
