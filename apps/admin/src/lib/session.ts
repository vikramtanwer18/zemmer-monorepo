import "server-only";
import {
  resolvePlatformSession,
  type PlatformSessionState,
} from "@gym/auth/platform";
import { AppError } from "@gym/core/errors";
import type { PlatformContext } from "@gym/core/platform";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { services } from "@/lib/services";

export const getPlatformState = cache(
  async (): Promise<PlatformSessionState> => {
    // Request APIs first: they mark the page dynamic before any connection is opened (builds).
    const h = new Headers(await headers());
    const { auth, db } = services();
    return resolvePlatformSession({ auth, db, headers: h });
  },
);

export type ReadyPlatformState = Extract<
  PlatformSessionState,
  { kind: "ready" }
>;

/** Pages: signed in and past the mandatory OTP, or redirected. */
export async function requireAdmin(next?: string): Promise<ReadyPlatformState> {
  const state = await getPlatformState();
  if (state.kind === "anonymous") {
    redirect(next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
  }
  if (state.kind === "mfa-required") redirect("/verify");
  return state;
}

/** Actions: the PlatformContext, re-checked on every call. */
export async function getPlatformContext(): Promise<PlatformContext> {
  const state = await getPlatformState();
  if (state.kind === "ready") return state.ctx;
  if (state.kind === "mfa-required")
    throw new AppError("MFA_REQUIRED", "Enter the code we emailed you first.");
  throw new AppError("AUTH_REQUIRED", "Please sign in again.");
}

export function safeNext(next: unknown, fallback = "/"): string {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\"))
    return fallback;
  return next;
}
