"use server";

import {
  createTrustedDevice,
  selectTenant,
  TRUSTED_DEVICE_COOKIE,
  TRUSTED_DEVICE_DAYS,
} from "@gym/auth/tenant";
import { AppError } from "@gym/core/errors";
import { acceptInvitation, createTenantForOwner } from "@gym/core/tenancy";
import {
  checkboxSchema,
  emailSchema,
  formDataToObject,
  parseInput,
} from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getSessionState, safeNext } from "@/lib/session";

async function requestHeaders() {
  return new Headers(await headers());
}

function requestMeta(h: Headers) {
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
  };
}

const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(128, "Use at most 128 characters.");

// --- sign in / out -------------------------------------------------------------------

const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
  next: z.string().optional(),
});

export async function signInAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const input = parseInput(signInSchema, formDataToObject(form));
    await services().auth.api.signInEmail({
      body: { email: input.email, password: input.password, rememberMe: true },
      headers: await requestHeaders(),
    });
    return safeNext(input.next);
  });
  if (!result.ok) return result;
  redirect(result.data);
}

export async function signInWithGoogleAction(form: FormData) {
  const next = safeNext(form.get("next"));
  const result = await services().auth.api.signInSocial({
    body: {
      provider: "google",
      callbackURL: next,
      errorCallbackURL: "/sign-in?error=google",
    },
    headers: await requestHeaders(),
  });
  if (!result.url) redirect("/sign-in?error=google");
  redirect(result.url);
}

export async function signOutAction() {
  await services().auth.api.signOut({ headers: await requestHeaders() });
  redirect("/sign-in");
}

// --- sign up / verify email -----------------------------------------------------------

const signUpSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(80),
  email: emailSchema,
  password: passwordSchema,
  next: z.string().optional(),
});

export async function signUpAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const input = parseInput(signUpSchema, formDataToObject(form));
    await services().auth.api.signUpEmail({
      body: {
        name: input.name,
        email: input.email,
        password: input.password,
        // Where the verification link lands (signed in automatically).
        callbackURL: safeNext(input.next, "/onboarding"),
      },
      headers: await requestHeaders(),
    });
    return input.email;
  });
  if (!result.ok) return result;
  redirect(`/check-email?email=${encodeURIComponent(result.data)}`);
}

export async function resendVerificationAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const email = parseInput(emailSchema, form.get("email"));
    await services().auth.api.sendVerificationEmail({
      body: { email, callbackURL: safeNext(form.get("next"), "/onboarding") },
      headers: await requestHeaders(),
    });
  }, "If that account still needs verifying, a new link is on its way.");
}

// --- password reset ------------------------------------------------------------------

export async function forgotPasswordAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const email = parseInput(emailSchema, form.get("email"));
    await services().auth.api.requestPasswordReset({
      body: { email, redirectTo: "/reset-password" },
      headers: await requestHeaders(),
    });
  }, "If an account exists for that email, we've sent a reset link. It expires in 1 hour.");
}

const resetSchema = z
  .object({
    token: z.string().min(10),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    message: "The passwords don't match.",
  });

export async function resetPasswordAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const input = parseInput(resetSchema, formDataToObject(form));
    await services().auth.api.resetPassword({
      body: { token: input.token, newPassword: input.password },
      headers: await requestHeaders(),
    });
  });
  if (!result.ok) return result;
  redirect("/sign-in?reset=1");
}

// --- second factor -------------------------------------------------------------------

async function mfaState() {
  const state = await getSessionState();
  if (state.kind !== "mfa-required") {
    throw new AppError("CONFLICT", "No code is needed right now.");
  }
  return state;
}

export async function sendOtpAction(): Promise<FormActionResult> {
  return formAction(async () => {
    const state = await mfaState();
    const h = await requestHeaders();
    await services().otp.send({
      sessionId: state.session.id,
      userId: state.user.id,
      email: state.user.email,
      ip: requestMeta(h).ip,
    });
  }, "We've emailed you a 6-digit code. It expires in 10 minutes.");
}

const verifySchema = z.object({ code: z.string(), trust: checkboxSchema });

export async function verifyOtpAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const state = await mfaState();
    const input = parseInput(verifySchema, formDataToObject(form));
    const h = await requestHeaders();
    const { otp, db } = services();
    await otp.verify({
      sessionId: state.session.id,
      userId: state.user.id,
      ip: requestMeta(h).ip,
      code: input.code,
    });
    // Remember-device is only offered (and only honoured) below administrator level (D-03).
    if (input.trust && state.trustedDeviceAllowed) {
      const device = await createTrustedDevice(
        db,
        state.user.id,
        h.get("user-agent"),
      );
      (await cookies()).set(TRUSTED_DEVICE_COOKIE, device.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: TRUSTED_DEVICE_DAYS * 24 * 60 * 60,
      });
    }
  });
  if (!result.ok) return result;
  redirect("/");
}

// --- tenant selection and onboarding -------------------------------------------------

export async function selectTenantAction(form: FormData) {
  const tenantId = z.uuid().safeParse(form.get("tenantId"));
  const state = await getSessionState();
  if (state.kind === "anonymous" || state.kind === "deactivated")
    redirect("/sign-in");
  if (tenantId.success) {
    await selectTenant(
      services().db,
      state.user.id,
      state.session.id,
      tenantId.data,
    );
  }
  redirect("/");
}

export async function onboardingAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const state = await getSessionState();
    if (state.kind === "anonymous" || state.kind === "deactivated") {
      throw new AppError("AUTH_REQUIRED", "Please sign in again.");
    }
    const h = await requestHeaders();
    const { deps, db } = services();
    const created = await createTenantForOwner(
      deps,
      { userId: state.user.id, request: requestMeta(h) },
      formDataToObject(form),
    );
    await selectTenant(db, state.user.id, state.session.id, created.tenantId);
    return created;
  });
  if (!result.ok) return result;
  redirect(
    result.data.status === "PENDING_APPROVAL" ? "/pending-approval" : "/",
  );
}

// --- invitations ---------------------------------------------------------------------

export async function acceptInvitationAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const token = parseInput(z.string().min(20).max(100), form.get("token"));
    const state = await getSessionState();
    if (state.kind === "anonymous" || state.kind === "deactivated") {
      throw new AppError("AUTH_REQUIRED", "Sign in to accept this invitation.");
    }
    const h = await requestHeaders();
    const meta = requestMeta(h);
    const { limiter, deps, db } = services();
    if (meta.ip) await limiter.consume("invite-accept:ip", meta.ip);
    await limiter.consume("invite-accept:account", state.user.id);
    const { tenantId } = await acceptInvitation(deps, state.user, token, meta);
    await selectTenant(db, state.user.id, state.session.id, tenantId);
  });
  if (!result.ok) return result;
  redirect("/");
}
