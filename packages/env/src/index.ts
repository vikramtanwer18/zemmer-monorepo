import { z } from "zod";

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, "must be a postgresql:// connection string");
const redisUrl = z
  .string()
  .regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL");

/** Settings every process needs. */
export const sharedSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export const urlsSchema = z.object({
  APP_URL: z.url(),
  ADMIN_URL: z.url(),
});

/** Runtime connection for web + worker (role gym_app, RLS applies). */
export const appDatabaseSchema = z.object({
  DATABASE_URL: postgresUrl,
});

/** Runtime connection for admin (role gym_platform). */
export const platformDatabaseSchema = z.object({
  PLATFORM_DATABASE_URL: postgresUrl,
});

export const redisSchema = z.object({
  REDIS_URL: redisUrl,
});

export const storageSchema = z.object({
  /** Leave unset on AWS; set to the MinIO URL locally. */
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
});

/** smtp = Mailpit locally; ses = AWS SES in production; memory = tests (nothing is sent). */
export const emailSchema = z.object({
  EMAIL_PROVIDER: z.enum(["smtp", "ses", "memory"]).default("smtp"),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SES_REGION: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3),
});

function checkEmailProvider(
  env: {
    EMAIL_PROVIDER: string;
    SMTP_HOST?: string;
    SMTP_PORT?: number;
    SES_REGION?: string;
  },
  ctx: z.RefinementCtx,
) {
  if (env.EMAIL_PROVIDER === "smtp" && (!env.SMTP_HOST || !env.SMTP_PORT)) {
    ctx.addIssue({
      code: "custom",
      path: ["SMTP_HOST"],
      message: "required when EMAIL_PROVIDER=smtp",
    });
  }
  if (env.EMAIL_PROVIDER === "ses" && !env.SES_REGION) {
    ctx.addIssue({
      code: "custom",
      path: ["SES_REGION"],
      message: "required when EMAIL_PROVIDER=ses",
    });
  }
}

const secret = (name: string) =>
  z
    .string()
    .min(
      32,
      `${name} must be at least 32 characters (openssl rand -base64 32)`,
    );

/** Shown in emails and page titles. */
export const brandSchema = z.object({
  APP_NAME: z.string().min(1).default("Gym SaaS"),
});

/** Tenant realm (apps/web). Google sign-in is offered only when both Google values are set. */
export const tenantAuthSchema = z.object({
  AUTH_SECRET: secret("AUTH_SECRET"),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
});

/**
 * Key-encryption key for secrets stored in the database (member pass secrets now, payment and
 * WhatsApp credentials later). In production it comes from Secrets Manager / SSM. The optional
 * previous key lets old records be read during a key rotation.
 */
export const encryptionSchema = z.object({
  DATA_ENCRYPTION_KEY: secret("DATA_ENCRYPTION_KEY"),
  DATA_ENCRYPTION_KEY_PREVIOUS: secret(
    "DATA_ENCRYPTION_KEY_PREVIOUS",
  ).optional(),
});

/**
 * M4 payments. PAYMENTS_FAKE_ENABLED lets gyms (and the platform) connect the fake provider:
 * development, tests and demos only; refused in a real deployment.
 */
export const paymentsSchema = z.object({
  PAYMENTS_FAKE_ENABLED: z.stringbool().default(false),
});

/**
 * M6 WhatsApp (D-12). One Meta app for the platform: its secret signs every webhook, the verify
 * token answers Meta's subscription handshake. Empty until the operator has a Meta app; the
 * webhook then refuses everything. WHATSAPP_FAKE_ENABLED: development/tests only.
 */
export const whatsappSchema = z.object({
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  /** Embedded Signup configuration id (only once the Tech Provider approval exists). */
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().optional(),
  WHATSAPP_FAKE_ENABLED: z.stringbool().default(false),
});

/**
 * M8 AI Copilot. The provider (base URL, model, key) is configured by platform admins in the
 * console and stored encrypted. AI_FAKE_ENABLED answers with a deterministic fake instead
 * (development, tests and demos only; refused in a real deployment).
 */
export const aiSchema = z.object({
  AI_FAKE_ENABLED: z.stringbool().default(false),
});

/** Signs gym-app → admin-app requests (SaaS checkout); the same value in both apps. */
export const internalSchema = z.object({
  PLATFORM_INTERNAL_SECRET: secret("PLATFORM_INTERNAL_SECRET"),
});

/** Platform realm (apps/admin): a different secret from the tenant realm (D-03). */
export const platformAuthSchema = z.object({
  ADMIN_AUTH_SECRET: secret("ADMIN_AUTH_SECRET"),
});

/** A production build served from this machine (local `next start`, e2e tests). */
function isLocalUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(value).hostname,
    );
  } catch {
    return false;
  }
}

/**
 * Refuses development placeholder secrets in a real deployment: production mode on a
 * non-localhost URL. Local production builds (e2e) may keep the placeholders.
 */
function checkSecrets(env: Record<string, unknown>, ctx: z.RefinementCtx) {
  if (env.NODE_ENV !== "production" || isLocalUrl(env.APP_URL)) return;
  if (env.WHATSAPP_FAKE_ENABLED === true)
    ctx.addIssue({
      code: "custom",
      path: ["WHATSAPP_FAKE_ENABLED"],
      message: "the fake WhatsApp provider must not be enabled in production",
    });
  if (env.AI_FAKE_ENABLED === true)
    ctx.addIssue({
      code: "custom",
      path: ["AI_FAKE_ENABLED"],
      message: "the fake AI provider must not be enabled in production",
    });
  if (env.PAYMENTS_FAKE_ENABLED === true)
    ctx.addIssue({
      code: "custom",
      path: ["PAYMENTS_FAKE_ENABLED"],
      message: "the fake payment provider must not be enabled in production",
    });
  for (const key of [
    "AUTH_SECRET",
    "ADMIN_AUTH_SECRET",
    "DATA_ENCRYPTION_KEY",
    "PLATFORM_INTERNAL_SECRET",
  ]) {
    const value = env[key];
    if (typeof value === "string" && value.includes("dev-only")) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: "replace the development placeholder",
      });
    }
  }
  if (env.DATA_ENCRYPTION_KEY && env.DATA_ENCRYPTION_KEY === env.AUTH_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["DATA_ENCRYPTION_KEY"],
      message: "must differ from AUTH_SECRET",
    });
  }
  if (env.AUTH_SECRET && env.AUTH_SECRET === env.ADMIN_AUTH_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["ADMIN_AUTH_SECRET"],
      message: "must differ from AUTH_SECRET",
    });
  }
}

const refine = (env: Record<string, unknown>, ctx: z.RefinementCtx) => {
  checkEmailProvider(env as Parameters<typeof checkEmailProvider>[0], ctx);
  checkSecrets(env, ctx);
};

export const webEnvSchema = sharedSchema
  .extend(urlsSchema.shape)
  .extend(brandSchema.shape)
  .extend(appDatabaseSchema.shape)
  .extend(redisSchema.shape)
  .extend(storageSchema.shape)
  .extend(emailSchema.shape)
  .extend(tenantAuthSchema.shape)
  .extend(encryptionSchema.shape)
  .extend(paymentsSchema.shape)
  .extend(internalSchema.shape)
  .extend(whatsappSchema.shape)
  .extend(aiSchema.shape)
  .superRefine(refine);

export const adminEnvSchema = sharedSchema
  .extend(urlsSchema.shape)
  .extend(brandSchema.shape)
  .extend(platformDatabaseSchema.shape)
  .extend(redisSchema.shape)
  .extend(emailSchema.shape)
  .extend(platformAuthSchema.shape)
  .extend(encryptionSchema.shape)
  .extend(paymentsSchema.shape)
  .extend(internalSchema.shape)
  .extend(whatsappSchema.shape)
  .extend(aiSchema.shape)
  .superRefine(refine);

export const workerEnvSchema = sharedSchema
  .extend(urlsSchema.shape)
  .extend(brandSchema.shape)
  .extend(appDatabaseSchema.shape)
  .extend(platformDatabaseSchema.shape)
  .extend(redisSchema.shape)
  .extend(storageSchema.shape)
  .extend(emailSchema.shape)
  .extend(encryptionSchema.shape)
  .extend(paymentsSchema.shape)
  .extend(whatsappSchema.shape)
  .extend({
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4100),
  })
  .superRefine(refine);

export type WebEnv = z.infer<typeof webEnvSchema>;
export type AdminEnv = z.infer<typeof adminEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "EnvValidationError";
  }
}

/**
 * Validates `source` (default `process.env`) against `schema`.
 * Empty strings count as "not set". Throws one error listing every problem.
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(
      ([, value]) => value !== undefined && value !== "",
    ),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
