"use server";

import { AppError } from "@gym/core/errors";
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
import { services } from "@/lib/services";
import { getPlatformState, safeNext } from "@/lib/session";

async function requestHeaders() {
  return new Headers(await headers());
}

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
      body: { email: input.email, password: input.password },
      headers: await requestHeaders(),
    });
    return safeNext(input.next);
  });
  if (!result.ok) return result;
  // Every platform session must pass the email OTP before anything else.
  redirect(`/verify?next=${encodeURIComponent(result.data)}`);
}

export async function signOutAction() {
  await services().auth.api.signOut({ headers: await requestHeaders() });
  redirect("/sign-in");
}

async function mfaState() {
  const state = await getPlatformState();
  if (state.kind !== "mfa-required")
    throw new AppError("CONFLICT", "No code is needed right now.");
  return state;
}

export async function sendOtpAction(): Promise<FormActionResult> {
  return formAction(async () => {
    const state = await mfaState();
    const h = await requestHeaders();
    await services().otp.send({
      sessionId: state.sessionId,
      userId: state.user.id,
      email: state.user.email,
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
  }, "We've emailed you a 6-digit code. It expires in 10 minutes.");
}

export async function verifyOtpAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () => {
    const state = await mfaState();
    const h = await requestHeaders();
    await services().otp.verify({
      sessionId: state.sessionId,
      userId: state.user.id,
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      code: String(form.get("code") ?? ""),
    });
    return safeNext(form.get("next"));
  });
  if (!result.ok) return result;
  redirect(result.data);
}

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
  }, "If an account exists for that email, we've sent a reset link.");
}

const resetSchema = z
  .object({
    token: z.string().min(10),
    password: z.string().min(12, "Use at least 12 characters.").max(128),
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
