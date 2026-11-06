import { withTenant, type Prisma, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import { currentAccountTx } from "../messaging/accounts";
import { factsForSubjectTx } from "../messaging/facts";
import {
  messagingLimitCount,
  renderTemplateBody,
  templateParameters,
} from "../messaging/rules";
import { queueMessageTx } from "../messaging/send";
import {
  resolveVariables,
  unmappedVariables,
  variableMapSchema,
  type VariableMap,
} from "../messaging/variables";
import { normalizePhone } from "../members/service";
import { inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { localDateTimeToUtc } from "../time/dates";
import { parseInput } from "../validation";
import { segmentDefinitionSchema } from "./segment-dsl";
import { audienceTx, growthGuard, reachabilityTx } from "./segments";

/**
 * Sending an M5 campaign to a saved audience on WhatsApp (M6 §4). Recipients are taken at send
 * time (a scheduled campaign reaches whoever matches when it starts); every message passes the
 * consent/suppression gate when the worker sends it, so a STOP after scheduling still wins.
 */

const configureSchema = z.object({
  segmentId: z.uuid({ message: "Pick an audience." }),
  templateId: z.uuid({ message: "Pick a template." }),
  variableMap: z.preprocess(
    (v) => (typeof v === "string" ? JSON.parse(v || "{}") : v),
    variableMapSchema,
  ),
  throttlePerMinute: z.coerce.number().int().min(1).max(1000).default(60),
  attributionDays: z.coerce.number().int().min(1).max(90).default(14),
});

async function loadCampaign(tx: TenantTransaction, campaignId: string) {
  const c = await tx.campaign.findUnique({ where: { id: campaignId } });
  if (!c || c.archivedAt)
    throw new AppError("NOT_FOUND", "Campaign not found.");
  return c;
}

export async function configureCampaignSend(
  deps: CoreDeps,
  ctx: AuthContext,
  campaignId: string,
  raw: unknown,
) {
  await growthGuard(deps, ctx, true);
  const input = parseInput(configureSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const c = await loadCampaign(tx, campaignId);
    if (!["NONE", "DRAFT"].includes(c.sendStatus))
      throw new AppError("CONFLICT", "This campaign was already launched.");
    const [segment, template] = [
      await tx.segment.findUnique({ where: { id: input.segmentId } }),
      await tx.messageTemplate.findUnique({ where: { id: input.templateId } }),
    ];
    if (!segment || segment.archivedAt)
      throw new AppError("VALIDATION_FAILED", "Pick an audience.", {
        fields: { segmentId: ["Not found."] },
      });
    if (!template || template.status !== "APPROVED")
      throw new AppError("VALIDATION_FAILED", "Pick an approved template.", {
        fields: { templateId: ["Not approved."] },
      });
    const missing = unmappedVariables(template.variables, input.variableMap);
    if (missing.length)
      throw new AppError(
        "VALIDATION_FAILED",
        `Fill every placeholder: ${missing.map((m) => `{{${m}}}`).join(", ")}.`,
        {
          fields: { variableMap: ["Incomplete."] },
        },
      );
    await tx.campaign.update({
      where: { id: c.id },
      data: {
        segmentId: segment.id,
        templateId: template.id,
        variableMap: input.variableMap as unknown as Prisma.InputJsonValue,
        throttlePerMinute: input.throttlePerMinute,
        attributionDays: input.attributionDays,
        sendStatus: "DRAFT",
      },
    });
    await recordAudit(tx, ctx, {
      action: "campaign.send_configured",
      entityType: "Campaign",
      entityId: c.id,
      after: {
        segmentId: segment.id,
        template: template.name,
        throttlePerMinute: input.throttlePerMinute,
      },
    });
  });
}

/** Shown on the launch confirmation: recipients, how many are reachable, category, a preview. */
export async function estimateCampaign(
  deps: CoreDeps,
  ctx: AuthContext,
  campaignId: string,
) {
  await growthGuard(deps, ctx);
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const c = await loadCampaign(tx, campaignId);
    if (!c.segmentId || !c.templateId)
      throw new AppError("CONFLICT", "Choose the audience and template first.");
    const segment = await tx.segment.findUniqueOrThrow({
      where: { id: c.segmentId },
    });
    const template = await tx.messageTemplate.findUniqueOrThrow({
      where: { id: c.templateId },
    });
    const audience = await audienceTx(
      tx,
      segmentDefinitionSchema.parse(segment.definition),
      { now, timeZone: ctx.timezone },
    );
    const reach = await reachabilityTx(tx, audience, 2000);
    const first = audience[0];
    const facts = first
      ? await factsForSubjectTx(tx, ctx.tenantId, first, now)
      : {};
    const values = resolveVariables(
      (c.variableMap ?? {}) as VariableMap,
      facts,
    );
    return {
      recipients: audience.length,
      reachable:
        template.category === "MARKETING"
          ? reach.marketingReachable
          : reach.serviceReachable,
      suppressed: reach.suppressed,
      estimated: reach.estimated,
      category: template.category,
      template: {
        id: template.id,
        name: template.name,
        language: template.language,
        status: template.status,
      },
      segment: { id: segment.id, name: segment.name },
      preview: renderTemplateBody(
        template.bodyText,
        templateParameters(
          template.variables,
          template.parameterFormat,
          values,
        ),
      ),
      throttlePerMinute: c.throttlePerMinute,
      minutes: Math.ceil(audience.length / c.throttlePerMinute),
    };
  });
}

const launchSchema = z.object({
  /** Local date-time in the gym's timezone ("2026-11-06T09:30"); empty = send now. */
  scheduledAt: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      .optional(),
  ),
  /** The count the person saw on the confirmation; must be confirmed explicitly. */
  confirmRecipients: z.coerce.number().int().min(0),
});

export async function launchCampaign(
  deps: CoreDeps,
  ctx: AuthContext,
  campaignId: string,
  raw: unknown,
) {
  await growthGuard(deps, ctx, true);
  const input = parseInput(launchSchema, raw);
  const now = nowOf(deps);
  const scheduledAt = input.scheduledAt
    ? localDateTimeToUtc(input.scheduledAt, ctx.timezone)
    : now;
  if (scheduledAt.getTime() < now.getTime() - 60_000)
    throw new AppError("VALIDATION_FAILED", "That time has passed.", {
      fields: { scheduledAt: ["In the past."] },
    });
  return inTenant(deps, ctx, async (tx) => {
    const c = await loadCampaign(tx, campaignId);
    if (c.sendStatus !== "DRAFT")
      throw new AppError(
        "CONFLICT",
        "Set up the audience and template first (or it's already launched).",
      );
    if (!(await currentAccountTx(tx)))
      throw new AppError("CONFLICT", "Connect WhatsApp first.");
    const template = await tx.messageTemplate.findUnique({
      where: { id: c.templateId! },
    });
    if (!template || template.status !== "APPROVED")
      throw new AppError("CONFLICT", "The template is no longer approved.");
    await tx.campaign.update({
      where: { id: c.id },
      data: {
        sendStatus: "SCHEDULED",
        scheduledAt,
        launchedAt: now,
        launchedById: ctx.userId,
        estimatedRecipients: input.confirmRecipients,
      },
    });
    await recordAudit(tx, ctx, {
      action: "campaign.launched",
      entityType: "Campaign",
      entityId: c.id,
      after: {
        scheduledAt: scheduledAt.toISOString(),
        estimatedRecipients: input.confirmRecipients,
        template: template.name,
        category: template.category,
      },
    });
    return { scheduledAt };
  });
}

export async function cancelCampaign(
  deps: CoreDeps,
  ctx: AuthContext,
  campaignId: string,
) {
  await growthGuard(deps, ctx, true);
  return inTenant(deps, ctx, async (tx) => {
    const c = await loadCampaign(tx, campaignId);
    if (!["SCHEDULED", "SENDING", "DRAFT"].includes(c.sendStatus))
      throw new AppError("CONFLICT", "Nothing to cancel.");
    await tx.campaign.update({
      where: { id: c.id },
      data: { sendStatus: "CANCELLED", cancelledAt: nowOf(deps) },
    });
    const pending = await tx.campaignRecipient.updateMany({
      where: { campaignId: c.id, status: "PENDING" },
      data: { status: "SKIPPED", skipReason: "CAMPAIGN_CANCELLED" },
    });
    const queued = await tx.outboundMessage.updateMany({
      where: { campaignId: c.id, status: "QUEUED" },
      data: { status: "SKIPPED", skipReason: "CAMPAIGN_CANCELLED" },
    });
    await tx.campaignRecipient.updateMany({
      where: {
        campaignId: c.id,
        status: "QUEUED",
        outboundMessage: { status: "SKIPPED" },
      },
      data: { status: "SKIPPED", skipReason: "CAMPAIGN_CANCELLED" },
    });
    await recordAudit(tx, ctx, {
      action: "campaign.cancelled",
      entityType: "Campaign",
      entityId: c.id,
      meta: { pending: pending.count, queued: queued.count },
    });
    return { pending: pending.count, queued: queued.count };
  });
}

/** To staff numbers only (typed in by the sender). Consent doesn't apply; suppression does. */
export async function testSendCampaign(
  deps: CoreDeps,
  ctx: AuthContext,
  campaignId: string,
  raw: unknown,
) {
  await growthGuard(deps, ctx, true);
  const { phones } = parseInput(
    z.object({
      phones: z
        .string()
        .transform((v) => v.split(/[,\s]+/).filter(Boolean))
        .pipe(
          z
            .array(z.string())
            .min(1, "Add a staff number.")
            .max(5, "Up to 5 numbers."),
        ),
    }),
    raw,
  );
  const normalized = phones.map((p) => normalizePhone(p));
  if (normalized.some((p) => !p))
    throw new AppError("VALIDATION_FAILED", "Enter valid mobile numbers.", {
      fields: { phones: ["Invalid number."] },
    });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const c = await loadCampaign(tx, campaignId);
    if (!c.templateId)
      throw new AppError("CONFLICT", "Choose the template first.");
    const facts = await factsForSubjectTx(tx, ctx.tenantId, {}, now);
    const values = resolveVariables((c.variableMap ?? {}) as VariableMap, {
      first_name: "Test",
      full_name: "Test Member",
      ...facts,
    });
    const ids: string[] = [];
    for (const phone of normalized as string[]) {
      const r = await queueMessageTx(tx, ctx.tenantId, {
        kind: "TEMPLATE",
        templateId: c.templateId,
        values,
        toPhone: phone,
        purpose: "TEST",
        campaignId: c.id,
        idempotencyKey: `test:${c.id}:${phone}:${Math.floor(now.getTime() / 60_000)}`,
        createdById: ctx.userId,
      });
      if (!r.queued)
        throw new AppError(
          "CONFLICT",
          r.reason === "NO_ACCOUNT"
            ? "Connect WhatsApp first."
            : "Template not found.",
        );
      ids.push(r.id);
    }
    await recordAudit(tx, ctx, {
      action: "campaign.test_sent",
      entityType: "Campaign",
      entityId: c.id,
      meta: { count: ids.length },
    });
    return { ids };
  });
}

// --- worker: dispatch -------------------------------------------------------------------------

/**
 * Every minute per tenant: start due campaigns (take the audience now) and release the next
 * batch of recipients, at most `throttlePerMinute` per campaign and never past the number's
 * 24-hour messaging-limit tier. Idempotent per recipient (`campaign:<recipientId>`).
 */
export async function dispatchCampaigns(deps: CoreDeps, tenantId: string) {
  const now = nowOf(deps);
  const result = { started: 0, queued: 0, completed: 0 };
  const due = await withTenant(deps.db, tenantId, (tx) =>
    tx.campaign.findMany({
      where: {
        OR: [
          { sendStatus: "SCHEDULED", scheduledAt: { lte: now } },
          { sendStatus: "SENDING" },
        ],
      },
      orderBy: { scheduledAt: "asc" },
    }),
  );
  for (const c of due) {
    if (c.sendStatus === "SCHEDULED") {
      await withTenant(deps.db, tenantId, async (tx) => {
        const fresh = await tx.campaign.findUnique({ where: { id: c.id } });
        if (fresh?.sendStatus !== "SCHEDULED") return;
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { timezone: true },
        });
        const segment = c.segmentId
          ? await tx.segment.findUnique({ where: { id: c.segmentId } })
          : null;
        const def = segment
          ? segmentDefinitionSchema.safeParse(segment.definition)
          : null;
        const audience = def?.success
          ? await audienceTx(tx, def.data, { now, timeZone: tenant.timezone })
          : [];
        for (let i = 0; i < audience.length; i += 1000)
          await tx.campaignRecipient.createMany({
            data: audience.slice(i, i + 1000).map((a) => ({
              tenantId,
              campaignId: c.id,
              memberId: a.memberId,
              leadId: a.leadId,
              phone: a.phone,
              name: a.name,
            })),
            skipDuplicates: true,
          });
        await tx.campaign.update({
          where: { id: c.id },
          data: { sendStatus: "SENDING" },
        });
      });
      result.started++;
    }
    const released = await releaseBatch(deps, tenantId, c.id, now);
    result.queued += released.queued;
    if (released.completed) result.completed++;
  }
  return result;
}

async function releaseBatch(
  deps: CoreDeps,
  tenantId: string,
  campaignId: string,
  now: Date,
) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id: campaignId } });
    if (!c || c.sendStatus !== "SENDING")
      return { queued: 0, completed: false };
    const account = await currentAccountTx(tx);
    const tierLimit = messagingLimitCount(account?.messagingLimit);
    let capacity = c.throttlePerMinute;
    if (tierLimit !== null) {
      const reached = await tx.outboundMessage.findMany({
        where: {
          kind: "TEMPLATE",
          status: { in: ["SENDING", "SENT", "DELIVERED", "READ"] },
          queuedAt: { gte: new Date(now.getTime() - 86_400_000) },
        },
        distinct: ["toPhone"],
        select: { toPhone: true },
      });
      capacity = Math.min(capacity, Math.max(0, tierLimit - reached.length));
    }
    const batch = capacity
      ? await tx.campaignRecipient.findMany({
          where: { campaignId, status: "PENDING" },
          orderBy: { createdAt: "asc" },
          take: capacity,
        })
      : [];
    const map = (c.variableMap ?? {}) as VariableMap;
    let queued = 0;
    for (const r of batch) {
      const facts = await factsForSubjectTx(tx, tenantId, r, now);
      const values = resolveVariables(map, facts);
      const q = account
        ? await queueMessageTx(tx, tenantId, {
            kind: "TEMPLATE",
            templateId: c.templateId!,
            values,
            toPhone: r.phone,
            memberId: r.memberId,
            leadId: r.leadId,
            purpose: "CAMPAIGN",
            campaignId,
            idempotencyKey: `campaign:${r.id}`,
            createdById: c.launchedById,
          })
        : ({ queued: false, reason: "NO_ACCOUNT" } as const);
      await tx.campaignRecipient.update({
        where: { id: r.id },
        data: q.queued
          ? {
              status: "QUEUED",
              outboundMessageId: q.id,
              variables: values as Prisma.InputJsonValue,
            }
          : {
              status: "SKIPPED",
              skipReason:
                q.reason === "NO_ACCOUNT"
                  ? "ACCOUNT_INACTIVE"
                  : "TEMPLATE_NOT_APPROVED",
            },
      });
      if (q.queued) queued++;
    }
    const left = await tx.campaignRecipient.count({
      where: { campaignId, status: "PENDING" },
    });
    if (left === 0) {
      await tx.campaign.update({
        where: { id: campaignId },
        data: { sendStatus: "SENT", completedAt: now },
      });
      return { queued, completed: true };
    }
    return { queued, completed: false };
  });
}

// --- stats & attribution (docs/KPI_DEFINITIONS.md "Campaign attribution") ---------------------

export async function campaignStats(
  deps: CoreDeps,
  ctx: AuthContext,
  campaignId: string,
) {
  await growthGuard(deps, ctx);
  return inTenant(deps, ctx, async (tx) => {
    const c = await loadCampaign(tx, campaignId);
    const groups = await tx.campaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(
      groups.map((g) => [g.status, g._count._all]),
    ) as Record<string, number>;
    const skipped = await tx.campaignRecipient.groupBy({
      by: ["skipReason"],
      where: { campaignId, status: { in: ["SKIPPED", "FAILED"] } },
      _count: { _all: true },
    });
    const optedOut = c.launchedAt
      ? await tx.suppressionRecord.count({
          where: {
            channel: "WHATSAPP",
            createdAt: { gte: c.launchedAt },
            address: {
              in: (
                await tx.campaignRecipient.findMany({
                  where: { campaignId },
                  select: { phone: true },
                })
              ).map((r) => r.phone),
            },
          },
        })
      : 0;
    const template = c.templateId
      ? await tx.messageTemplate.findUnique({
          where: { id: c.templateId },
          select: { name: true, category: true },
        })
      : null;
    const segment = c.segmentId
      ? await tx.segment.findUnique({
          where: { id: c.segmentId },
          select: { id: true, name: true },
        })
      : null;
    return {
      campaign: {
        ...c,
        budgetMinor: c.budgetMinor === null ? null : Number(c.budgetMinor),
      },
      template,
      segment,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      pending: counts.PENDING ?? 0,
      queued: counts.QUEUED ?? 0,
      sent: (counts.SENT ?? 0) + (counts.DELIVERED ?? 0) + (counts.READ ?? 0),
      delivered: (counts.DELIVERED ?? 0) + (counts.READ ?? 0),
      read: counts.READ ?? 0,
      failed: counts.FAILED ?? 0,
      skipped: counts.SKIPPED ?? 0,
      skipReasons: skipped.map((s) => ({
        reason: s.skipReason ?? "Unknown",
        count: s._count._all,
      })),
      optedOut,
      attribution: await campaignAttributionTx(
        tx,
        campaignId,
        c.attributionDays,
      ),
    };
  });
}

/**
 * Associated, not causal: recipients whose message was SENT and who, within `days` of the
 * send, started a membership (renewal or new), paid, or (leads) became a member.
 */
export async function campaignAttributionTx(
  tx: TenantTransaction,
  campaignId: string,
  days: number,
) {
  const sent = await tx.campaignRecipient.findMany({
    where: { campaignId, status: { in: ["SENT", "DELIVERED", "READ"] } },
    select: {
      memberId: true,
      leadId: true,
      outboundMessage: { select: { sentAt: true } },
    },
  });
  let renewals = 0;
  let payers = 0;
  let paidMinor = 0;
  let conversions = 0;
  for (const r of sent) {
    const at = r.outboundMessage?.sentAt;
    if (!at) continue;
    const until = new Date(at.getTime() + days * 86_400_000);
    if (r.memberId) {
      const ms = await tx.membership.count({
        where: {
          memberId: r.memberId,
          activatedAt: { gte: at, lte: until },
          status: { in: ["ACTIVE", "PAUSED", "EXPIRED"] },
        },
      });
      if (ms) renewals++;
      const pay = await tx.gymPayment.aggregate({
        where: {
          memberId: r.memberId,
          status: "SUCCEEDED",
          receivedAt: { gte: at, lte: until },
        },
        _sum: { amountMinor: true },
      });
      const amount = Number(pay._sum.amountMinor ?? 0);
      if (amount > 0) {
        payers++;
        paidMinor += amount;
      }
    } else if (r.leadId) {
      const won = await tx.lead.count({
        where: { id: r.leadId, status: "WON", wonAt: { gte: at, lte: until } },
      });
      if (won) conversions++;
    }
  }
  return { days, sent: sent.length, renewals, payers, paidMinor, conversions };
}

export async function listSendableCampaigns(deps: CoreDeps, ctx: AuthContext) {
  await growthGuard(deps, ctx);
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.campaign.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        segment: { select: { name: true } },
        _count: { select: { recipients: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      channel: r.channel,
      sendStatus: r.sendStatus,
      scheduledAt: r.scheduledAt,
      completedAt: r.completedAt,
      segment: r.segment?.name ?? null,
      recipients: r._count.recipients,
      estimatedRecipients: r.estimatedRecipients,
    }));
  });
}
