import { withTenant, type Prisma, type TenantTransaction } from "@gym/db";
import {
  exchangeEmbeddedSignupCode,
  placeholders,
  templateBody,
  WhatsAppError,
  type ProviderTemplate,
  type WhatsAppClient,
  type WhatsAppCredentials,
} from "@gym/integrations/whatsapp";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import {
  guard,
  inTenant,
  nowOf,
  secretsOf,
  whatsappOf,
  type CoreDeps,
} from "../tenancy/deps";
import { readPlatformSettings } from "../platform-settings";
import { parseInput } from "../validation";

/**
 * A gym's own WhatsApp Business Account (D-12). The access token is sealed with the data key,
 * never returned to the browser, never logged or audited (only its last 4 characters).
 */
export type AccountRow = {
  id: string;
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  accessTokenEnc: string;
  connectionMethod: "MANUAL" | "EMBEDDED_SIGNUP" | "FAKE";
  status: "ACTIVE" | "ERROR" | "DISCONNECTED";
};

export function credentialsOf(
  deps: Pick<CoreDeps, "secrets">,
  account: Pick<AccountRow, "wabaId" | "phoneNumberId" | "accessTokenEnc">,
): WhatsAppCredentials {
  return {
    wabaId: account.wabaId,
    phoneNumberId: account.phoneNumberId,
    accessToken: secretsOf(deps)
      .decrypt(account.accessTokenEnc)
      .toString("utf8"),
  };
}

export function clientOf(
  deps: Pick<CoreDeps, "whatsapp">,
  account: Pick<AccountRow, "connectionMethod">,
): WhatsAppClient {
  return whatsappOf(deps)(account.connectionMethod);
}

/** The account currently in use (ACTIVE or ERROR), if any. */
export function currentAccountTx(tx: TenantTransaction) {
  return tx.whatsAppAccount.findFirst({
    where: { status: { not: "DISCONNECTED" } },
  });
}

/** Where the operator points the Meta app's webhook (one URL for every gym). */
export const WEBHOOK_PATH = "/api/webhooks/whatsapp";

/** The token needs these (system user in the gym's own Meta Business). */
export const TOKEN_PERMISSIONS = [
  "whatsapp_business_messaging",
  "whatsapp_business_management",
] as const;

export const META_TEMPLATE_MANAGER_URL = (wabaId: string) =>
  `https://business.facebook.com/wa/manage/message-templates/?waba_id=${encodeURIComponent(wabaId)}`;

export async function getWhatsAppAccount(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "settings.view" });
  return inTenant(deps, ctx, async (tx) => {
    const row = await currentAccountTx(tx);
    if (!row) return null;
    const [templates, approved] = [
      await tx.messageTemplate.count({ where: { accountId: row.id } }),
      await tx.messageTemplate.count({
        where: { accountId: row.id, status: "APPROVED" },
      }),
    ];
    return {
      id: row.id,
      wabaId: row.wabaId,
      phoneNumberId: row.phoneNumberId,
      displayPhone: row.displayPhone,
      verifiedName: row.verifiedName,
      tokenLast4: row.tokenLast4,
      connectionMethod: row.connectionMethod,
      status: row.status,
      qualityRating: row.qualityRating,
      messagingLimit: row.messagingLimit,
      webhookSubscribed: row.webhookSubscribed,
      lastSyncedAt: row.lastSyncedAt,
      lastError: row.lastError,
      connectedAt: row.createdAt,
      templates,
      approvedTemplates: approved,
      templateManagerUrl: META_TEMPLATE_MANAGER_URL(row.wabaId),
    };
  });
}

export type MetaAppConfig = {
  appId: string | null;
  appSecret: string | null;
  embeddedSignupConfigId: string | null;
};

/** Embedded Signup shows only when the platform switched it on AND the Meta app is configured. */
export async function embeddedSignupAvailability(
  deps: Pick<CoreDeps, "db">,
  meta: MetaAppConfig,
) {
  const settings = await readPlatformSettings(deps.db);
  const configured = !!(
    meta.appId &&
    meta.appSecret &&
    meta.embeddedSignupConfigId
  );
  return {
    available: settings["whatsapp.embedded_signup_enabled"] && configured,
    flag: settings["whatsapp.embedded_signup_enabled"],
    configured,
    appId: configured ? meta.appId : null,
    configId: configured ? meta.embeddedSignupConfigId : null,
  };
}

const embeddedSchema = z.object({
  code: z.string().trim().min(10).max(2000),
  wabaId: z
    .string()
    .trim()
    .regex(/^\d{5,25}$/),
  phoneNumberId: z
    .string()
    .trim()
    .regex(/^\d{5,25}$/),
});

/** Embedded Signup finish: the code becomes a business token server-side, then the normal connect. */
export async function connectViaEmbeddedSignup(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
  meta: MetaAppConfig,
) {
  await guard(deps, ctx, {
    permission: "messaging.configure",
    write: true,
    entitlement: "whatsapp.enabled",
  });
  const input = parseInput(embeddedSchema, raw);
  const availability = await embeddedSignupAvailability(deps, meta);
  if (!availability.available || !meta.appId || !meta.appSecret)
    throw new AppError(
      "CONFLICT",
      "Embedded Signup isn't available yet. Use Manual Connect.",
    );
  let token: string;
  try {
    token = await exchangeEmbeddedSignupCode({
      appId: meta.appId,
      appSecret: meta.appSecret,
      code: input.code,
    });
  } catch (err) {
    throw friendlyMetaError(err);
  }
  return connectWhatsAppAccount(
    deps,
    ctx,
    {
      method: "EMBEDDED_SIGNUP",
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      accessToken: token,
    },
    { allowEmbedded: true },
  );
}

const connectSchema = z.object({
  method: z.enum(["MANUAL", "FAKE", "EMBEDDED_SIGNUP"]).default("MANUAL"),
  wabaId: z
    .string()
    .trim()
    .regex(/^\d{5,25}$/, "The WhatsApp Business Account ID is a long number."),
  phoneNumberId: z
    .string()
    .trim()
    .regex(
      /^\d{5,25}$/,
      "The phone number ID is a long number (not the phone number itself).",
    ),
  accessToken: z
    .string()
    .trim()
    .min(20, "Paste the system-user access token.")
    .max(1000),
});

function friendlyMetaError(err: unknown): AppError {
  if (err instanceof WhatsAppError) {
    if (err.code === "190")
      return new AppError(
        "VALIDATION_FAILED",
        "WhatsApp says the access token is invalid or expired.",
        {
          fields: { accessToken: ["Invalid or expired token."] },
        },
      );
    if (err.code === "NUMBER_NOT_IN_WABA")
      return new AppError("VALIDATION_FAILED", err.message, {
        fields: { phoneNumberId: ["Not in this WhatsApp Business Account."] },
      });
    if (err.code === "100" || err.code === "803")
      return new AppError(
        "VALIDATION_FAILED",
        "WhatsApp couldn't find that account or number with this token. Check the IDs and the token's permissions.",
        {
          fields: {
            wabaId: ["Check the ID."],
            phoneNumberId: ["Check the ID."],
          },
        },
      );
    if (err.code === "200" || err.code === "10")
      return new AppError(
        "VALIDATION_FAILED",
        `The token is missing a permission. It needs ${TOKEN_PERMISSIONS.join(" and ")}.`,
        {
          fields: { accessToken: ["Missing permissions."] },
        },
      );
    return new AppError("CONFLICT", `WhatsApp: ${err.message}`);
  }
  return new AppError(
    "CONFLICT",
    "Couldn't reach WhatsApp. Try again shortly.",
  );
}

/**
 * Manual Connect: checks the IDs and token with live API calls, subscribes our app to the
 * WABA's webhooks, then stores the token sealed. Replaces the previous account in one
 * transaction. A number can belong to one gym at a time (unique index).
 */
export async function connectWhatsAppAccount(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
  options: { allowFake?: boolean; allowEmbedded?: boolean } = {},
) {
  await guard(deps, ctx, {
    permission: "messaging.configure",
    write: true,
    entitlement: "whatsapp.enabled",
  });
  const input = parseInput(connectSchema, raw);
  if (input.method === "FAKE" && !options.allowFake)
    throw new AppError(
      "FORBIDDEN",
      "The test WhatsApp provider is only available in development.",
    );
  if (input.method === "EMBEDDED_SIGNUP" && !options.allowEmbedded)
    throw new AppError("FORBIDDEN", "Use the Embedded Signup button.");
  const creds: WhatsAppCredentials = {
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
    accessToken: input.accessToken,
  };
  const client = whatsappOf(deps)(input.method);
  let info;
  let subscribed = false;
  try {
    info = await client.verify(creds);
    await client.subscribeApp(creds);
    subscribed = true;
  } catch (err) {
    throw friendlyMetaError(err);
  }
  const box = secretsOf(deps);
  const now = nowOf(deps);
  const account = await inTenant(deps, ctx, async (tx) => {
    const previous = await currentAccountTx(tx);
    if (previous)
      await tx.whatsAppAccount.update({
        where: { id: previous.id },
        data: { status: "DISCONNECTED", disconnectedAt: now },
      });
    let row;
    try {
      row = await tx.whatsAppAccount.create({
        data: {
          tenantId: ctx.tenantId,
          wabaId: input.wabaId,
          phoneNumberId: input.phoneNumberId,
          displayPhone: info.displayPhone,
          verifiedName: info.verifiedName,
          qualityRating: info.qualityRating,
          messagingLimit: info.messagingLimit,
          accessTokenEnc: box.encrypt(input.accessToken),
          tokenLast4: input.accessToken.slice(-4),
          connectionMethod: input.method,
          webhookSubscribed: subscribed,
          connectedById: ctx.userId,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new AppError(
          "CONFLICT",
          "This WhatsApp number is already connected to another account on this platform.",
          {
            fields: { phoneNumberId: ["Already connected elsewhere."] },
          },
        );
      throw err;
    }
    await recordAudit(tx, ctx, {
      action: previous
        ? "whatsapp_account.replaced"
        : "whatsapp_account.connected",
      entityType: "WhatsAppAccount",
      entityId: row.id,
      after: {
        method: row.connectionMethod,
        wabaId: row.wabaId,
        phoneNumberId: row.phoneNumberId,
        displayPhone: row.displayPhone,
        tokenLast4: row.tokenLast4,
        replaced: previous?.id ?? null,
      },
    });
    return row;
  });
  // Templates right away (also nightly and on demand). A failure here doesn't undo the connect.
  const sync = await syncTemplates(deps, ctx.tenantId, account.id).catch(
    (err: unknown) => ({
      error: err instanceof Error ? err.message : "sync failed",
    }),
  );
  return { id: account.id, displayPhone: account.displayPhone, sync };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string; meta?: unknown };
  return e?.code === "P2002" || /unique|duplicate key/i.test(e?.message ?? "");
}

/** "Check connection": refreshes quality and limit; marks the account ERROR if the token broke. */
export async function verifyWhatsAppAccount(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "messaging.configure", write: true });
  const row = await inTenant(deps, ctx, async (tx) => {
    const a = await currentAccountTx(tx);
    if (!a) throw new AppError("NOT_FOUND", "WhatsApp isn't connected.");
    return a;
  });
  let result: { ok: true } | { ok: false; reason: string };
  let info: Awaited<ReturnType<WhatsAppClient["verify"]>> | null = null;
  try {
    info = await clientOf(deps, row).verify(credentialsOf(deps, row));
    result = { ok: true };
  } catch (err) {
    result = { ok: false, reason: friendlyMetaError(err).message };
  }
  await inTenant(deps, ctx, async (tx) => {
    await tx.whatsAppAccount.update({
      where: { id: row.id },
      data: info
        ? {
            status: "ACTIVE",
            lastError: null,
            displayPhone: info.displayPhone,
            verifiedName: info.verifiedName,
            qualityRating: info.qualityRating,
            messagingLimit: info.messagingLimit,
          }
        : { status: "ERROR", lastError: result.ok ? null : result.reason },
    });
    await recordAudit(tx, ctx, {
      action: "whatsapp_account.verified",
      entityType: "WhatsAppAccount",
      entityId: row.id,
      meta: { ok: result.ok },
    });
  });
  return result;
}

export async function disconnectWhatsAppAccount(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "messaging.configure", write: true });
  const { reason } = parseInput(
    z.object({ reason: z.string().trim().min(3, "Say why.").max(300) }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const row = await currentAccountTx(tx);
    if (!row) throw new AppError("NOT_FOUND", "WhatsApp isn't connected.");
    await tx.whatsAppAccount.update({
      where: { id: row.id },
      data: { status: "DISCONNECTED", disconnectedAt: nowOf(deps) },
    });
    // Anything not yet sent stops here; the send gate would refuse it anyway.
    const skipped = await tx.outboundMessage.updateMany({
      where: { accountId: row.id, status: "QUEUED" },
      data: { status: "SKIPPED", skipReason: "ACCOUNT_INACTIVE" },
    });
    await recordAudit(tx, ctx, {
      action: "whatsapp_account.disconnected",
      entityType: "WhatsAppAccount",
      entityId: row.id,
      meta: { reason, skippedQueued: skipped.count },
    });
  });
}

// --- templates ------------------------------------------------------------------------------

function category(
  c: string,
): "MARKETING" | "UTILITY" | "AUTHENTICATION" | "OTHER" {
  const u = c.toUpperCase();
  return u === "MARKETING" || u === "UTILITY" || u === "AUTHENTICATION"
    ? u
    : "OTHER";
}

export async function upsertTemplatesTx(
  tx: TenantTransaction,
  tenantId: string,
  accountId: string,
  templates: readonly ProviderTemplate[],
  now: Date,
) {
  const seen = new Set<string>();
  for (const t of templates) {
    const body = templateBody(t.components);
    const data = {
      providerTemplateId: t.id || null,
      category: category(t.category),
      status: t.status.toUpperCase(),
      parameterFormat: t.parameterFormat,
      variables: placeholders(body),
      bodyText: body,
      components: t.components as Prisma.InputJsonValue,
      syncedAt: now,
    };
    const row = await tx.messageTemplate.upsert({
      where: {
        tenantId_accountId_name_language: {
          tenantId,
          accountId,
          name: t.name,
          language: t.language,
        },
      },
      create: {
        tenantId,
        accountId,
        name: t.name,
        language: t.language,
        ...data,
      },
      update: data,
    });
    seen.add(row.id);
  }
  // Deleted in Meta's manager: keep the row (messages reference it) but never send it again.
  const gone = await tx.messageTemplate.updateMany({
    where: { accountId, id: { notIn: [...seen] }, status: { not: "DELETED" } },
    data: { status: "DELETED", syncedAt: now },
  });
  return { synced: seen.size, removed: gone.count };
}

/** Pulls the account's templates from Meta (connect, nightly, "Sync now"). System-level. */
export async function syncTemplates(
  deps: CoreDeps,
  tenantId: string,
  accountId: string,
) {
  const account = await withTenant(deps.db, tenantId, (tx) =>
    tx.whatsAppAccount.findUnique({ where: { id: accountId } }),
  );
  if (!account || account.status === "DISCONNECTED")
    return { synced: 0, removed: 0, skipped: true };
  const now = nowOf(deps);
  let templates: ProviderTemplate[];
  try {
    templates = await clientOf(deps, account).listTemplates(
      credentialsOf(deps, account),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "sync failed";
    await withTenant(deps.db, tenantId, (tx) =>
      tx.whatsAppAccount.update({
        where: { id: account.id },
        data: {
          lastError: `Template sync: ${message}`,
          ...(err instanceof WhatsAppError && err.code === "190"
            ? { status: "ERROR" as const }
            : {}),
        },
      }),
    );
    throw err;
  }
  return withTenant(deps.db, tenantId, async (tx) => {
    const result = await upsertTemplatesTx(
      tx,
      tenantId,
      account.id,
      templates,
      now,
    );
    await tx.whatsAppAccount.update({
      where: { id: account.id },
      data: { lastSyncedAt: now, lastError: null },
    });
    return { ...result, skipped: false };
  });
}

/** "Sync now" in settings. */
export async function syncTemplatesNow(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, {
    permission: "messaging.configure",
    write: true,
    entitlement: "whatsapp.enabled",
  });
  const account = await inTenant(deps, ctx, (tx) => currentAccountTx(tx));
  if (!account) throw new AppError("NOT_FOUND", "WhatsApp isn't connected.");
  try {
    return await syncTemplates(deps, ctx.tenantId, account.id);
  } catch (err) {
    throw friendlyMetaError(err);
  }
}

export async function listTemplates(
  deps: CoreDeps,
  ctx: AuthContext,
  options: { approvedOnly?: boolean; category?: "MARKETING" | "UTILITY" } = {},
) {
  await guard(deps, ctx, { permission: "messaging.send" });
  return inTenant(deps, ctx, async (tx) => {
    const account = await currentAccountTx(tx);
    if (!account) return [];
    return tx.messageTemplate.findMany({
      where: {
        accountId: account.id,
        status: options.approvedOnly ? "APPROVED" : { not: "DELETED" },
        ...(options.category ? { category: options.category } : {}),
      },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        language: true,
        category: true,
        status: true,
        parameterFormat: true,
        variables: true,
        bodyText: true,
        syncedAt: true,
      },
    });
  });
}
