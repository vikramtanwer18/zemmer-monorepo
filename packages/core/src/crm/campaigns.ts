import { z } from "zod";
import { recordAudit } from "../audit";
import { allowedBranchIds, hasPermission, type AuthContext } from "../authz";
import { AppError } from "../errors";
import { inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { startOfDayUtc, toDbDate, todayIn, addDays } from "../time/dates";
import { parseInput } from "../validation";
import type { Touch } from "./rules";
import { crmGuard, ensureCrmDefaults } from "./setup";

export const CAMPAIGN_CHANNELS = [
  "FACEBOOK",
  "INSTAGRAM",
  "GOOGLE",
  "WHATSAPP",
  "SMS",
  "EMAIL",
  "WEBSITE",
  "FLYER",
  "REFERRAL",
  "EVENT",
  "OTHER",
] as const;

const dateField = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
);

const campaignSchema = z
  .object({
    name: z.string().trim().min(2, "Name the campaign.").max(80),
    channel: z.enum(CAMPAIGN_CHANNELS),
    code: z
      .string()
      .trim()
      .min(2, "Give it a tracking code, e.g. diwali-2026.")
      .max(60)
      .regex(
        /^[A-Za-z0-9_.-]+$/,
        "Letters, digits, '-', '_' and '.' only (used as utm_campaign).",
      ),
    startsOn: dateField,
    endsOn: dateField,
    budget: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().min(0).max(100_000_000).optional(),
    ),
  })
  .refine((v) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn, {
    path: ["endsOn"],
    message: "Ends before it starts.",
  });

export async function saveCampaign(
  deps: CoreDeps,
  ctx: AuthContext,
  campaignId: string | null,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  const input = parseInput(campaignSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    await ensureCrmDefaults(tx, ctx.tenantId);
    const clash = await tx.campaign.findFirst({
      where: {
        code: { equals: input.code, mode: "insensitive" },
        ...(campaignId ? { id: { not: campaignId } } : {}),
      },
    });
    if (clash)
      throw new AppError(
        "VALIDATION_FAILED",
        "Another campaign uses that code.",
        { fields: { code: ["Already used."] } },
      );
    const data = {
      name: input.name,
      channel: input.channel,
      code: input.code,
      startsOn: input.startsOn ? toDbDate(input.startsOn) : null,
      endsOn: input.endsOn ? toDbDate(input.endsOn) : null,
      budgetMinor:
        input.budget !== undefined
          ? BigInt(Math.round(input.budget * 100))
          : null,
    };
    if (campaignId) {
      const existing = await tx.campaign.findUnique({
        where: { id: campaignId },
      });
      if (!existing) throw new AppError("NOT_FOUND", "Campaign not found.");
      await tx.campaign.update({ where: { id: campaignId }, data });
      await recordAudit(tx, ctx, {
        action: "campaign.updated",
        entityType: "Campaign",
        entityId: campaignId,
        after: { ...input },
      });
      return existing;
    }
    const row = await tx.campaign.create({
      data: { tenantId: ctx.tenantId, createdById: ctx.userId, ...data },
    });
    await recordAudit(tx, ctx, {
      action: "campaign.created",
      entityType: "Campaign",
      entityId: row.id,
      after: { ...input },
    });
    return row;
  });
}

export async function archiveCampaign(
  deps: CoreDeps,
  ctx: AuthContext,
  campaignId: string,
) {
  await crmGuard(deps, ctx, "crm.configure", { write: true });
  return inTenant(deps, ctx, async (tx) => {
    const row = await tx.campaign.findUnique({ where: { id: campaignId } });
    if (!row) throw new AppError("NOT_FOUND", "Campaign not found.");
    await tx.campaign.update({
      where: { id: row.id },
      data: { archivedAt: new Date() },
    });
    await recordAudit(tx, ctx, {
      action: "campaign.archived",
      entityType: "Campaign",
      entityId: row.id,
    });
  });
}

export async function listCampaigns(
  deps: CoreDeps,
  ctx: AuthContext,
  options: { includeArchived?: boolean } = {},
) {
  await crmGuard(deps, ctx, "leads.view");
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.campaign.findMany({
      where: options.includeArchived ? {} : { archivedAt: null },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { leads: true } } },
    });
    return rows.map((r) => ({
      ...r,
      budgetMinor: r.budgetMinor === null ? null : Number(r.budgetMinor),
      leads: r._count.leads,
    }));
  });
}

// --- attribution report (docs/KPI_DEFINITIONS.md "CRM") -----------------------------------------------

const reportSchema = z.object({
  from: dateField,
  to: dateField,
  model: z.enum(["LAST", "FIRST"]).default("LAST"),
  groupBy: z.enum(["CAMPAIGN", "SOURCE"]).default("CAMPAIGN"),
  branchId: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.uuid().optional(),
  ),
});

type Row = {
  key: string;
  name: string;
  leads: number;
  contacted: number;
  trialsBooked: number;
  trialsAttended: number;
  won: number;
  revenueMinor: number | null;
  budgetMinor: number | null;
};

/**
 * Cohort report: leads CREATED in [from, to) (tenant timezone), grouped by the campaign/source of
 * their first or last touch; what those leads went on to do (contacted, trial booked/attended,
 * won = paid membership) and the revenue of the membership they bought. Revenue needs
 * reports.financial. Rows read the touch snapshot, so stage renames or edits never break them.
 */
export async function attributionReport(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.view");
  const f = parseInput(reportSchema, raw);
  const now = nowOf(deps);
  const today = todayIn(ctx.timezone, now);
  const fromDate = f.from ?? addDays(today, -29);
  const toDate = f.to ?? addDays(today, 1);
  const from = startOfDayUtc(fromDate, ctx.timezone);
  const to = startOfDayUtc(toDate, ctx.timezone);
  const showMoney = hasPermission(ctx, "reports.financial");
  const allowed = allowedBranchIds(ctx, "leads.view");
  return inTenant(deps, ctx, async (tx) => {
    await ensureCrmDefaults(tx, ctx.tenantId);
    const leads = await tx.lead.findMany({
      where: {
        createdAt: { gte: from, lt: to },
        ...(f.branchId
          ? { branchId: f.branchId }
          : allowed === "ALL"
            ? {}
            : { branchId: { in: allowed } }),
      },
      select: {
        id: true,
        status: true,
        firstTouch: true,
        lastTouch: true,
        firstContactedAt: true,
        convertedMembershipId: true,
        trials: { select: { status: true } },
      },
    });
    const [campaigns, sources] = [
      await tx.campaign.findMany(),
      await tx.leadSource.findMany(),
    ];
    const names = new Map<string, { name: string; budgetMinor: number | null }>(
      [
        ...campaigns.map(
          (c) =>
            [
              c.id,
              {
                name: c.name,
                budgetMinor:
                  c.budgetMinor === null ? null : Number(c.budgetMinor),
              },
            ] as const,
        ),
        ...sources.map(
          (s) => [s.id, { name: s.name, budgetMinor: null }] as const,
        ),
      ],
    );
    const membershipIds = leads
      .map((l) => l.convertedMembershipId)
      .filter((v): v is string => !!v);
    const revenueByMembership = new Map<string, number>();
    if (showMoney && membershipIds.length) {
      const invoices = await tx.gymInvoice.findMany({
        where: { membershipId: { in: membershipIds }, status: { not: "VOID" } },
        select: {
          membershipId: true,
          totalMinor: true,
          creditNotes: { select: { totalMinor: true } },
        },
      });
      for (const inv of invoices) {
        const net =
          Number(inv.totalMinor) -
          inv.creditNotes.reduce((s, c) => s + Number(c.totalMinor), 0);
        revenueByMembership.set(
          inv.membershipId!,
          (revenueByMembership.get(inv.membershipId!) ?? 0) + net,
        );
      }
    }
    const rows = new Map<string, Row>();
    for (const lead of leads) {
      const touch = ((f.model === "FIRST" ? lead.firstTouch : lead.lastTouch) ??
        lead.firstTouch) as Touch | null;
      const id =
        (f.groupBy === "CAMPAIGN" ? touch?.campaignId : touch?.sourceId) ??
        null;
      const key = id ?? "none";
      const row =
        rows.get(key) ??
        ({
          key,
          name: id
            ? (names.get(id)?.name ?? "Deleted")
            : f.groupBy === "CAMPAIGN"
              ? "No campaign"
              : "No source",
          leads: 0,
          contacted: 0,
          trialsBooked: 0,
          trialsAttended: 0,
          won: 0,
          revenueMinor: showMoney ? 0 : null,
          budgetMinor:
            f.groupBy === "CAMPAIGN" && id
              ? (names.get(id)?.budgetMinor ?? null)
              : null,
        } satisfies Row);
      row.leads++;
      if (lead.firstContactedAt) row.contacted++;
      if (lead.trials.some((t) => t.status !== "CANCELLED")) row.trialsBooked++;
      if (lead.trials.some((t) => t.status === "ATTENDED"))
        row.trialsAttended++;
      if (lead.status === "WON") {
        row.won++;
        if (row.revenueMinor !== null && lead.convertedMembershipId)
          row.revenueMinor +=
            revenueByMembership.get(lead.convertedMembershipId) ?? 0;
      }
      rows.set(key, row);
    }
    const list = [...rows.values()].sort(
      (a, b) => b.won - a.won || b.leads - a.leads,
    );
    const total = list.reduce(
      (t, r) => ({
        leads: t.leads + r.leads,
        contacted: t.contacted + r.contacted,
        trialsBooked: t.trialsBooked + r.trialsBooked,
        trialsAttended: t.trialsAttended + r.trialsAttended,
        won: t.won + r.won,
        revenueMinor: showMoney
          ? (t.revenueMinor ?? 0) + (r.revenueMinor ?? 0)
          : null,
      }),
      {
        leads: 0,
        contacted: 0,
        trialsBooked: 0,
        trialsAttended: 0,
        won: 0,
        revenueMinor: showMoney ? 0 : (null as number | null),
      },
    );
    const lost = leads.filter((l) => l.status === "LOST").length;
    return {
      filters: { ...f, from: fromDate, to: toDate },
      // Lead-conversion KPI is final 60 days after the cohort ends (KPI_DEFINITIONS).
      inProgress: to.getTime() > now.getTime() - 60 * 86_400_000,
      showMoney,
      rows: list,
      total,
      lost,
    };
  });
}

/**
 * Trial-to-member rate (KPI): trials ATTENDED in [from, to) whose lead was won within 30 days of
 * the trial, ÷ trials attended in the period.
 */
export async function trialToMemberRate(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.view");
  const f = parseInput(
    reportSchema.pick({ from: true, to: true, branchId: true }),
    raw,
  );
  const today = todayIn(ctx.timezone, nowOf(deps));
  const from = startOfDayUtc(f.from ?? addDays(today, -29), ctx.timezone);
  const to = startOfDayUtc(f.to ?? addDays(today, 1), ctx.timezone);
  const allowed = allowedBranchIds(ctx, "leads.view");
  return inTenant(deps, ctx, async (tx) => {
    const trials = await tx.trialBooking.findMany({
      where: {
        status: "ATTENDED",
        attendedAt: { gte: from, lt: to },
        ...(f.branchId
          ? { branchId: f.branchId }
          : allowed === "ALL"
            ? {}
            : { branchId: { in: allowed } }),
      },
      include: { lead: { select: { status: true, wonAt: true } } },
    });
    const converted = trials.filter(
      (t) =>
        t.lead.status === "WON" &&
        t.lead.wonAt &&
        t.attendedAt &&
        t.lead.wonAt.getTime() - t.attendedAt.getTime() <= 30 * 86_400_000,
    ).length;
    return {
      attended: trials.length,
      converted,
      rate: trials.length ? converted / trials.length : null,
    };
  });
}
