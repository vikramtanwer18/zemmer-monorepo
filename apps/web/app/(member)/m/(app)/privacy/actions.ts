"use server";

import { acceptPrivacyNotice, requestMyDeletion } from "@gym/core/members";
import { redirect } from "next/navigation";
import { runAction } from "@/lib/action";
import { getMemberContext } from "@/lib/member-session";
import { services } from "@/lib/services";

export async function acceptPrivacyAction(form: FormData) {
  const res = await runAction(async () =>
    acceptPrivacyNotice(services().deps, await getMemberContext()),
  );
  if (!res.ok)
    redirect(`/m/privacy?${new URLSearchParams({ error: res.error.message })}`);
  // Only go on to our own member pages.
  const next = String(form.get("next") ?? "");
  redirect(
    /^\/m\/[\w\-/]*$/.test(next) && !next.startsWith("/m/privacy")
      ? next
      : "/m/",
  );
}

export async function requestDeletionAction(form: FormData) {
  const res = await runAction(async () =>
    requestMyDeletion(services().deps, await getMemberContext(), {
      note: form.get("note") ?? "",
    }),
  );
  redirect(
    `/m/privacy?${new URLSearchParams(
      res.ok
        ? {
            notice:
              "Request sent. The gym will contact you before anything is deleted.",
          }
        : { error: res.error.message },
    )}`,
  );
}
