import "server-only";
import {
  resolveTenantSession,
  TRUSTED_DEVICE_COOKIE,
  type TenantSessionState,
} from "@gym/auth/tenant";
import type { AuthContext } from "@gym/core/authz";
import { AppError } from "@gym/core/errors";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { services } from "@/lib/services";

/** Resolved once per request (React cache), from the verified session only. */
export const getSessionState = cache(async (): Promise<TenantSessionState> => {
  // Request APIs first: they mark the page dynamic before any connection is opened (builds).
  const [h, c] = await Promise.all([headers(), cookies()]);
  const { auth, db } = services();
  return resolveTenantSession({
    auth,
    db,
    headers: new Headers(h),
    trustedDeviceToken: c.get(TRUSTED_DEVICE_COOKIE)?.value ?? null,
  });
});

export type ReadyState = Extract<TenantSessionState, { kind: "ready" }>;

/** For pages: sends the user wherever they need to go next, or returns the ready state. */
export async function requireReady(next?: string): Promise<ReadyState> {
  const state = await getSessionState();
  if (state.kind === "anonymous") {
    redirect(next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
  }
  if (state.kind === "deactivated") redirect("/sign-in?deactivated=1");
  if (state.kind === "no-tenant") {
    redirect(state.tenants.length > 0 ? "/select-tenant" : "/onboarding");
  }
  if (state.kind === "pending-approval") redirect("/pending-approval");
  if (state.kind === "mfa-required") redirect("/verify");
  // Members (no staff role in this gym) use the member app instead.
  if (state.access.roles.every((r) => r.roleKey === "MEMBER")) redirect("/m/");
  return state;
}

/**
 * For server actions and route handlers: the AuthContext, or an AppError. Re-checked on every
 * call; the page that rendered the form proves nothing.
 */
export async function getAuthContext(): Promise<AuthContext> {
  const state = await getSessionState();
  switch (state.kind) {
    case "ready":
      return state.ctx;
    case "mfa-required":
      throw new AppError(
        "MFA_REQUIRED",
        "Enter the code we emailed you first.",
      );
    case "pending-approval":
      throw new AppError(
        "SUBSCRIPTION_INACTIVE",
        "Your gym is waiting for approval.",
      );
    case "no-tenant":
      throw new AppError("FORBIDDEN", "Pick a gym first.");
    default:
      throw new AppError("AUTH_REQUIRED", "Please sign in again.");
  }
}

/** Only allows same-site relative paths (no open redirects). */
export function safeNext(next: unknown, fallback = "/"): string {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\"))
    return fallback;
  return next;
}
