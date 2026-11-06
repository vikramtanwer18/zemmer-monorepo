"use server";

import { AppError } from "@gym/core/errors";
import {
  listMyMemberGyms,
  requestToJoin,
  setMyMarketingConsent,
  updateMyProfile,
} from "@gym/core/members";
import {
  emailSchema,
  formDataToObject,
  parseInput,
} from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { getMemberContext, getSignedInUser } from "@/lib/member-session";
import { services } from "@/lib/services";
import { safeNext } from "@/lib/session";

/** Member app paths only, so a crafted `next` can't bounce members into the staff app. */
function memberNext(next: unknown) {
  const path = safeNext(next, "/m/");
  return path.startsWith("/m/") || path.startsWith("/join/") ? path : "/m/";
}

const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
  next: z.string().optional(),
});

export async function memberSignInAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const input = parseInput(signInSchema, formDataToObject(form));
    await services().auth.api.signInEmail({
      body: { email: input.email, password: input.password, rememberMe: true },
      headers: new Headers(await headers()),
    });
    return memberNext(input.next);
  });
  if (!result.ok) return result;
  redirect(result.data);
}

export async function memberSignOutAction() {
  await services().auth.api.signOut({ headers: new Headers(await headers()) });
  redirect("/m/sign-in");
}

/** Switches the gym shown in the member app, after checking an active member profile there. */
export async function selectGymAction(form: FormData) {
  const tenantId = z.uuid().safeParse(form.get("tenantId"));
  const signedIn = await getSignedInUser();
  if (!signedIn) redirect("/m/sign-in");
  if (tenantId.success) {
    const gyms = await listMyMemberGyms(services().db, signedIn.user.id);
    if (gyms.some((g) => g.tenantId === tenantId.data)) {
      await services().db.session.update({
        where: { id: signedIn.sessionId },
        data: { activeTenantId: tenantId.data, activeBranchId: null },
      });
    }
  }
  redirect("/m/");
}

export async function updateMyProfileAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const mctx = await getMemberContext();
    await updateMyProfile(services().db, mctx, formDataToObject(form));
  }, "Saved.");
}

export async function setMarketingConsentAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const mctx = await getMemberContext();
    const db = services().db;
    const raw = formDataToObject(form);
    // Both channels are sent with the form, so an unticked box is a recorded opt-out.
    for (const channel of ["EMAIL", "WHATSAPP"] as const) {
      const key = channel === "EMAIL" ? "marketingEmail" : "marketingWhatsapp";
      const was = form.get(`${key}Was`) === "on";
      const now = raw[key] === "on";
      if (was !== now)
        await setMyMarketingConsent(db, mctx, {
          channel,
          granted: now ? "on" : undefined,
        });
    }
  }, "Your preferences are saved.");
}

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: z
      .string()
      .min(10, "Use at least 10 characters.")
      .max(128, "Use at most 128 characters."),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, {
    path: ["confirm"],
    message: "The passwords don't match.",
  });

export async function changePasswordAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    await getMemberContext();
    const input = parseInput(passwordSchema, formDataToObject(form));
    await services().auth.api.changePassword({
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: true,
      },
      headers: new Headers(await headers()),
    });
  }, "Password changed. Other devices have been signed out.");
}

export async function joinGymAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const slug = parseInput(z.string().min(1).max(60), form.get("slug"));
    const signedIn = await getSignedInUser();
    if (!signedIn) throw new AppError("AUTH_REQUIRED", "Sign in first.");
    const { limiter, deps } = services();
    await limiter.consume("join:account", signedIn.user.id);
    const joined = await requestToJoin(
      deps,
      signedIn.user,
      slug,
      formDataToObject(form),
    );
    if (joined.status === "ACTIVE") {
      await services().db.session.update({
        where: { id: signedIn.sessionId },
        data: { activeTenantId: joined.tenantId, activeBranchId: null },
      });
    }
    return joined.status;
  });
  if (!result.ok) return result;
  redirect(result.data === "ACTIVE" ? "/m/" : "/m/no-gym?requested=1");
}
