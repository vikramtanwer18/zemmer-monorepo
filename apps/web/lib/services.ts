import "server-only";
import { RateLimiter } from "@gym/auth/rate-limit";
import {
  createTenantAuth,
  createTenantOtp,
  type TenantAuth,
} from "@gym/auth/tenant";
import { createSecretBox } from "@gym/core/crypto";
import { redisEntitlementCache } from "@gym/core/entitlements";
import type { MemberInviteMailer } from "@gym/core/members";
import {
  redisClaims,
  type CoreDeps,
  type InvitationMailer,
} from "@gym/core/tenancy";
import type { OtpService } from "@gym/auth/otp";
import type { PrismaClient } from "@gym/db";
import {
  createEmailSender,
  memberAppInviteEmail,
  staffInviteEmail,
  type EmailSender,
} from "@gym/integrations/email";
import { paymentProviderFactory } from "@gym/integrations/payments";
import { whatsappClientFactory } from "@gym/integrations/whatsapp";
import { redisCopilotLimiter, type CopilotServices } from "@gym/core/copilot";
import { createOpenAiClient } from "@gym/integrations/ai";
import { S3Storage } from "@gym/integrations/storage";
import { getEnv } from "@/env";
import { getDb } from "@/lib/db";
import { getRedis } from "@/lib/queue";

export type WebServices = {
  db: PrismaClient;
  deps: CoreDeps;
  auth: TenantAuth;
  otp: OtpService;
  email: EmailSender;
  limiter: RateLimiter;
  storage: S3Storage;
  brand: string;
  appUrl: string;
  googleEnabled: boolean;
  invitationMailer: InvitationMailer;
  memberInviteMailer: MemberInviteMailer;
  /** M4: the fake payment provider may be connected (development only). */
  fakePayments: boolean;
  /** M6: the fake WhatsApp provider may be connected (development only). */
  fakeWhatsApp: boolean;
  /** M8: the AI Copilot's provider factory, fake switch (development only) and per-gym limiter. */
  ai: CopilotServices;
  /** M6: Meta app settings for the single webhook endpoint and Embedded Signup. */
  meta: {
    appId: string | null;
    appSecret: string | null;
    verifyToken: string | null;
    embeddedSignupConfigId: string | null;
  };
  adminUrl: string;
  internalSecret: string;
};

const globalForServices = globalThis as typeof globalThis & {
  __gymWebServices?: WebServices;
};

/** Built on first use (never at import), so `next build` needs no secrets. */
export function services(): WebServices {
  if (globalForServices.__gymWebServices)
    return globalForServices.__gymWebServices;
  const env = getEnv();
  const db = getDb();
  const redis = getRedis();
  const email = createEmailSender(
    env.EMAIL_PROVIDER === "ses"
      ? {
          provider: "ses",
          from: env.EMAIL_FROM,
          region: env.SES_REGION ?? env.S3_REGION,
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
  const limiter = new RateLimiter(redis, "gym:rl:tenant");
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        }
      : null;
  const brand = env.APP_NAME;
  const appUrl = env.APP_URL.replace(/\/$/, "");

  const built: WebServices = {
    db,
    deps: {
      db,
      entitlements: redisEntitlementCache(redis),
      secrets: createSecretBox({
        key: env.DATA_ENCRYPTION_KEY,
        previousKey: env.DATA_ENCRYPTION_KEY_PREVIOUS,
      }),
      claims: redisClaims(redis),
      appUrl,
      payments: paymentProviderFactory({
        fakeEnabled: env.PAYMENTS_FAKE_ENABLED,
        redis,
        fakeCheckoutBase: `${appUrl}/dev/fake-pay`,
      }),
      whatsapp: whatsappClientFactory({
        fakeEnabled: env.WHATSAPP_FAKE_ENABLED,
        redis,
      }),
    },
    fakePayments: env.PAYMENTS_FAKE_ENABLED,
    fakeWhatsApp: env.WHATSAPP_FAKE_ENABLED,
    ai: {
      factory: createOpenAiClient,
      fake: env.AI_FAKE_ENABLED,
      limiter: redisCopilotLimiter(redis),
    },
    meta: {
      appId: env.META_APP_ID || null,
      appSecret: env.META_APP_SECRET || null,
      verifyToken: env.META_WEBHOOK_VERIFY_TOKEN || null,
      embeddedSignupConfigId: env.META_EMBEDDED_SIGNUP_CONFIG_ID || null,
    },
    adminUrl: env.ADMIN_URL.replace(/\/$/, ""),
    internalSecret: env.PLATFORM_INTERNAL_SECRET,
    auth: createTenantAuth({
      db,
      secret: env.AUTH_SECRET,
      baseURL: appUrl,
      brand,
      email,
      limiter,
      google,
    }),
    otp: createTenantOtp({
      db,
      secret: env.AUTH_SECRET,
      brand,
      email,
      limiter,
    }),
    email,
    limiter,
    storage: new S3Storage({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    }),
    brand,
    appUrl,
    googleEnabled: google !== null,
    invitationMailer: async (message) => {
      await email.send({
        to: message.to,
        ...staffInviteEmail({
          brand,
          tenantName: message.tenantName,
          inviterName: message.inviterName,
          roles: message.roles,
          url: `${appUrl}/invite/${message.token}`,
          expiresAt: message.expiresAt,
        }),
      });
    },
    memberInviteMailer: async (message) => {
      await email.send({
        to: message.to,
        ...memberAppInviteEmail({
          brand,
          tenantName: message.tenantName,
          name: message.name,
          url: `${appUrl}/invite/${message.token}`,
        }),
      });
    },
  };
  globalForServices.__gymWebServices = built;
  return built;
}
