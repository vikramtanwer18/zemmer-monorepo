import type { PlatformContext } from "@gym/core/platform";
import type { PrismaClient } from "@gym/db";
import {
  otpEmail,
  resetPasswordEmail,
  type EmailSender,
} from "@gym/integrations/email";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { nextCookies } from "better-auth/next-js";
import { OtpService, type OtpStore } from "../otp";
import { platformPermissionsFor } from "../permissions";
import type { RateLimiter } from "../rate-limit";
import { clientIp, rateLimitHooks } from "../shared";

/** Different from the tenant realm's "gym" prefix, so neither cookie is ever read by the other app. */
export const PLATFORM_COOKIE_PREFIX = "gymadmin";

export type PlatformAuthOptions = {
  /** gym_platform connection. */
  db: PrismaClient;
  /** Not the tenant realm's secret (D-03). */
  secret: string;
  baseURL: string;
  brand: string;
  email: EmailSender;
  limiter: RateLimiter;
};

/**
 * Better Auth for the platform realm (apps/admin): own tables (platform.platform_*), own secret,
 * own cookie name. No self-signup; accounts come from the seed CLI. Email OTP is always required.
 */
export function createPlatformAuth(options: PlatformAuthOptions) {
  const { db, email, brand } = options;
  return betterAuth({
    appName: `${brand} Admin`,
    baseURL: options.baseURL,
    basePath: "/api/auth",
    secret: options.secret,
    database: prismaAdapter(db, { provider: "postgresql" }),
    telemetry: { enabled: false },
    rateLimit: { enabled: false },
    advanced: {
      cookiePrefix: PLATFORM_COOKIE_PREFIX,
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },
    user: { modelName: "platformUser" },
    session: {
      modelName: "platformSession",
      // Shorter than the tenant realm: operator sessions are higher risk.
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 60,
    },
    account: { modelName: "platformAccount" },
    verification: { modelName: "platformVerification" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => {
        await email.send({
          to: user.email,
          ...resetPasswordEmail({ brand: `${brand} Admin`, url }),
        });
      },
    },
    disabledPaths: [
      "/update-session",
      "/delete-user",
      "/change-email",
      "/update-user",
      "/sign-in/social",
      "/link-social",
    ],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await db.platformUser.findUnique({
              where: { id: session.userId },
              select: { status: true },
            });
            if (user?.status !== "ACTIVE") {
              throw new APIError("FORBIDDEN", {
                message: "This account is disabled.",
              });
            }
          },
        },
      },
    },
    hooks: rateLimitHooks(options.limiter),
    plugins: [nextCookies()],
  });
}

export type PlatformAuth = ReturnType<typeof createPlatformAuth>;

export function platformOtpStore(db: PrismaClient): OtpStore {
  return {
    latest: (sessionId) =>
      db.platformOtpChallenge.findFirst({
        where: { sessionId },
        orderBy: { createdAt: "desc" },
      }),
    create: async (row) => {
      await db.platformOtpChallenge.create({ data: row });
    },
    recordFailedAttempt: async (id) => {
      await db.platformOtpChallenge.update({
        where: { id },
        data: { attempts: { increment: 1 } },
      });
    },
    consume: async (id, now) => {
      const { count } = await db.platformOtpChallenge.updateMany({
        where: { id, consumedAt: null },
        data: { consumedAt: now },
      });
      return count === 1;
    },
    markSessionVerified: async (sessionId, now) => {
      await db.platformSession.update({
        where: { id: sessionId },
        data: { mfaVerifiedAt: now },
      });
    },
  };
}

export function createPlatformOtp(options: {
  db: PrismaClient;
  secret: string;
  brand: string;
  email: EmailSender;
  limiter: RateLimiter;
}) {
  return new OtpService({
    store: platformOtpStore(options.db),
    secret: options.secret,
    limiter: options.limiter,
    sendCode: (to, code, minutes) =>
      options.email.send({
        to,
        ...otpEmail({ brand: `${options.brand} Admin`, code, minutes }),
      }),
  });
}

export type PlatformSessionState =
  | { kind: "anonymous" }
  | {
      kind: "mfa-required";
      user: { id: string; name: string; email: string };
      sessionId: string;
    }
  | {
      kind: "ready";
      user: {
        id: string;
        name: string;
        email: string;
        role: "SUPER_ADMIN" | "SUPPORT";
      };
      sessionId: string;
      ctx: PlatformContext;
    };

export async function resolvePlatformSession(input: {
  auth: PlatformAuth;
  db: PrismaClient;
  headers: Headers;
}): Promise<PlatformSessionState> {
  const result = await input.auth.api.getSession({ headers: input.headers });
  if (!result) return { kind: "anonymous" };
  const [user, session] = await Promise.all([
    input.db.platformUser.findUnique({ where: { id: result.user.id } }),
    input.db.platformSession.findUnique({ where: { id: result.session.id } }),
  ]);
  if (!user || !session || user.status !== "ACTIVE")
    return { kind: "anonymous" };
  const base = { id: user.id, name: user.name, email: user.email };
  if (!session.mfaVerifiedAt) {
    return { kind: "mfa-required", user: base, sessionId: session.id };
  }
  return {
    kind: "ready",
    user: { ...base, role: user.role },
    sessionId: session.id,
    ctx: {
      platformUserId: user.id,
      role: user.role,
      permissions: platformPermissionsFor(user.role),
      request: {
        ip: clientIp(input.headers),
        userAgent: input.headers.get("user-agent"),
      },
    },
  };
}

/**
 * Creates (or resets the password of) a platform user. Used by the seed CLI only; there is no
 * self-signup in the platform realm.
 */
export async function upsertPlatformUser(
  db: PrismaClient,
  input: {
    email: string;
    name: string;
    password: string;
    role: "SUPER_ADMIN" | "SUPPORT";
  },
): Promise<{ id: string; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  return db.$transaction(async (tx) => {
    const existing = await tx.platformUser.findUnique({ where: { email } });
    const user =
      existing ??
      (await tx.platformUser.create({
        data: {
          email,
          name: input.name,
          role: input.role,
          emailVerified: true,
        },
      }));
    if (existing) {
      await tx.platformUser.update({
        where: { id: existing.id },
        data: { name: input.name, role: input.role, status: "ACTIVE" },
      });
    }
    const account = await tx.platformAccount.findFirst({
      where: { userId: user.id, providerId: "credential" },
    });
    if (account) {
      await tx.platformAccount.update({
        where: { id: account.id },
        data: { password: passwordHash },
      });
    } else {
      await tx.platformAccount.create({
        data: {
          userId: user.id,
          accountId: user.id,
          providerId: "credential",
          password: passwordHash,
        },
      });
    }
    return { id: user.id, created: !existing };
  });
}
