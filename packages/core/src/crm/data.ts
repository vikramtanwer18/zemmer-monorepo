import type { Prisma, TenantTransaction } from "@gym/db";
import { recordAudit } from "../audit";
import { requirePermission, type AuthContext } from "../authz";
import { AppError, isAppError } from "../errors";
import { parseCsv, toCsv } from "../members/csv";
import { inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";
import {
  contactSchema,
  createLeadTx,
  leadListSchema,
  leadName,
  leadWhere,
  type LeadListFilters,
} from "./leads";
import { crmGuard } from "./setup";

export const LEAD_IMPORT_COLUMNS = [
  "first_name",
  "last_name",
  "phone",
  "email",
  "interest",
  "source",
  "campaign",
  "branch_code",
  "owner_email",
  "note",
] as const;
export const LEAD_IMPORT_MAX_ROWS = 5000;

export type LeadImportSummary = {
  dryRun: boolean;
  total: number;
  imported: number;
  merged: number;
  errors: number;
  rows: { row: number; status: "ok" | "merged" | "error"; message?: string }[];
};

class DryRunRollback extends Error {
  constructor(readonly merged: boolean) {
    super("dry run");
  }
}

/**
 * CSV import (worker, as the uploading user). Each row is validated like the staff form and gets
 * its own transaction. A row matching an open lead (phone/email) is merged as a repeat enquiry
 * rather than duplicated. Dry run checks every row, database rules included, then rolls back.
 */
export async function importLeads(
  ctx: AuthContext,
  csv: string,
  options: {
    dryRun: boolean;
    now: Date;
    runRow: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;
  },
): Promise<LeadImportSummary> {
  requirePermission(ctx, "leads.import");
  const [header, ...data] = parseCsv(csv);
  if (!header) throw new AppError("VALIDATION_FAILED", "The file is empty.");
  const columns = header.map((h) => h.trim().toLowerCase());
  for (const required of ["first_name", "branch_code"])
    if (!columns.includes(required))
      throw new AppError(
        "VALIDATION_FAILED",
        `Missing column "${required}". Use the template.`,
      );
  if (data.length > LEAD_IMPORT_MAX_ROWS)
    throw new AppError(
      "VALIDATION_FAILED",
      `At most ${LEAD_IMPORT_MAX_ROWS} rows per file.`,
    );
  const lookups = await options.runRow(async (tx) => ({
    branches: await tx.branch.findMany({ where: { status: "ACTIVE" } }),
    sources: await tx.leadSource.findMany({ where: { archivedAt: null } }),
    campaigns: await tx.campaign.findMany({ where: { archivedAt: null } }),
    staff: await tx.tenantMembership.findMany({
      where: { status: "ACTIVE" },
      include: { user: { select: { email: true } } },
    }),
  }));
  const branchByCode = new Map(
    lookups.branches.map((b) => [b.code.toUpperCase(), b.id]),
  );
  const sourceByKey = new Map(
    lookups.sources.flatMap(
      (s) =>
        [
          [s.code, s.id],
          [s.name.toLowerCase(), s.id],
        ] as const,
    ),
  );
  const campaignByKey = new Map(
    lookups.campaigns.flatMap(
      (c) =>
        [
          [c.code.toLowerCase(), c.id],
          [c.name.toLowerCase(), c.id],
        ] as const,
    ),
  );
  const staffByEmail = new Map(
    lookups.staff.map((s) => [s.user.email.toLowerCase(), s.userId]),
  );
  const summary: LeadImportSummary = {
    dryRun: options.dryRun,
    total: data.length,
    imported: 0,
    merged: 0,
    errors: 0,
    rows: [],
  };
  for (const [index, cells] of data.entries()) {
    const rowNumber = index + 2;
    const get = (name: (typeof LEAD_IMPORT_COLUMNS)[number]) => {
      const i = columns.indexOf(name);
      return i >= 0 ? (cells[i] ?? "").trim() : "";
    };
    if (cells.every((c) => !c.trim())) {
      summary.total--;
      continue;
    }
    const error = (message: string) => {
      summary.errors++;
      summary.rows.push({ row: rowNumber, status: "error", message });
    };
    const branchId = branchByCode.get(get("branch_code").toUpperCase());
    if (!branchId) {
      error(`Unknown branch code "${get("branch_code")}".`);
      continue;
    }
    const contact = contactSchema.safeParse({
      firstName: get("first_name"),
      lastName: get("last_name") || undefined,
      phone: get("phone") || undefined,
      email: get("email") || undefined,
      interest: get("interest") || undefined,
    });
    if (!contact.success) {
      error(contact.error.issues.map((i) => i.message).join(" "));
      continue;
    }
    const sourceKey = get("source").toLowerCase();
    const sourceId = sourceKey
      ? (sourceByKey.get(sourceKey) ??
        sourceByKey.get(sourceKey.replace(/[^a-z0-9]+/g, "_")))
      : undefined;
    if (sourceKey && !sourceId) {
      error(`Unknown source "${get("source")}".`);
      continue;
    }
    const campaignId = get("campaign")
      ? campaignByKey.get(get("campaign").toLowerCase())
      : undefined;
    if (get("campaign") && !campaignId) {
      error(`Unknown campaign "${get("campaign")}".`);
      continue;
    }
    const ownerUserId = get("owner_email")
      ? staffByEmail.get(get("owner_email").toLowerCase())
      : undefined;
    if (get("owner_email") && !ownerUserId) {
      error(`"${get("owner_email")}" isn't a staff member here.`);
      continue;
    }
    try {
      const merged = await options.runRow(async (tx) => {
        const result = await createLeadTx(
          tx,
          ctx,
          ctx.tenantId,
          {
            branchId,
            ...contact.data,
            sourceId: sourceId ?? null,
            campaignId: campaignId ?? null,
            utm: {},
            referrer: null,
            ownerUserId: ownerUserId ?? null,
            captureFormId: null,
            consentText: null,
            marketingConsent: false,
            note: get("note") || null,
          },
          "IMPORT",
          options.now,
        );
        if (options.dryRun) throw new DryRunRollback(!result.created);
        return !result.created;
      });
      if (merged) summary.merged++;
      else summary.imported++;
      summary.rows.push({ row: rowNumber, status: merged ? "merged" : "ok" });
    } catch (err) {
      if (err instanceof DryRunRollback) {
        if (err.merged) summary.merged++;
        else summary.imported++;
        summary.rows.push({
          row: rowNumber,
          status: err.merged ? "merged" : "ok",
        });
      } else if (
        isAppError(err) &&
        (err.code === "VALIDATION_FAILED" || err.code === "FORBIDDEN")
      ) {
        error(
          err.fields ? Object.values(err.fields).flat().join(" ") : err.message,
        );
      } else throw err;
    }
  }
  return summary;
}

/** CSV of leads matching the list filters (worker; permission and audit). */
export async function exportLeadsCsv(
  tx: TenantTransaction,
  ctx: AuthContext,
  filters: LeadListFilters,
) {
  requirePermission(ctx, "leads.export");
  const rows = await tx.lead.findMany({
    where: leadWhere(ctx, filters, {}),
    orderBy: { createdAt: "desc" },
    take: 20_000,
    include: {
      stage: true,
      source: true,
      campaign: true,
      branch: true,
      lostReason: true,
    },
  });
  const staff = await tx.tenantMembership.findMany({
    include: { user: { select: { name: true } } },
  });
  const names = new Map(staff.map((s) => [s.userId, s.user.name]));
  const csv = toCsv([
    [
      "name",
      "phone",
      "email",
      "status",
      "stage",
      "source",
      "campaign",
      "branch",
      "owner",
      "score",
      "created_at",
      "first_contacted_at",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "lost_reason",
      "marketing_consent",
    ],
    ...rows.map((l) => [
      leadName(l),
      l.phone,
      l.email,
      l.status,
      l.stage.name,
      l.source?.name ?? "",
      l.campaign?.name ?? "",
      l.branch.name,
      l.ownerUserId ? (names.get(l.ownerUserId) ?? "") : "",
      l.score,
      l.createdAt.toISOString(),
      l.firstContactedAt?.toISOString() ?? "",
      l.utmSource,
      l.utmMedium,
      l.utmCampaign,
      l.lostReason?.name ?? "",
      l.marketingConsent ? "yes" : "no",
    ]),
  ]);
  await recordAudit(tx, ctx, {
    action: "leads.exported",
    entityType: "Lead",
    meta: { count: rows.length, filters },
  });
  return { csv, count: rows.length };
}

/** Staff: queue an export of the current list filters. */
export async function requestLeadExport(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.export", { write: true });
  const filters = parseInput(leadListSchema, raw);
  return inTenant(deps, ctx, (tx) =>
    tx.dataJob.create({
      data: {
        tenantId: ctx.tenantId,
        kind: "LEAD_EXPORT",
        createdById: ctx.userId,
        params: filters as Prisma.InputJsonValue,
      },
    }),
  );
}

/** Staff: register an uploaded CSV (already in storage under this gym's prefix) and queue the import. */
export async function registerLeadImport(
  deps: CoreDeps,
  ctx: AuthContext,
  input: { key: string; filename: string; size: number; dryRun: boolean },
) {
  await crmGuard(deps, ctx, "leads.import", { write: true });
  if (
    !new RegExp(`^tenants/${ctx.tenantId}/imports/[0-9a-f-]{36}\\.csv$`).test(
      input.key,
    )
  )
    throw new AppError("FORBIDDEN", "That upload does not belong to this gym.");
  if (input.size > 5 * 1024 * 1024)
    throw new AppError(
      "VALIDATION_FAILED",
      "Upload a CSV file of at most 5 MB.",
    );
  return inTenant(deps, ctx, async (tx) => {
    const file = await tx.fileRecord.create({
      data: {
        tenantId: ctx.tenantId,
        key: input.key,
        filename: input.filename.slice(0, 120),
        contentType: "text/csv",
        size: input.size,
        purpose: "IMPORT",
        scanStatus: "SKIPPED",
        uploadedByUserId: ctx.userId,
        expiresAt: new Date(nowOf(deps).getTime() + 7 * 86_400_000),
      },
    });
    return tx.dataJob.create({
      data: {
        tenantId: ctx.tenantId,
        kind: "LEAD_IMPORT",
        dryRun: input.dryRun,
        inputFileId: file.id,
        createdById: ctx.userId,
      },
    });
  });
}

/** Re-run a successful dry run for real (same file). */
export async function confirmLeadImport(
  deps: CoreDeps,
  ctx: AuthContext,
  jobId: string,
) {
  await crmGuard(deps, ctx, "leads.import", { write: true });
  return inTenant(deps, ctx, async (tx) => {
    const dry = await tx.dataJob.findUnique({ where: { id: jobId } });
    if (
      !dry ||
      dry.kind !== "LEAD_IMPORT" ||
      !dry.dryRun ||
      dry.status !== "SUCCEEDED" ||
      !dry.inputFileId
    )
      throw new AppError("CONFLICT", "Run a successful check first.");
    return tx.dataJob.create({
      data: {
        tenantId: ctx.tenantId,
        kind: "LEAD_IMPORT",
        dryRun: false,
        inputFileId: dry.inputFileId,
        createdById: ctx.userId,
      },
    });
  });
}

export async function listLeadDataJobs(deps: CoreDeps, ctx: AuthContext) {
  await crmGuard(deps, ctx, "leads.view");
  return inTenant(deps, ctx, (tx) =>
    tx.dataJob.findMany({
      where: {
        kind: { in: ["LEAD_IMPORT", "LEAD_EXPORT"] },
        createdById: ctx.userId,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  );
}
