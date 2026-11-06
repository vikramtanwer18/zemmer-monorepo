import { isAppError } from "@gym/core/errors";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { RateLimiter, RateLimitName } from "./rate-limit";

/** First X-Forwarded-For hop (set by our reverse proxy), else X-Real-IP. */
export function clientIp(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || null;
  return headers.get("x-real-ip");
}

function tooMany(retryAfterSeconds: number): APIError {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return new APIError("TOO_MANY_REQUESTS", {
    message: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
  });
}

async function enforce(
  limiter: RateLimiter,
  name: RateLimitName,
  subject: string | null,
) {
  if (!subject) return;
  const result = await limiter.hit(name, subject);
  if (!result.allowed) throw tooMany(result.retryAfterSeconds);
}

function bodyEmail(body: unknown): string | null {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" ? email.trim().toLowerCase() : null;
}

/**
 * Redis rate limits on Better Auth endpoints (D-03), per IP and per account, plus a lockout after
 * repeated failed passwords. Better Auth's own in-memory limiter is turned off in favour of this.
 */
export function rateLimitHooks(limiter: RateLimiter) {
  return {
    before: createAuthMiddleware(async (ctx) => {
      const ip = clientIp(ctx.request?.headers ?? ctx.headers);
      const email = bodyEmail(ctx.body);
      switch (ctx.path) {
        case "/sign-in/email": {
          await enforce(limiter, "signin:ip", ip);
          if (email) {
            const blocked = await limiter.isBlocked(
              "signin-fail:account",
              email,
            );
            if (!blocked.allowed) throw tooMany(blocked.retryAfterSeconds);
          }
          break;
        }
        case "/sign-in/social":
          await enforce(limiter, "signin:ip", ip);
          break;
        case "/sign-up/email":
          await enforce(limiter, "signup:ip", ip);
          break;
        case "/request-password-reset":
          await enforce(limiter, "reset:ip", ip);
          await enforce(limiter, "reset:account", email);
          break;
        case "/send-verification-email":
          await enforce(limiter, "verify-email:account", email);
          break;
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;
      const email = bodyEmail(ctx.body);
      if (!email) return;
      const returned = ctx.context.returned;
      if (returned instanceof APIError && returned.status === "UNAUTHORIZED") {
        await limiter.hit("signin-fail:account", email);
      } else if (!(returned instanceof APIError)) {
        await limiter.reset("signin-fail:account", email);
      }
    }),
  };
}

/** AppError → Better Auth APIError (for hooks that call core). */
export function toApiError(err: unknown): unknown {
  if (isAppError(err) && err.code === "FORBIDDEN") {
    return new APIError("FORBIDDEN", { message: err.message });
  }
  return err;
}
