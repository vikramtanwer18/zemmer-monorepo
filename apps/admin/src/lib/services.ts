import "server-only";
import type { OtpService } from "@gym/auth/otp";
import {
  createPlatformAuth,
  createPlatformOtp,
  type PlatformAuth,
} from "@gym/auth/platform";
import { RateLimiter } from "@gym/auth/rate-limit";
import { createSecretBox } from "@gym/core/crypto";
import { redisEntitlementCache } from "@gym/core/entitlements";
import type { BillingDeps } from "@gym/core/saas-billing";
import { subscriptionProviderFactory } from "@gym/integrations/payments";
import { createRedisConnection } from "@gym/core/jobs";
import type { OwnerInviteMailer, PlatformDeps } from "@gym/core/platform";
import type { PrismaClient } from "@gym/db";
import { createEmailSender, ownerInviteEmail } from "@gym/integrations/email";
import type { Redis } from "ioredis";
import { getEnv } from "@/env";
import { getDb } from "@/lib/db";

export type AdminServices = {
  db: PrismaClient;
  redis: Redis;
  deps: PlatformDeps;
  /** SaaS billing: the platform payment account lives only here and in the worker. */
  billing: BillingDeps;
  fakePayments: boolean;
  /** Shared with apps/web for signed owner billing requests. */
  internalSecret: string;
  appUrl: string;
  auth: PlatformAuth;
  otp: OtpService;
  brand: string;
  ownerInviteMailer: OwnerInviteMailer;
};

const globalForServices = globalThis as typeof globalThis & {
  __gymAdminServices?: AdminServices;
  __gymAdminRedis?: Redis;
};

/** Built on first use (never at import), so `next build` needs no secrets. */
export function services(): AdminServices {
  if (globalForServices.__gymAdminServices)
    return globalForServices.__gymAdminServices;
  const env = getEnv();
  const db = getDb();
  globalForServices.__gymAdminRedis ??= createRedisConnection(env.REDIS_URL);
  const redis = globalForServices.__gymAdminRedis;
  const email = createEmailSender(
    env.EMAIL_PROVIDER === "ses"
      ? {
          provider: "ses",
          from: env.EMAIL_FROM,
          region: env.SES_REGION ?? "ap-south-1",
        }
      : env.EMAIL_PROVIDER === "memory"
        ? { provider: "memory", from: env.EMAIL_FROM }
        : {
            provider: "smtp",
            from: env.EMAIL_FROM,
            host: env.SMTP_HOST ?? "localhost",
            port: env.SMTP_PORT ?? 1025,
          },
  );
  // A separate key prefix from the tenant realm: limits never interfere across realms.
  const limiter = new RateLimiter(redis, "gym:rl:platform");
  const brand = env.APP_NAME;
  const appUrl = env.APP_URL.replace(/\/$/, "");

  const entitlements = redisEntitlementCache(redis);
  const adminUrl = env.ADMIN_URL.replace(/\/$/, "");
  const built: AdminServices = {
    db,
    redis,
    deps: { db, entitlements },
    billing: {
      db,
      entitlements,
      secrets: createSecretBox({
        key: env.DATA_ENCRYPTION_KEY,
        previousKey: env.DATA_ENCRYPTION_KEY_PREVIOUS,
      }),
      appUrl,
      allowFake: env.PAYMENTS_FAKE_ENABLED,
      subscriptions: subscriptionProviderFactory({
        fakeEnabled: env.PAYMENTS_FAKE_ENABLED,
        redis,
        fakeCheckoutBase: `${adminUrl}/dev/fake-subscribe`,
      }),
    },
    fakePayments: env.PAYMENTS_FAKE_ENABLED,
    internalSecret: env.PLATFORM_INTERNAL_SECRET,
    appUrl,
    auth: createPlatformAuth({
      db,
      secret: env.ADMIN_AUTH_SECRET,
      baseURL: env.ADMIN_URL.replace(/\/$/, ""),
      brand,
      email,
      limiter,
    }),
    otp: createPlatformOtp({
      db,
      secret: env.ADMIN_AUTH_SECRET,
      brand,
      email,
      limiter,
    }),
    brand,
    // Owner invitations link to the tenant app, where the owner signs up / in.
    ownerInviteMailer: async (message) => {
      await email.send({
        to: message.to,
        ...ownerInviteEmail({
          brand,
          tenantName: message.tenantName,
          url: `${appUrl}/invite/${message.token}`,
          expiresAt: message.expiresAt,
        }),
      });
    },
  };
  globalForServices.__gymAdminServices = built;
  return built;
}
