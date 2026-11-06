import type { TenantTransaction } from "@gym/db";
import type { AiClient } from "@gym/integrations/ai";
import { testAiConnection } from "@gym/integrations/ai";
import { z } from "zod";
import type { SecretBox } from "../crypto/secret-box";
import { AppError } from "../errors";
import {
  recordPlatformAudit,
  requirePlatformPermission,
  type PlatformContext,
  type PlatformDeps,
} from "../platform";
import { parseInput } from "../validation";

/**
 * The platform AI provider (one row, platform.ai_provider). Platform admins switch provider/model
 * here without code changes. The key is sealed with the SecretBox, shown only as its last 4
 * characters, and never returned to a browser. Gyms' runtime reads only the columns it needs.
 */

export type AiClientFactory = (config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}) => AiClient;

export type AiRuntimeConfig = {
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxTokens: number;
  enabled: boolean;
  supportsTools: boolean | null;
  logRetentionDays: number;
  tenantRatePerMinute: number;
};

/** Gym side (tenant transaction, column-level grant). Null when not configured. */
export async function loadAiRuntimeTx(
  tx: TenantTransaction,
  secrets: SecretBox | undefined,
): Promise<AiRuntimeConfig | null> {
  const row = await tx.aiProvider.findUnique({
    where: { id: "default" },
    select: {
      label: true,
      baseUrl: true,
      model: true,
      apiKeySealed: true,
      timeoutMs: true,
      maxTokens: true,
      enabled: true,
      supportsTools: true,
      logRetentionDays: true,
      tenantRatePerMinute: true,
    },
  });
  if (!row) return null;
  let apiKey = "";
  if (row.apiKeySealed) {
    if (!secrets)
      throw new Error("CoreDeps.secrets is needed to open the AI provider key");
    apiKey = secrets.decrypt(row.apiKeySealed).toString("utf8");
  }
  const { apiKeySealed: _sealed, ...rest } = row;
  void _sealed;
  return { ...rest, apiKey };
}

// --- platform admin ------------------------------------------------------------------------------

type AdminDeps = PlatformDeps & { secrets: SecretBox };

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

const providerSchema = z
  .object({
    label: z.string().trim().min(2, "Name the provider.").max(60),
    baseUrl: z
      .url("Enter the API base URL, e.g. https://api.openai.com/v1.")
      .max(300)
      .refine((v) => {
        const u = new URL(v);
        return (
          u.protocol === "https:" ||
          (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))
        );
      }, "Use https (http only for a model running on this machine)."),
    model: z
      .string()
      .trim()
      .min(1, "Enter the model id.")
      .max(120)
      .regex(/^[\w./:@-]+$/, "Model ids have no spaces."),
    /** Blank = keep the stored key. "none" = no key (some local servers). */
    apiKey: z.string().trim().max(500).optional(),
    timeoutMs: z.coerce.number().int().min(1000).max(120_000),
    maxTokens: z.coerce.number().int().min(100).max(8000),
    enabled: z.preprocess(
      (v) => v === "on" || v === "true" || v === true,
      z.boolean(),
    ),
    logRetentionDays: z.coerce.number().int().min(1).max(365),
    tenantRatePerMinute: z.coerce.number().int().min(1).max(120),
  })
  .strip();

const hint = (key: string) => (key.length >= 8 ? `…${key.slice(-4)}` : "set");

export async function getAiProviderForAdmin(
  deps: PlatformDeps,
  ctx: PlatformContext,
) {
  requirePlatformPermission(ctx, "platform.tenants.view");
  const row = await deps.db.aiProvider.findUnique({ where: { id: "default" } });
  const since = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  );
  const usage = await deps.db.$queryRaw<
    {
      tenant_id: string;
      requests: bigint;
      fallbacks: bigint;
      flagged: bigint;
      errors: bigint;
      prompt_tokens: bigint;
      completion_tokens: bigint;
    }[]
  >`SELECT * FROM platform_api.ai_usage(${since})`;
  const names = usage.length
    ? new Map(
        (
          await deps.db.tenant.findMany({
            where: { id: { in: usage.map((u) => u.tenant_id) } },
            select: { id: true, displayName: true },
          })
        ).map((t) => [t.id, t.displayName]),
      )
    : new Map<string, string>();
  return {
    provider: row
      ? {
          label: row.label,
          baseUrl: row.baseUrl,
          model: row.model,
          apiKeyHint: row.apiKeyHint,
          hasKey: !!row.apiKeySealed,
          timeoutMs: row.timeoutMs,
          maxTokens: row.maxTokens,
          enabled: row.enabled,
          supportsTools: row.supportsTools,
          lastTestedAt: row.lastTestedAt,
          lastTestOk: row.lastTestOk,
          lastTestMessage: row.lastTestMessage,
          logRetentionDays: row.logRetentionDays,
          tenantRatePerMinute: row.tenantRatePerMinute,
          updatedAt: row.updatedAt,
        }
      : null,
    usageSince: since,
    usage: usage.map((u) => ({
      tenantId: u.tenant_id,
      tenant: names.get(u.tenant_id) ?? u.tenant_id,
      requests: Number(u.requests),
      fallbacks: Number(u.fallbacks),
      flagged: Number(u.flagged),
      errors: Number(u.errors),
      promptTokens: Number(u.prompt_tokens),
      completionTokens: Number(u.completion_tokens),
    })),
  };
}

/** Save provider settings. Changing URL, model or key clears the last test; enabling needs a passing test. */
export async function saveAiProvider(
  deps: AdminDeps,
  ctx: PlatformContext,
  raw: unknown,
) {
  requirePlatformPermission(ctx, "platform.settings.manage");
  const input = parseInput(providerSchema, raw);
  const before = await deps.db.aiProvider.findUnique({
    where: { id: "default" },
  });
  const newKey =
    input.apiKey && input.apiKey !== ""
      ? input.apiKey.toLowerCase() === "none"
        ? ""
        : input.apiKey
      : null;
  if (!before && newKey === null)
    throw new AppError(
      "VALIDATION_FAILED",
      'Enter the API key (or "none" for a local server without one).',
      { fields: { apiKey: ["Enter the API key."] } },
    );
  const connectionChanged =
    !before ||
    before.baseUrl !== input.baseUrl ||
    before.model !== input.model ||
    newKey !== null;
  const tested = !connectionChanged && before?.lastTestOk === true;
  if (input.enabled && !tested)
    throw new AppError(
      "VALIDATION_FAILED",
      "Save the settings, run “Test connection”, then switch the Copilot on.",
      {
        fields: { enabled: ["Test the connection first."] },
      },
    );
  const data = {
    label: input.label,
    baseUrl: input.baseUrl,
    model: input.model,
    timeoutMs: input.timeoutMs,
    maxTokens: input.maxTokens,
    enabled: input.enabled,
    logRetentionDays: input.logRetentionDays,
    tenantRatePerMinute: input.tenantRatePerMinute,
    updatedById: ctx.platformUserId,
    ...(newKey !== null
      ? {
          apiKeySealed: newKey ? deps.secrets.encrypt(newKey) : null,
          apiKeyHint: newKey ? hint(newKey) : "none",
        }
      : {}),
    ...(connectionChanged
      ? {
          supportsTools: null,
          lastTestOk: null,
          lastTestedAt: null,
          lastTestMessage: null,
        }
      : {}),
  };
  await deps.db.$transaction(async (tx) => {
    await tx.aiProvider.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: data,
    });
    const view = (r: typeof data | typeof before) =>
      r && {
        label: r.label,
        baseUrl: r.baseUrl,
        model: r.model,
        timeoutMs: r.timeoutMs,
        maxTokens: r.maxTokens,
        enabled: r.enabled,
        logRetentionDays: r.logRetentionDays,
        tenantRatePerMinute: r.tenantRatePerMinute,
      };
    await recordPlatformAudit(tx, ctx, {
      action: "platform.ai_provider_updated",
      entityType: "AiProvider",
      entityId: "default",
      before: view(before),
      after: view(data),
      meta: { keyChanged: newKey !== null },
    });
  });
}

/** "Test connection": a plain completion and a tool-calling probe; stores the capability flags. */
export async function testAiProvider(
  deps: AdminDeps,
  ctx: PlatformContext,
  factory: AiClientFactory,
) {
  requirePlatformPermission(ctx, "platform.settings.manage");
  const row = await deps.db.aiProvider.findUnique({ where: { id: "default" } });
  if (!row) throw new AppError("CONFLICT", "Save the provider settings first.");
  const apiKey = row.apiKeySealed
    ? deps.secrets.decrypt(row.apiKeySealed).toString("utf8")
    : "none";
  const result = await testAiConnection(
    factory({
      baseUrl: row.baseUrl,
      apiKey,
      model: row.model,
      timeoutMs: row.timeoutMs,
    }),
  );
  await deps.db.$transaction(async (tx) => {
    await tx.aiProvider.update({
      where: { id: "default" },
      data: {
        lastTestedAt: new Date(),
        lastTestOk: result.ok,
        lastTestMessage: result.message,
        supportsTools: result.supportsTools,
        // A failing provider is switched off so gyms get a clear "not available" instead of errors.
        ...(result.ok ? {} : { enabled: false }),
      },
    });
    await recordPlatformAudit(tx, ctx, {
      action: "platform.ai_provider_tested",
      entityType: "AiProvider",
      entityId: "default",
      meta: {
        ok: result.ok,
        supportsTools: result.supportsTools,
        latencyMs: result.latencyMs,
      },
    });
  });
  return result;
}
