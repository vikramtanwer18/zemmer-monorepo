import { createSecretBox } from "@gym/core/crypto";
import { redisEntitlementCache } from "@gym/core/entitlements";
import { redisClaims } from "@gym/core/tenancy";
import {
  paymentProviderFactory,
  subscriptionProviderFactory,
} from "@gym/integrations/payments";
import { closeQueues, createRedisConnection, getQueue } from "@gym/core/jobs";
import { createLogger } from "@gym/core/logger";
import { createPrismaClient } from "@gym/db";
import { whatsappClientFactory } from "@gym/integrations/whatsapp";
import { createEmailSender, escapeHtml } from "@gym/integrations/email";
import { S3Storage } from "@gym/integrations/storage";
import { getEnv } from "./env";
import { startHealthServer } from "./health";
import { startWorkers } from "./worker";

const env = getEnv();
const log = createLogger({ name: "worker", level: env.LOG_LEVEL });

const redis = createRedisConnection(env.REDIS_URL);
const db = createPrismaClient(env.DATABASE_URL);
// Platform-wide jobs (trial expiry) use the platform role, which cannot read gym data.
const platformDb = createPrismaClient(env.PLATFORM_DATABASE_URL, {
  maxConnections: 2,
});
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
const storage = new S3Storage({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});
const secrets = createSecretBox({
  key: env.DATA_ENCRYPTION_KEY,
  previousKey: env.DATA_ENCRYPTION_KEY_PREVIOUS,
});
const appUrl = env.APP_URL.replace(/\/$/, "");
const adminUrl = env.ADMIN_URL.replace(/\/$/, "");
const entitlements = redisEntitlementCache(redis);
const workers = startWorkers(
  redis,
  db,
  log,
  { db: platformDb, entitlements },
  {
    db,
    redis,
    email,
    storage,
    brand: env.APP_NAME,
    appUrl,
    deps: {
      db,
      entitlements,
      secrets,
      claims: redisClaims(redis),
      appUrl,
      payments: paymentProviderFactory({
        fakeEnabled: env.PAYMENTS_FAKE_ENABLED,
        redis,
        fakeCheckoutBase: `${appUrl}/dev/fake-pay`,
      }),
      // M6: Meta Cloud API, or the fake (development/tests only; refused in production).
      whatsapp: whatsappClientFactory({
        fakeEnabled: env.WHATSAPP_FAKE_ENABLED,
        redis,
      }),
    },
    billing: {
      db: platformDb,
      entitlements,
      secrets,
      appUrl,
      allowFake: env.PAYMENTS_FAKE_ENABLED,
      subscriptions: subscriptionProviderFactory({
        fakeEnabled: env.PAYMENTS_FAKE_ENABLED,
        redis,
        fakeCheckoutBase: `${adminUrl}/dev/fake-subscribe`,
      }),
      // Dunning and trial emails to gym owners (plain text, escaped into simple HTML).
      mailer: async (m) => {
        await email.send({
          to: m.to,
          subject: m.subject,
          text: m.text,
          html: `<!doctype html><html><body style="font-family:Arial,sans-serif">${m.text
            .split("\n\n")
            .map((p) => `<p>${escapeHtml(p)}</p>`)
            .join("")}</body></html>`,
        });
      },
    },
  },
);

const system = (idempotencyKey: string) => ({
  tenantId: null,
  actor: { type: "system" as const },
  idempotencyKey,
  data: {},
});
await getQueue("outbox", redis).upsertJobScheduler(
  "outbox.relay",
  { every: 5_000 },
  {
    name: "outbox.relay",
    data: system("outbox-relay"),
    opts: { removeOnComplete: true, removeOnFail: 100 },
  },
);
await getQueue("platform", redis).upsertJobScheduler(
  "platform.daily-scan",
  { every: 60 * 60 * 1000, immediately: true },
  { name: "platform.daily-scan", data: system("platform-daily-scan") },
);

await getQueue("platform", redis).upsertJobScheduler(
  "platform.floor-scan",
  { every: 15 * 60 * 1000, immediately: true },
  { name: "platform.floor-scan", data: system("platform-floor-scan") },
);

await getQueue("platform", redis).upsertJobScheduler(
  "platform.payments-scan",
  { every: 15 * 60 * 1000 },
  { name: "platform.payments-scan", data: system("platform-payments-scan") },
);
await getQueue("platform", redis).upsertJobScheduler(
  "platform.billing-lifecycle",
  { every: 60 * 60 * 1000, immediately: true },
  {
    name: "platform.billing-lifecycle",
    data: system("platform-billing-lifecycle"),
  },
);

await getQueue("platform", redis).upsertJobScheduler(
  "platform.crm-scan",
  { every: 5 * 60 * 1000 },
  { name: "platform.crm-scan", data: system("platform-crm-scan") },
);

await getQueue("platform", redis).upsertJobScheduler(
  "platform.messaging-scan",
  { every: 60 * 1000 },
  { name: "platform.messaging-scan", data: system("platform-messaging-scan") },
);

// Repeating jobs. upsert is idempotent, so every worker instance can run it on start.
await getQueue("platform", redis).upsertJobScheduler(
  "platform.expire-trials",
  { every: 15 * 60 * 1000 },
  {
    name: "platform.expire-trials",
    data: {
      tenantId: null,
      actor: { type: "system" },
      idempotencyKey: "platform-expire-trials",
      data: {},
    },
  },
);
const health = startHealthServer(env.WORKER_HEALTH_PORT, redis, db);

log.info(
  { queues: workers.map((w) => w.name), healthPort: env.WORKER_HEALTH_PORT },
  "worker started",
);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  try {
    await new Promise<void>((resolve) => health.close(() => resolve()));
    // Waits for running jobs to finish.
    await Promise.all(workers.map((worker) => worker.close()));
    await closeQueues();
    await redis.quit();
    await db.$disconnect();
    await platformDb.$disconnect();
    log.info("bye");
    process.exit(0);
  } catch (err) {
    log.error({ err }, "shutdown failed");
    process.exit(1);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
