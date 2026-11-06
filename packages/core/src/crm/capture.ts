import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@gym/db";
import { withTenant } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { checkEntitlement } from "../entitlements";
import { AppError } from "../errors";
import { entitlementsFor, inTenant, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";
import { contactSchema, createLeadTx } from "./leads";
import { API_KEY_SCOPES, cleanUtm, parseApiKey } from "./rules";
import { crmGuard, ensureCrmDefaults } from "./setup";

const optionalUuid = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.uuid().optional(),
);
const FORM_FIELDS = ["email", "interest", "preferredTime", "message"] as const;

// --- capture forms (staff setup) -------------------------------------------------------------------

const formSchema = z.object({
  name: z.string().trim().min(2, "Name the form.").max(60),
  branchId: z.uuid("Pick a branch."),
  title: z.string().trim().min(2, "Give it a heading.").max(80),
  intro: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v) => v || null),
  fields: z.preprocess(
    (v) => (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]),
    z.array(z.enum(FORM_FIELDS)).max(4),
  ),
  consentText: z.string().trim().min(10, "Say what they agree to.").max(500),
  marketingText: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v) => v || null),
  thankYou: z.string().trim().min(2, "Write a thank-you message.").max(300),
  sourceId: optionalUuid,
  campaignId: optionalUuid,
  embedOrigins: z
    .string()
    .optional()
    .transform((v, c) => {
      const list = (v ?? "")
        .split(/[\s,]+/)
        .map((s) => s.trim().replace(/\/$/, ""))
        .filter(Boolean);
      for (const o of list)
        if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o))
          c.addIssue({
            code: "custom",
            message: `"${o}" isn't a site address like https://www.mygym.in`,
          });
      return list.slice(0, 10);
    }),
});

export const DEFAULT_CONSENT_TEXT =
  "I agree that {gym} may contact me by phone, WhatsApp or email about my enquiry and membership.";

export async function listCaptureForms(deps: CoreDeps, ctx: AuthContext) {
  await crmGuard(deps, ctx, "crm.configure");
  return inTenant(deps, ctx, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    const forms = await tx.leadCaptureForm.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        branch: { select: { name: true } },
        _count: { select: { leads: true } },
      },
    });
    return { tenantSlug: tenant.slug, forms };
  });
}

export async function getCaptureForm(
  deps: CoreDeps,
  ctx: AuthContext,
  formId: string,
) {
  await crmGuard(deps, ctx, "crm.configure");
  return inTenant(deps, ctx, async (tx) => {
    const form = await tx.leadCaptureForm.findUnique({ where: { id: formId } });
    if (!form) throw new AppError("NOT_FOUND", "Form not found.");
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    return { form, tenantSlug: tenant.slug };
  });
}

export async function saveCaptureForm(
  deps: CoreDeps,
  ctx: AuthContext,
  formId: string | null,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  const input = parseInput(formSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    await ensureCrmDefaults(tx, ctx.tenantId);
    const branch = await tx.branch.findUnique({
      where: { id: input.branchId },
    });
    if (!branch || branch.status !== "ACTIVE")
      throw new AppError("VALIDATION_FAILED", "Pick a branch.", {
        fields: { branchId: ["Pick a branch."] },
      });
    if (
      input.sourceId &&
      !(await tx.leadSource.findUnique({ where: { id: input.sourceId } }))
    )
      throw new AppError("VALIDATION_FAILED", "Pick a source.");
    if (
      input.campaignId &&
      !(await tx.campaign.findUnique({ where: { id: input.campaignId } }))
    )
      throw new AppError("VALIDATION_FAILED", "Pick a campaign.");
    const data = {
      name: input.name,
      branchId: input.branchId,
      title: input.title,
      intro: input.intro,
      fields: input.fields,
      consentText: input.consentText,
      marketingText: input.marketingText,
      thankYou: input.thankYou,
      sourceId: input.sourceId ?? null,
      campaignId: input.campaignId ?? null,
      embedOrigins: input.embedOrigins,
    };
    if (formId) {
      const existing = await tx.leadCaptureForm.findUnique({
        where: { id: formId },
      });
      if (!existing || existing.archivedAt)
        throw new AppError("NOT_FOUND", "Form not found.");
      const form = await tx.leadCaptureForm.update({
        where: { id: formId },
        data,
      });
      await recordAudit(tx, ctx, {
        action: "crm.form_updated",
        entityType: "LeadCaptureForm",
        entityId: form.id,
        after: data,
      });
      return form;
    }
    const form = await tx.leadCaptureForm.create({
      data: {
        tenantId: ctx.tenantId,
        key: randomBytes(9).toString("base64url"),
        createdById: ctx.userId,
        ...data,
      },
    });
    await recordAudit(tx, ctx, {
      action: "crm.form_created",
      entityType: "LeadCaptureForm",
      entityId: form.id,
      after: data,
    });
    return form;
  });
}

export async function archiveCaptureForm(
  deps: CoreDeps,
  ctx: AuthContext,
  formId: string,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  return inTenant(deps, ctx, async (tx) => {
    const form = await tx.leadCaptureForm.findUnique({ where: { id: formId } });
    if (!form) throw new AppError("NOT_FOUND", "Form not found.");
    await tx.leadCaptureForm.update({
      where: { id: form.id },
      data: { archivedAt: new Date() },
    });
    await recordAudit(tx, ctx, {
      action: "crm.form_archived",
      entityType: "LeadCaptureForm",
      entityId: form.id,
    });
  });
}

// --- public form --------------------------------------------------------------------------------------

type FormRow = {
  tenant_id: string;
  form_id: string;
  branch_id: string;
  tenant_name: string;
};

async function lookupForm(db: PrismaClient, tenantSlug: string, key: string) {
  if (
    !/^[a-z0-9-]{2,63}$/.test(tenantSlug) ||
    !/^[A-Za-z0-9_-]{8,20}$/.test(key)
  )
    return null;
  const [row] = await db.$queryRaw<FormRow[]>`
    SELECT tenant_id::text, form_id::text, branch_id::text, tenant_name FROM app.capture_form_lookup(${tenantSlug}, ${key})`;
  return row ?? null;
}

async function crmOn(
  deps: Pick<CoreDeps, "db" | "entitlements">,
  tenantId: string,
) {
  try {
    checkEntitlement(await entitlementsFor(deps, tenantId), "crm.enabled");
    return true;
  } catch {
    return false;
  }
}

/** What the public page shows. Null = 404 (unknown, archived, other gym, or CRM off). */
export async function publicFormView(
  deps: Pick<CoreDeps, "db" | "entitlements">,
  tenantSlug: string,
  key: string,
) {
  const row = await lookupForm(deps.db, tenantSlug, key);
  if (!row || !(await crmOn(deps, row.tenant_id))) return null;
  return withTenant(deps.db, row.tenant_id, async (tx) => {
    const form = await tx.leadCaptureForm.findUniqueOrThrow({
      where: { id: row.form_id },
      include: { branch: { select: { name: true } } },
    });
    return {
      tenantName: row.tenant_name,
      branchName: form.branch.name,
      title: form.title,
      intro: form.intro,
      fields: form.fields as (typeof FORM_FIELDS)[number][],
      consentText: form.consentText.replaceAll("{gym}", row.tenant_name),
      marketingText:
        form.marketingText?.replaceAll("{gym}", row.tenant_name) ?? null,
      thankYou: form.thankYou,
      embedOrigins: form.embedOrigins,
    };
  });
}

const publicSubmitSchema = contactSchema.and(
  z.object({
    preferredTime: z.string().trim().max(80).optional(),
    message: z.string().trim().max(1000).optional(),
    consent: z.literal("on", {
      error: "Please tick the box to agree to be contacted.",
    }),
    marketing: z.union([z.literal("on"), z.literal("")]).optional(),
  }),
);

export type PublicSubmitResult =
  { ok: true; thankYou: string } | { ok: false; status: 404 };

/**
 * A website visitor submits a hosted/embedded form. The tenant and branch come only from the
 * form key (a branch or tenant in the body is ignored). Honeypot hits look like success but
 * store nothing. The route rate-limits per IP and per form before calling this.
 */
export async function submitPublicForm(
  deps: Pick<CoreDeps, "db" | "entitlements" | "now">,
  input: {
    tenantSlug: string;
    key: string;
    body: Record<string, unknown>;
    honeypot?: string | null;
    captcha?: { verify: () => Promise<boolean> };
  },
): Promise<PublicSubmitResult> {
  const row = await lookupForm(deps.db, input.tenantSlug, input.key);
  if (!row || !(await crmOn(deps, row.tenant_id)))
    return { ok: false, status: 404 };
  const view = await publicFormView(deps, input.tenantSlug, input.key);
  if (!view) return { ok: false, status: 404 };
  if (input.honeypot) return { ok: true, thankYou: view.thankYou };
  if (input.captcha && !(await input.captcha.verify()))
    throw new AppError(
      "VALIDATION_FAILED",
      "Please confirm you're not a robot.",
    );
  const data = parseInput(publicSubmitSchema, input.body);
  const utm = cleanUtm(input.body);
  const referrer =
    typeof input.body.referrer === "string"
      ? input.body.referrer.slice(0, 300)
      : null;
  const now = deps.now ? deps.now() : new Date();
  await withTenant(deps.db, row.tenant_id, async (tx) => {
    const form = await tx.leadCaptureForm.findUniqueOrThrow({
      where: { id: row.form_id },
    });
    const interest = [
      data.interest,
      data.preferredTime ? `Preferred time: ${data.preferredTime}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    await createLeadTx(
      tx,
      { system: true, tenantId: row.tenant_id },
      row.tenant_id,
      {
        branchId: row.branch_id,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        email: data.email,
        interest: interest || null,
        sourceId: form.sourceId,
        campaignId: form.campaignId,
        utm,
        referrer,
        ownerUserId: null,
        captureFormId: form.id,
        consentText: view.consentText,
        marketingConsent: data.marketing === "on" && !!view.marketingText,
        note: data.message ? `Message: ${data.message}` : null,
      },
      "FORM",
      now,
    );
  });
  return { ok: true, thankYou: view.thankYou };
}

// --- API keys -------------------------------------------------------------------------------------------

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export async function listApiKeys(deps: CoreDeps, ctx: AuthContext) {
  await crmGuard(deps, ctx, "crm.configure");
  return inTenant(deps, ctx, (tx) =>
    tx.tenantApiKey.findMany({
      orderBy: [
        { revokedAt: { sort: "asc", nulls: "first" } },
        { createdAt: "desc" },
      ],
      include: { branch: { select: { name: true } } },
      omit: { secretHash: true },
    }),
  );
}

/** Returns the full key once; only its prefix and a hash are stored. */
export async function createApiKey(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  const input = parseInput(
    z.object({
      name: z.string().trim().min(2, "Name the key, e.g. 'Website'.").max(60),
      branchId: z.uuid("Pick the branch its leads go to."),
    }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const branch = await tx.branch.findUnique({
      where: { id: input.branchId },
    });
    if (!branch || branch.status !== "ACTIVE")
      throw new AppError("VALIDATION_FAILED", "Pick a branch.");
    const prefix = randomBytes(9)
      .toString("base64url")
      .replace(/[^A-Za-z0-9]/g, "")
      .padEnd(12, "x")
      .slice(0, 12);
    const secret = randomBytes(24).toString("base64url");
    const row = await tx.tenantApiKey.create({
      data: {
        tenantId: ctx.tenantId,
        name: input.name,
        prefix,
        secretHash: sha256(secret),
        scopes: [...API_KEY_SCOPES],
        branchId: branch.id,
        createdById: ctx.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: "api_key.created",
      entityType: "TenantApiKey",
      entityId: row.id,
      after: { name: input.name, prefix, branchId: branch.id },
    });
    return { id: row.id, key: `gk_${prefix}_${secret}` };
  });
}

export async function revokeApiKey(
  deps: CoreDeps,
  ctx: AuthContext,
  keyId: string,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  return inTenant(deps, ctx, async (tx) => {
    const key = await tx.tenantApiKey.findUnique({ where: { id: keyId } });
    if (!key) throw new AppError("NOT_FOUND", "Key not found.");
    if (key.revokedAt) return;
    await tx.tenantApiKey.update({
      where: { id: key.id },
      data: { revokedAt: new Date(), revokedById: ctx.userId },
    });
    await recordAudit(tx, ctx, {
      action: "api_key.revoked",
      entityType: "TenantApiKey",
      entityId: key.id,
      meta: { prefix: key.prefix },
    });
  });
}

// --- public API: POST /api/public/v1/leads ---------------------------------------------------------------

export const apiLeadSchema = z
  .object({
    first_name: z.string().trim().min(1).max(60),
    last_name: z.string().trim().max(60).optional(),
    phone: z.string().trim().max(20).optional(),
    email: z.string().trim().max(200).optional(),
    interest: z.string().trim().max(300).optional(),
    message: z.string().trim().max(1000).optional(),
    source: z.string().trim().max(60).optional(),
    campaign: z.string().trim().max(120).optional(),
    utm_source: z.string().trim().max(120).optional(),
    utm_medium: z.string().trim().max(120).optional(),
    utm_campaign: z.string().trim().max(120).optional(),
    utm_term: z.string().trim().max(120).optional(),
    utm_content: z.string().trim().max(120).optional(),
    referrer: z.string().trim().max(300).optional(),
    consent: z.object({
      given: z.literal(true, {
        error: "consent.given must be true: the person agreed to be contacted.",
      }),
      text: z.string().trim().min(10).max(500),
      marketing: z.boolean().optional(),
    }),
  })
  .strict();

export type ApiResult = { status: number; body: Record<string, unknown> };

/**
 * The website enquiry API. Key → tenant + branch (the body can't choose another gym or branch).
 * Errors use the stable error codes; nothing about other tenants or the key's validity leaks
 * beyond 401.
 */
export async function apiCreateLead(
  deps: Pick<CoreDeps, "db" | "entitlements" | "now">,
  input: {
    authorization: string | null;
    body: unknown;
    idempotencyKey: string | null;
  },
): Promise<ApiResult> {
  const bearer =
    /^Bearer\s+(.+)$/i.exec(input.authorization ?? "")?.[1] ?? null;
  const parsedKey = parseApiKey(bearer);
  const unauthorized: ApiResult = {
    status: 401,
    body: {
      error: { code: "AUTH_REQUIRED", message: "Missing or invalid API key." },
    },
  };
  if (!parsedKey) return unauthorized;
  const [key] = await deps.db.$queryRaw<
    {
      tenant_id: string;
      key_id: string;
      secret_hash: string;
      scopes: string[];
      branch_id: string;
      revoked: boolean;
      tenant_active: boolean;
    }[]
  >`SELECT tenant_id::text, key_id::text, secret_hash, scopes, branch_id::text, revoked, tenant_active FROM app.api_key_lookup(${parsedKey.prefix})`;
  const given = Buffer.from(sha256(parsedKey.secret));
  if (
    !key ||
    key.revoked ||
    !timingSafeEqual(given, Buffer.from(key.secret_hash))
  )
    return unauthorized;
  if (!key.scopes.includes("leads.create"))
    return {
      status: 403,
      body: {
        error: { code: "FORBIDDEN", message: "This key can't create leads." },
      },
    };
  if (!key.tenant_active || !(await crmOn(deps, key.tenant_id)))
    return {
      status: 402,
      body: {
        error: {
          code: "ENTITLEMENT_REQUIRED",
          message: "Leads aren't available on this account.",
        },
      },
    };
  if (
    input.idempotencyKey &&
    !/^[A-Za-z0-9_.:-]{8,100}$/.test(input.idempotencyKey)
  )
    return {
      status: 422,
      body: {
        error: {
          code: "VALIDATION_FAILED",
          message:
            "Idempotency-Key: 8–100 letters, digits, '_', '-', '.', ':'.",
        },
      },
    };
  const parsed = apiLeadSchema.safeParse(input.body);
  if (!parsed.success)
    return {
      status: 422,
      body: {
        error: {
          code: "VALIDATION_FAILED",
          message: "Check the fields.",
          fields: z.flattenError(parsed.error).fieldErrors,
        },
      },
    };
  const b = parsed.data;
  const contact = contactSchema.safeParse({
    firstName: b.first_name,
    lastName: b.last_name,
    phone: b.phone,
    email: b.email,
    interest: b.interest,
  });
  if (!contact.success)
    return {
      status: 422,
      body: {
        error: {
          code: "VALIDATION_FAILED",
          message: "Check the contact details.",
          fields: z.flattenError(contact.error).fieldErrors,
        },
      },
    };
  const now = deps.now ? deps.now() : new Date();
  const requestHash = sha256(JSON.stringify(b));
  return withTenant(deps.db, key.tenant_id, async (tx) => {
    if (input.idempotencyKey) {
      const seen = await tx.idempotencyRecord.findUnique({
        where: {
          tenantId_scope_key: {
            tenantId: key.tenant_id,
            scope: "api.leads.create",
            key: input.idempotencyKey,
          },
        },
      });
      if (seen && seen.expiresAt > now) {
        if (seen.requestHash !== requestHash)
          return {
            status: 409,
            body: {
              error: {
                code: "CONFLICT",
                message:
                  "This Idempotency-Key was used with a different request.",
              },
            },
          };
        return {
          status: 200,
          body: {
            ...(seen.response as Record<string, unknown>),
            replayed: true,
          },
        };
      }
    }
    const sourceRow = b.source
      ? await tx.leadSource.findFirst({
          where: {
            code: b.source.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
            archivedAt: null,
          },
        })
      : null;
    const campaignRow = b.campaign
      ? await tx.campaign.findFirst({
          where: {
            code: { equals: b.campaign, mode: "insensitive" },
            archivedAt: null,
          },
        })
      : null;
    const result = await createLeadTx(
      tx,
      { system: true, tenantId: key.tenant_id },
      key.tenant_id,
      {
        branchId: key.branch_id,
        firstName: contact.data.firstName,
        lastName: contact.data.lastName,
        phone: contact.data.phone,
        email: contact.data.email,
        interest: contact.data.interest,
        sourceId: sourceRow?.id ?? null,
        campaignId: campaignRow?.id ?? null,
        utm: cleanUtm(b),
        referrer: b.referrer ?? null,
        ownerUserId: null,
        captureFormId: null,
        consentText: b.consent.text,
        marketingConsent: b.consent.marketing === true,
        note: b.message ? `Message: ${b.message}` : null,
      },
      "API",
      now,
    );
    await tx.tenantApiKey.update({
      where: { id: key.key_id },
      data: { lastUsedAt: now },
    });
    const response = { id: result.lead.id, created: result.created };
    if (input.idempotencyKey)
      await tx.idempotencyRecord.upsert({
        where: {
          tenantId_scope_key: {
            tenantId: key.tenant_id,
            scope: "api.leads.create",
            key: input.idempotencyKey,
          },
        },
        create: {
          tenantId: key.tenant_id,
          scope: "api.leads.create",
          key: input.idempotencyKey,
          requestHash,
          response,
          expiresAt: new Date(now.getTime() + 24 * 3_600_000),
        },
        update: {
          requestHash,
          response,
          expiresAt: new Date(now.getTime() + 24 * 3_600_000),
        },
      });
    return { status: result.created ? 201 : 200, body: response };
  });
}
