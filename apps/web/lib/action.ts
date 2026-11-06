import "server-only";
import { toActionError, type ActionResult } from "@gym/core/errors";
import { createLogger } from "@gym/core/logger";
import { isAPIError } from "better-auth/api";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { getEnv } from "@/env";

let log: ReturnType<typeof createLogger> | undefined;
function logger() {
  log ??= createLogger({ name: "web", level: getEnv().LOG_LEVEL });
  return log;
}

/** Friendly text for Better Auth error codes. */
const AUTH_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password don't match.",
  EMAIL_NOT_VERIFIED:
    "Please verify your email first. We've sent you a new link.",
  USER_ALREADY_EXISTS:
    "An account with this email already exists. Sign in instead.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    "An account with this email already exists. Sign in instead.",
  PASSWORD_TOO_SHORT: "Use at least 10 characters.",
  PASSWORD_TOO_LONG: "Use at most 128 characters.",
  INVALID_TOKEN: "This link is invalid or has expired. Ask for a new one.",
};

/**
 * Wraps a server action body: maps AppError and Better Auth errors to `{ ok: false, error }`
 * and logs anything unexpected. Next.js redirects pass through.
 */
export async function runAction<T>(
  fn: () => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    // Lets redirect() and notFound() through.
    unstable_rethrow(err);
    if (isAPIError(err)) {
      const code = (err.body as { code?: string } | undefined)?.code ?? "";
      const message =
        AUTH_MESSAGES[code] ??
        (err.body as { message?: string } | undefined)?.message ??
        "Something went wrong.";
      const status = String(err.status);
      return {
        ok: false,
        error: {
          code:
            status === "TOO_MANY_REQUESTS"
              ? "RATE_LIMITED"
              : status === "FORBIDDEN"
                ? "FORBIDDEN"
                : status === "UNAUTHORIZED"
                  ? "AUTH_REQUIRED"
                  : "VALIDATION_FAILED",
          message,
        },
      };
    }
    const result = toActionError(err);
    if (result.error.code === "INTERNAL") {
      logger().error({ err }, "server action failed");
    }
    return result;
  }
}

/**
 * Same as runAction, for forms: adds a success message and, on success, refreshes every page's
 * data (pages are rendered per request, so this only means "re-render with fresh data").
 */
export async function formAction(
  fn: () => Promise<unknown>,
  successMessage?: string,
): Promise<
  { ok: true; message?: string } | Extract<ActionResult<never>, { ok: false }>
> {
  const result = await runAction(fn);
  if (!result.ok) return result;
  revalidatePath("/", "layout");
  return { ok: true, message: successMessage };
}
