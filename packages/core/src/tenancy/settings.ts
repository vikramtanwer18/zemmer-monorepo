import { inOrder } from "@gym/db";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { recordAudit } from "../audit";
import { requirePermission, type AuthContext } from "../authz";
import { AppError } from "../errors";
import { parseInput } from "../validation";
import { guard, inTenant, type CoreDeps } from "./deps";
import {
  orgProfileSchema,
  securitySettingsSchema,
  taxSettingsSchema,
} from "./schemas";

/** File storage the settings service needs (implemented in packages/integrations/storage). */
export type UploadStorage = {
  createUpload(input: {
    key: string;
    contentType: string;
    maxBytes: number;
  }): Promise<{ url: string; fields: Record<string, string> }>;
  head(
    key: string,
  ): Promise<{ size: number; contentType: string | null } | null>;
  getUrl(key: string, expiresInSeconds?: number): Promise<string>;
};

export const LOGO_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;
export const LOGO_MAX_BYTES = 1024 * 1024;

export async function getTenantSettings(deps: CoreDeps, ctx: AuthContext) {
  requirePermission(ctx, "settings.view");
  return inTenant(deps, ctx, async (tx) => {
    const [tenant, settings] = await inOrder([
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } }),
      tx.tenantSettings.findUnique({ where: { tenantId: ctx.tenantId } }),
    ]);
    return {
      profile: {
        displayName: tenant.displayName,
        legalName: tenant.legalName,
        slug: tenant.slug,
        timezone: tenant.timezone,
        currency: tenant.currency,
        locale: tenant.locale,
        country: tenant.country,
      },
      tax: {
        gstRegistered: settings?.gstRegistered ?? false,
        gstin: settings?.gstin ?? null,
        stateCode: settings?.stateCode ?? null,
        pricesIncludeTax: settings?.pricesIncludeTax ?? true,
      },
      security: { require2faForStaff: settings?.require2faForStaff ?? false },
      logoKey: settings?.logoKey ?? null,
    };
  });
}

export async function updateOrgProfile(
  deps: CoreDeps,
  ctx: AuthContext,
  rawInput: unknown,
) {
  await guard(deps, ctx, { permission: "settings.manage", write: true });
  const input = parseInput(orgProfileSchema, rawInput);
  return inTenant(deps, ctx, async (tx) => {
    const before = await tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    const after = await tx.tenant.update({
      where: { id: ctx.tenantId },
      data: input,
    });
    await recordAudit(tx, ctx, {
      action: "settings.profile_updated",
      entityType: "Tenant",
      entityId: ctx.tenantId,
      before: pick(before, Object.keys(input)),
      after: pick(after, Object.keys(input)),
    });
    return after;
  });
}

export async function updateTaxSettings(
  deps: CoreDeps,
  ctx: AuthContext,
  rawInput: unknown,
) {
  await guard(deps, ctx, { permission: "settings.manage", write: true });
  const input = parseInput(taxSettingsSchema, rawInput);
  return inTenant(deps, ctx, async (tx) => {
    const before = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    const after = await tx.tenantSettings.upsert({
      where: { tenantId: ctx.tenantId },
      create: { tenantId: ctx.tenantId, ...input },
      update: input,
    });
    await recordAudit(tx, ctx, {
      action: "settings.tax_updated",
      entityType: "TenantSettings",
      entityId: ctx.tenantId,
      before: before && pick(before, Object.keys(input)),
      after: pick(after, Object.keys(input)),
    });
    return after;
  });
}

export async function updateSecuritySettings(
  deps: CoreDeps,
  ctx: AuthContext,
  rawInput: unknown,
) {
  await guard(deps, ctx, { permission: "settings.manage", write: true });
  const input = parseInput(securitySettingsSchema, rawInput);
  return inTenant(deps, ctx, async (tx) => {
    const before = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    const after = await tx.tenantSettings.upsert({
      where: { tenantId: ctx.tenantId },
      create: { tenantId: ctx.tenantId, ...input },
      update: input,
    });
    // Security setting: audited in the same transaction.
    await recordAudit(tx, ctx, {
      action: "settings.security_updated",
      entityType: "TenantSettings",
      entityId: ctx.tenantId,
      before: { require2faForStaff: before?.require2faForStaff ?? false },
      after: { require2faForStaff: after.require2faForStaff },
    });
    return after;
  });
}

const logoRequestSchema = z.object({
  contentType: z.enum(Object.keys(LOGO_TYPES) as [keyof typeof LOGO_TYPES]),
  size: z
    .number()
    .int()
    .positive()
    .max(LOGO_MAX_BYTES, "The logo must be 1 MB or smaller."),
});

/** Step 1 of the logo upload: a presigned POST that only accepts this key, type and size. */
export async function createLogoUpload(
  deps: CoreDeps,
  storage: UploadStorage,
  ctx: AuthContext,
  rawInput: unknown,
) {
  await guard(deps, ctx, { permission: "settings.manage", write: true });
  const input = parseInput(logoRequestSchema, rawInput);
  const key = `tenants/${ctx.tenantId}/logo/${randomUUID()}.${LOGO_TYPES[input.contentType]}`;
  const upload = await storage.createUpload({
    key,
    contentType: input.contentType,
    maxBytes: LOGO_MAX_BYTES,
  });
  return { key, ...upload };
}

/** Step 2: verifies the uploaded object, then saves it as the logo. */
export async function confirmLogoUpload(
  deps: CoreDeps,
  storage: UploadStorage,
  ctx: AuthContext,
  rawKey: unknown,
) {
  await guard(deps, ctx, { permission: "settings.manage", write: true });
  const key = parseInput(z.string().max(300), rawKey);
  // Only keys this tenant could have been given in step 1.
  const pattern = new RegExp(
    `^tenants/${ctx.tenantId}/logo/[0-9a-f-]{36}\\.(png|jpg|webp)$`,
  );
  if (!pattern.test(key)) {
    throw new AppError("FORBIDDEN", "That upload does not belong to this gym.");
  }
  const head = await storage.head(key);
  if (!head)
    throw new AppError(
      "NOT_FOUND",
      "The upload did not arrive. Please try again.",
    );
  if (
    head.size > LOGO_MAX_BYTES ||
    !head.contentType ||
    !(head.contentType in LOGO_TYPES)
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Logos must be PNG, JPEG or WebP and at most 1 MB.",
    );
  }
  return inTenant(deps, ctx, async (tx) => {
    const before = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    await tx.tenantSettings.upsert({
      where: { tenantId: ctx.tenantId },
      create: { tenantId: ctx.tenantId, logoKey: key },
      update: { logoKey: key },
    });
    await recordAudit(tx, ctx, {
      action: "settings.logo_updated",
      entityType: "TenantSettings",
      entityId: ctx.tenantId,
      before: { logoKey: before?.logoKey ?? null },
      after: { logoKey: key },
    });
    return { key };
  });
}

function pick<T extends object>(obj: T, keys: string[]): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => keys.includes(key)),
  ) as Partial<T>;
}

const billingSettingsSchema = z.object({
  invoicePrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,4}$/, "1–4 letters or digits, e.g. IT."),
  invoiceDueDays: z.coerce.number().int().min(0).max(90),
  defaultSacCode: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, "SAC codes are 4–8 digits."),
  placeOfSupplyRule: z.enum(["BRANCH_STATE", "MEMBER_STATE"]),
  membershipActivation: z.enum(["FULL_PAYMENT", "ANY_PAYMENT", "IMMEDIATE"]),
  autoApplyCredit: z
    .union([
      z.literal("on"),
      z.literal("true"),
      z.literal("false"),
      z.boolean(),
    ])
    .optional()
    .transform((v) => v === true || v === "on" || v === "true"),
  expiryReminderDays: z
    .string()
    .trim()
    .transform((v, ctx) => {
      const days = v
        ? v
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number)
        : [];
      if (
        days.some((d) => !Number.isInteger(d) || d < 1 || d > 60) ||
        days.length > 5
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Up to 5 whole numbers of days, e.g. 7, 3, 1.",
        });
      }
      return [...new Set(days)].sort((a, b) => b - a);
    }),
  memberSelfSignup: z
    .union([
      z.literal("on"),
      z.literal("true"),
      z.literal("false"),
      z.boolean(),
    ])
    .optional()
    .transform((v) => v === true || v === "on" || v === "true"),
  memberJoinApproval: z
    .union([
      z.literal("on"),
      z.literal("true"),
      z.literal("false"),
      z.boolean(),
    ])
    .optional()
    .transform((v) => v === true || v === "on" || v === "true"),
});

/** Invoice numbering, activation policy, credit, reminders and the member join link. */
export async function updateBillingSettings(
  deps: CoreDeps,
  ctx: AuthContext,
  rawInput: unknown,
) {
  await guard(deps, ctx, { permission: "billing.configure", write: true });
  const input = parseInput(billingSettingsSchema, rawInput);
  return inTenant(deps, ctx, async (tx) => {
    const before = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    const after = await tx.tenantSettings.upsert({
      where: { tenantId: ctx.tenantId },
      create: { tenantId: ctx.tenantId, ...input },
      update: input,
    });
    await recordAudit(tx, ctx, {
      action: "settings.billing_updated",
      entityType: "TenantSettings",
      entityId: ctx.tenantId,
      before: before && pick(before, Object.keys(input)),
      after: pick(after, Object.keys(input)),
    });
    return after;
  });
}

export async function getBillingSettings(deps: CoreDeps, ctx: AuthContext) {
  requirePermission(ctx, "settings.view");
  return inTenant(deps, ctx, async (tx) => ({
    settings: await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    }),
    tenant: await tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
      select: { slug: true },
    }),
  }));
}
