import type { Prisma } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import {
  notificationDataKeys,
  TEMPLATES,
  WHATSAPP_NOTIFICATION_KEYS,
  type WhatsAppNotificationMapping,
} from "../notifications";
import { guard, inTenant, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";
import { currentAccountTx } from "./accounts";
import { cleanKeywords } from "./rules";

export async function getMessagingSettings(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "settings.view" });
  return inTenant(deps, ctx, async (tx) => {
    const s = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
      select: {
        optOutKeywords: true,
        optInKeywords: true,
        marketingDailyCap: true,
        whatsappNotificationTemplates: true,
      },
    });
    const account = await currentAccountTx(tx);
    const templates = account
      ? await tx.messageTemplate.findMany({
          where: {
            accountId: account.id,
            status: { not: "DELETED" },
            category: { in: ["UTILITY", "AUTHENTICATION"] },
          },
          select: {
            id: true,
            name: true,
            language: true,
            status: true,
            variables: true,
            bodyText: true,
          },
          orderBy: { name: "asc" },
        })
      : [];
    const mapping = (s?.whatsappNotificationTemplates ?? {}) as Record<
      string,
      WhatsAppNotificationMapping | undefined
    >;
    return {
      optOutKeywords: s?.optOutKeywords ?? [],
      optInKeywords: s?.optInKeywords ?? [],
      marketingDailyCap: s?.marketingDailyCap ?? 1,
      notifications: WHATSAPP_NOTIFICATION_KEYS.map((key) => ({
        key,
        title: TEMPLATES[key].subject,
        dataKeys: notificationDataKeys(key),
        mapping: mapping[key] ?? null,
      })),
      utilityTemplates: templates,
    };
  });
}

const keywordList = z
  .string()
  .max(1000)
  .transform((v) => cleanKeywords(v.split(/[,\n]/)));

const settingsSchema = z.object({
  optOutKeywords: keywordList.refine(
    (k) => k.includes("stop"),
    "“stop” must stay on the list (WhatsApp users expect it).",
  ),
  optInKeywords: keywordList,
  marketingDailyCap: z.coerce.number().int().min(0).max(10),
});

export async function saveMessagingSettings(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "messaging.configure", write: true });
  const input = parseInput(settingsSchema, raw);
  const clash = input.optInKeywords.find((k) =>
    input.optOutKeywords.includes(k),
  );
  if (clash)
    throw new AppError(
      "VALIDATION_FAILED",
      `“${clash}” can't be both an opt-out and an opt-in word.`,
      {
        fields: { optInKeywords: ["Overlaps the opt-out list."] },
      },
    );
  return inTenant(deps, ctx, async (tx) => {
    await tx.tenantSettings.update({
      where: { tenantId: ctx.tenantId },
      data: input,
    });
    await recordAudit(tx, ctx, {
      action: "messaging.settings_updated",
      entityType: "TenantSettings",
      entityId: ctx.tenantId,
      after: input,
    });
  });
}

const mappingSchema = z.object({
  key: z.enum(WHATSAPP_NOTIFICATION_KEYS),
  templateId: z.preprocess((v) => (v === "" ? null : v), z.uuid().nullable()),
  variables: z.record(z.string(), z.string()).default({}),
});

/** Maps a built-in message to an approved UTILITY template; every placeholder must be mapped. */
export async function saveNotificationTemplate(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, {
    permission: "messaging.configure",
    write: true,
    entitlement: "whatsapp.enabled",
  });
  const input = parseInput(mappingSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const s = await tx.tenantSettings.findUniqueOrThrow({
      where: { tenantId: ctx.tenantId },
      select: { whatsappNotificationTemplates: true },
    });
    const map = {
      ...((s.whatsappNotificationTemplates ?? {}) as Record<
        string,
        WhatsAppNotificationMapping
      >),
    };
    if (!input.templateId) delete map[input.key];
    else {
      const t = await tx.messageTemplate.findUnique({
        where: { id: input.templateId },
      });
      if (!t || t.status === "DELETED")
        throw new AppError("NOT_FOUND", "Template not found.");
      if (t.category === "MARKETING")
        throw new AppError(
          "VALIDATION_FAILED",
          "Reminders and receipts must use a UTILITY template, not MARKETING.",
        );
      const allowed = notificationDataKeys(input.key);
      const missing = t.variables.filter((v) => !input.variables[v]);
      if (missing.length)
        throw new AppError(
          "VALIDATION_FAILED",
          `Map every placeholder: ${missing.map((m) => `{{${m}}}`).join(", ")}.`,
        );
      const bad = Object.values(input.variables).find(
        (d) => !allowed.includes(d),
      );
      if (bad)
        throw new AppError(
          "VALIDATION_FAILED",
          `“${bad}” isn't a value this message has.`,
        );
      map[input.key] = {
        templateId: t.id,
        variables: Object.fromEntries(
          t.variables.map((v) => [v, input.variables[v]!]),
        ),
      };
    }
    await tx.tenantSettings.update({
      where: { tenantId: ctx.tenantId },
      data: {
        whatsappNotificationTemplates: map as unknown as Prisma.InputJsonValue,
      },
    });
    await recordAudit(tx, ctx, {
      action: "messaging.notification_template_mapped",
      entityType: "TenantSettings",
      entityId: ctx.tenantId,
      after: { key: input.key, templateId: input.templateId },
    });
  });
}
