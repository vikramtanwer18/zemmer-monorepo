import type { Prisma, TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  requirePermission,
  type AuthContext,
} from "../authz";
import { invoiceBalances } from "../billing/service";
import { classCreditsOf } from "../credits/ledger";
import { AppError } from "../errors";
import { emitEvent } from "../events";
import { maskPhone } from "../messaging/rules";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import {
  addDays,
  diffDays,
  fromDbDate,
  toDbDate,
  todayIn,
  type LocalDate,
} from "../time/dates";
import { parseInput } from "../validation";
import {
  flagReason,
  RECOVERY_WINDOW_DAYS,
  RETENTION_KINDS,
  RETENTION_RULES,
  UNUSED_CREDITS_WINDOW_DAYS,
  visitDrop,
  type RetentionKind,
} from "./rules";

const DAY = 86_400_000;

export async function ensureRetentionRulesTx(
  tx: TenantTransaction,
  tenantId: string,
) {
  await tx.retentionRule.createMany({
    data: RETENTION_KINDS.map((kind) => ({
      tenantId,
      kind,
      threshold: RETENTION_RULES[kind].defaultThreshold,
    })),
    skipDuplicates: true,
  });
  return tx.retentionRule.findMany({ orderBy: { kind: "asc" } });
}

export async function getRetentionRules(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "retention.view" });
  return inTenant(deps, ctx, async (tx) => {
    const rules = await ensureRetentionRulesTx(tx, ctx.tenantId);
    return RETENTION_KINDS.map((kind) => {
      const r = rules.find((x) => x.kind === kind)!;
      return {
        kind,
        enabled: r.enabled,
        threshold: r.threshold,
        ...RETENTION_RULES[kind],
      };
    });
  });
}

const ruleInput = (k: RetentionKind) =>
  z.object({
    enabled: z.preprocess(
      (v) => v === true || v === "on" || v === "true",
      z.boolean(),
    ),
    threshold: z.coerce
      .number()
      .int()
      .min(RETENTION_RULES[k].min)
      .max(RETENTION_RULES[k].max),
  });
const rulesSchema = z.object({
  NO_VISIT: ruleInput("NO_VISIT"),
  VISIT_DROP: ruleInput("VISIT_DROP"),
  EXPIRING: ruleInput("EXPIRING"),
  OVERDUE: ruleInput("OVERDUE"),
  UNUSED_CREDITS: ruleInput("UNUSED_CREDITS"),
  TRIAL_FOLLOW_UP: ruleInput("TRIAL_FOLLOW_UP"),
});

/** Gym-wide thresholds; owners/admins (settings.manage). */
export async function saveRetentionRules(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "settings.manage", write: true });
  const input = parseInput(rulesSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    await ensureRetentionRulesTx(tx, ctx.tenantId);
    for (const kind of RETENTION_KINDS)
      await tx.retentionRule.update({
        where: { tenantId_kind: { tenantId: ctx.tenantId, kind } },
        data: input[kind],
      });
    await recordAudit(tx, ctx, {
      action: "retention.rules_updated",
      entityType: "RetentionRule",
      after: input,
    });
  });
}

// --- nightly computation ------------------------------------------------------------------------

type Hit = {
  kind: RetentionKind;
  memberId: string | null;
  leadId: string | null;
  branchId: string | null;
  reason: string;
  details: Record<string, number | string | null>;
};

async function activeMemberships(tx: TenantTransaction) {
  return tx.membership.findMany({
    where: {
      status: "ACTIVE",
      member: { status: "ACTIVE", anonymizedAt: null },
    },
    select: {
      id: true,
      memberId: true,
      branchId: true,
      startDate: true,
      endDate: true,
      plan: { select: { entitlements: true } },
    },
  });
}

/** Pure-ish: which members/leads each enabled rule flags today. Reads only. */
export async function retentionHitsTx(
  tx: TenantTransaction,
  today: LocalDate,
  now: Date,
): Promise<Hit[]> {
  const rules = await tx.retentionRule.findMany({ where: { enabled: true } });
  const rule = (k: RetentionKind) => rules.find((r) => r.kind === k);
  const hits: Hit[] = [];
  const memberships = await activeMemberships(tx);
  const byMember = new Map<string, (typeof memberships)[number]>();
  for (const m of memberships)
    if (
      !byMember.has(m.memberId) ||
      byMember.get(m.memberId)!.endDate < m.endDate
    )
      byMember.set(m.memberId, m);
  const memberIds = [...byMember.keys()];

  const noVisit = rule("NO_VISIT");
  const drop = rule("VISIT_DROP");
  if ((noVisit || drop) && memberIds.length) {
    const last = await tx.attendanceEvent.groupBy({
      by: ["memberId"],
      where: {
        memberId: { in: memberIds },
        result: "ACCEPTED",
        voidedAt: null,
      },
      _max: { occurredAt: true },
    });
    const lastBy = new Map(last.map((l) => [l.memberId!, l._max.occurredAt]));
    if (noVisit)
      for (const [memberId, m] of byMember) {
        const at = lastBy.get(memberId) ?? null;
        const startedDays = diffDays(fromDbDate(m.startDate), today);
        const days = at
          ? Math.floor((now.getTime() - at.getTime()) / DAY)
          : null;
        if (
          (days !== null && days >= noVisit.threshold) ||
          (days === null && startedDays >= noVisit.threshold)
        )
          hits.push({
            kind: "NO_VISIT",
            memberId,
            leadId: null,
            branchId: m.branchId,
            reason: flagReason("NO_VISIT", noVisit.threshold, { days }),
            details: { days, lastVisit: at?.toISOString() ?? null },
          });
      }
    if (drop) {
      const recent = await tx.attendanceEvent.groupBy({
        by: ["memberId"],
        where: {
          memberId: { in: memberIds },
          result: "ACCEPTED",
          voidedAt: null,
          occurredAt: { gte: new Date(now.getTime() - 14 * DAY) },
        },
        _count: { _all: true },
      });
      const previous = await tx.attendanceEvent.groupBy({
        by: ["memberId"],
        where: {
          memberId: { in: memberIds },
          result: "ACCEPTED",
          voidedAt: null,
          occurredAt: {
            gte: new Date(now.getTime() - 42 * DAY),
            lt: new Date(now.getTime() - 14 * DAY),
          },
        },
        _count: { _all: true },
      });
      const recentBy = new Map(recent.map((r) => [r.memberId!, r._count._all]));
      for (const p of previous) {
        const r = recentBy.get(p.memberId!) ?? 0;
        const d = visitDrop(r, p._count._all);
        if (d && d.dropPercent >= drop.threshold)
          hits.push({
            kind: "VISIT_DROP",
            memberId: p.memberId!,
            leadId: null,
            branchId: byMember.get(p.memberId!)?.branchId ?? null,
            reason: flagReason("VISIT_DROP", drop.threshold, {
              recent: r,
              expected: d.expected,
              dropPercent: d.dropPercent,
            }),
            details: {
              recent: r,
              previous28: p._count._all,
              dropPercent: d.dropPercent,
            },
          });
      }
    }
  }

  const expiring = rule("EXPIRING");
  const credits = rule("UNUSED_CREDITS");
  if (expiring || credits) {
    const horizon = Math.max(
      expiring?.threshold ?? 0,
      credits ? UNUSED_CREDITS_WINDOW_DAYS : 0,
    );
    const soon = memberships.filter((m) => {
      const left = diffDays(today, fromDbDate(m.endDate));
      return left >= 0 && left <= horizon;
    });
    for (const m of soon) {
      const left = diffDays(today, fromDbDate(m.endDate));
      const renewed = await tx.membership.count({
        where: {
          memberId: m.memberId,
          id: { not: m.id },
          status: { in: ["ACTIVE", "PAUSED", "PENDING_PAYMENT"] },
          endDate: { gt: m.endDate },
        },
      });
      if (renewed) continue;
      if (expiring && left <= expiring.threshold)
        hits.push({
          kind: "EXPIRING",
          memberId: m.memberId,
          leadId: null,
          branchId: m.branchId,
          reason: flagReason("EXPIRING", expiring.threshold, { days: left }),
          details: { days: left, membershipId: m.id },
        });
      const granted = classCreditsOf(m.plan.entitlements);
      if (credits && granted && left <= UNUSED_CREDITS_WINDOW_DAYS) {
        const ledger = await tx.entitlementLedger.findMany({
          where: { membershipId: m.id, kind: "CLASS_CREDIT" },
          select: { delta: true, reason: true },
        });
        const sum =
          ledger.reduce((s, l) => s + l.delta, 0) +
          (ledger.some((l) => l.reason === "GRANT") ? 0 : granted);
        if (sum >= credits.threshold)
          hits.push({
            kind: "UNUSED_CREDITS",
            memberId: m.memberId,
            leadId: null,
            branchId: m.branchId,
            reason: flagReason("UNUSED_CREDITS", credits.threshold, {
              credits: sum,
              days: left,
            }),
            details: { credits: sum, days: left, membershipId: m.id },
          });
      }
    }
  }

  const overdue = rule("OVERDUE");
  if (overdue) {
    const invoices = await tx.gymInvoice.findMany({
      where: {
        status: { in: ["ISSUED", "PARTIALLY_PAID"] },
        dueDate: { lte: toDbDate(addDays(today, -overdue.threshold)) },
      },
      select: {
        id: true,
        number: true,
        memberId: true,
        branchId: true,
        dueDate: true,
      },
      orderBy: { dueDate: "asc" },
    });
    const balances = await invoiceBalances(
      tx,
      invoices.map((i) => i.id),
    );
    const seen = new Set<string>();
    for (const i of invoices) {
      const out = balances.get(i.id)?.outstandingMinor ?? 0;
      if (out <= 0 || seen.has(i.memberId)) continue;
      seen.add(i.memberId);
      const days = diffDays(fromDbDate(i.dueDate), today);
      hits.push({
        kind: "OVERDUE",
        memberId: i.memberId,
        leadId: null,
        branchId: i.branchId,
        reason: flagReason("OVERDUE", overdue.threshold, {
          number: i.number,
          days,
        }),
        details: { invoiceId: i.id, days, outstandingMinor: out },
      });
    }
  }

  const trial = rule("TRIAL_FOLLOW_UP");
  if (trial) {
    const trials = await tx.trialBooking.findMany({
      where: {
        status: "ATTENDED",
        attendedAt: {
          lte: new Date(now.getTime() - trial.threshold * DAY),
          gte: new Date(now.getTime() - 30 * DAY),
        },
        lead: { status: "OPEN" },
      },
      select: {
        id: true,
        attendedAt: true,
        leadId: true,
        lead: { select: { branchId: true, lastContactedAt: true } },
      },
      orderBy: { attendedAt: "desc" },
    });
    const seen = new Set<string>();
    for (const t of trials) {
      if (
        seen.has(t.leadId) ||
        (t.lead.lastContactedAt && t.lead.lastContactedAt > t.attendedAt!)
      )
        continue;
      seen.add(t.leadId);
      const days = Math.floor((now.getTime() - t.attendedAt!.getTime()) / DAY);
      hits.push({
        kind: "TRIAL_FOLLOW_UP",
        memberId: null,
        leadId: t.leadId,
        branchId: t.lead.branchId,
        reason: flagReason("TRIAL_FOLLOW_UP", trial.threshold, { days }),
        details: { trialId: t.id, days },
      });
    }
  }
  return hits;
}

/**
 * Nightly per tenant: opens new flags (one open per person and rule; emits retention.flagged),
 * resolves flags whose rule no longer fires, and records recovery outcomes.
 */
export async function runRetentionTx(
  tx: TenantTransaction,
  tenantId: string,
  today: LocalDate,
  now: Date,
) {
  await ensureRetentionRulesTx(tx, tenantId);
  const hits = await retentionHitsTx(tx, today, now);
  let opened = 0;
  for (const h of hits) {
    const created = await tx.retentionFlag.createMany({
      data: [
        {
          tenantId,
          kind: h.kind,
          memberId: h.memberId,
          leadId: h.leadId,
          branchId: h.branchId,
          reason: h.reason,
          details: h.details as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) {
      // Still flagged: keep the reason current ("No visit for 18 days").
      await tx.retentionFlag.updateMany({
        where: {
          kind: h.kind,
          status: { in: ["OPEN", "ACTIONED"] },
          ...(h.memberId ? { memberId: h.memberId } : { leadId: h.leadId }),
        },
        data: { reason: h.reason, details: h.details as Prisma.InputJsonValue },
      });
      continue;
    }
    opened++;
    const flag = await tx.retentionFlag.findFirstOrThrow({
      where: {
        kind: h.kind,
        status: "OPEN",
        ...(h.memberId ? { memberId: h.memberId } : { leadId: h.leadId }),
      },
      select: { id: true },
    });
    await emitEvent(tx, tenantId, "retention.flagged", {
      flagId: flag.id,
      kind: h.kind,
      memberId: h.memberId,
      leadId: h.leadId,
      branchId: h.branchId,
    });
  }
  const key = (k: string, m: string | null, l: string | null) =>
    `${k}:${m ?? l}`;
  const live = new Set(hits.map((h) => key(h.kind, h.memberId, h.leadId)));
  const open = await tx.retentionFlag.findMany({
    where: { status: { in: ["OPEN", "ACTIONED"] } },
  });
  let resolved = 0;
  for (const f of open) {
    if (live.has(key(f.kind, f.memberId, f.leadId))) continue;
    const outcome = await outcomeFor(tx, f);
    await tx.retentionFlag.update({
      where: { id: f.id },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        outcome: outcome?.label ?? "Rule no longer applies",
      },
    });
    if (outcome)
      await tx.recoveryOutcome.createMany({
        data: [
          {
            tenantId,
            kind: outcome.kind,
            memberId: f.memberId,
            leadId: f.leadId,
            flagId: f.id,
            refId: outcome.refId,
            amountMinor: outcome.amountMinor,
            occurredAt: outcome.at,
          },
        ],
        skipDuplicates: true,
      });
    resolved++;
  }
  const recoveries = await recordAutomationRecoveriesTx(tx, tenantId, now);
  return { flagged: hits.length, opened, resolved, recoveries };
}

async function outcomeFor(
  tx: TenantTransaction,
  f: {
    id: string;
    kind: string;
    memberId: string | null;
    leadId: string | null;
    createdAt: Date;
  },
): Promise<{
  kind: "RENEWED" | "PAID" | "REACTIVATED" | "CONVERTED";
  refId: string;
  amountMinor: bigint | null;
  at: Date;
  label: string;
} | null> {
  const until = new Date(f.createdAt.getTime() + RECOVERY_WINDOW_DAYS * DAY);
  if (
    f.memberId &&
    ["EXPIRING", "UNUSED_CREDITS", "NO_VISIT", "VISIT_DROP"].includes(f.kind)
  ) {
    const renewal = await tx.membership.findFirst({
      where: {
        memberId: f.memberId,
        activatedAt: { gte: f.createdAt, lte: until },
      },
      orderBy: { activatedAt: "asc" },
    });
    if (renewal)
      return {
        kind: "RENEWED",
        refId: renewal.id,
        amountMinor: renewal.priceMinor - renewal.discountMinor,
        at: renewal.activatedAt!,
        label: "Renewed",
      };
  }
  if (f.memberId && (f.kind === "NO_VISIT" || f.kind === "VISIT_DROP")) {
    const visit = await tx.attendanceEvent.findFirst({
      where: {
        memberId: f.memberId,
        result: "ACCEPTED",
        voidedAt: null,
        occurredAt: { gte: f.createdAt, lte: until },
      },
      orderBy: { occurredAt: "asc" },
    });
    // refId = the flag: one reactivation per flag, however many visits follow.
    if (visit)
      return {
        kind: "REACTIVATED",
        refId: f.id,
        amountMinor: null,
        at: visit.occurredAt,
        label: "Visited again",
      };
  }
  if (f.memberId && f.kind === "OVERDUE") {
    const paid = await tx.gymPayment.aggregate({
      where: {
        memberId: f.memberId,
        status: "SUCCEEDED",
        receivedAt: { gte: f.createdAt, lte: until },
      },
      _sum: { amountMinor: true },
      _max: { receivedAt: true },
    });
    if (paid._sum.amountMinor && paid._sum.amountMinor > 0n)
      return {
        kind: "PAID",
        refId: f.id,
        amountMinor: paid._sum.amountMinor,
        at: paid._max.receivedAt!,
        label: "Paid",
      };
  }
  if (f.leadId && f.kind === "TRIAL_FOLLOW_UP") {
    const lead = await tx.lead.findUnique({
      where: { id: f.leadId },
      select: { status: true, wonAt: true },
    });
    if (
      lead?.status === "WON" &&
      lead.wonAt &&
      lead.wonAt >= f.createdAt &&
      lead.wonAt <= until
    )
      return {
        kind: "CONVERTED",
        refId: f.leadId,
        amountMinor: null,
        at: lead.wonAt,
        label: "Became a member",
      };
  }
  return null;
}

/**
 * Renewals, payments and lead conversions in the last 3 days that followed an automation
 * execution for the same person within RECOVERY_WINDOW_DAYS (associated, not causal). Unique per
 * (kind, refId), so re-running is harmless and a renewal already credited to a flag isn't counted twice.
 */
async function recordAutomationRecoveriesTx(
  tx: TenantTransaction,
  tenantId: string,
  now: Date,
) {
  const since = new Date(now.getTime() - 3 * DAY);
  let n = 0;
  const renewals = await tx.membership.findMany({
    where: { activatedAt: { gte: since } },
    select: {
      id: true,
      memberId: true,
      activatedAt: true,
      priceMinor: true,
      discountMinor: true,
    },
  });
  for (const r of renewals) {
    const exec = await tx.automationExecution.findFirst({
      where: {
        memberId: r.memberId,
        startedAt: {
          lte: r.activatedAt!,
          gte: new Date(r.activatedAt!.getTime() - RECOVERY_WINDOW_DAYS * DAY),
        },
      },
      orderBy: { startedAt: "desc" },
    });
    if (!exec) continue;
    const c = await tx.recoveryOutcome.createMany({
      data: [
        {
          tenantId,
          kind: "RENEWED",
          memberId: r.memberId,
          executionId: exec.id,
          refId: r.id,
          amountMinor: r.priceMinor - r.discountMinor,
          occurredAt: r.activatedAt!,
        },
      ],
      skipDuplicates: true,
    });
    if (c.count === 0)
      await tx.recoveryOutcome.updateMany({
        where: { kind: "RENEWED", refId: r.id, executionId: null },
        data: { executionId: exec.id },
      });
    n += c.count;
  }
  const won = await tx.lead.findMany({
    where: { status: "WON", wonAt: { gte: since } },
    select: { id: true, wonAt: true },
  });
  for (const l of won) {
    const exec = await tx.automationExecution.findFirst({
      where: { leadId: l.id, startedAt: { lte: l.wonAt! } },
      orderBy: { startedAt: "desc" },
    });
    if (!exec) continue;
    const c = await tx.recoveryOutcome.createMany({
      data: [
        {
          tenantId,
          kind: "CONVERTED",
          leadId: l.id,
          executionId: exec.id,
          refId: l.id,
          occurredAt: l.wonAt!,
        },
      ],
      skipDuplicates: true,
    });
    if (c.count === 0)
      await tx.recoveryOutcome.updateMany({
        where: { kind: "CONVERTED", refId: l.id, executionId: null },
        data: { executionId: exec.id },
      });
    n += c.count;
  }
  return n;
}

// --- dashboard ------------------------------------------------------------------------------------

const dashSchema = z.object({
  kind: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(RETENTION_KINDS).optional(),
  ),
  branchId: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.uuid().optional(),
  ),
  status: z.enum(["OPEN", "ACTIONED", "RESOLVED", "DISMISSED"]).default("OPEN"),
});

export async function retentionDashboard(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown = {},
) {
  await guard(deps, ctx, { permission: "retention.view" });
  const f = parseInput(dashSchema, raw);
  const allowed = allowedBranchIds(ctx, "retention.view");
  const now = nowOf(deps);
  const branchWhere = f.branchId
    ? { branchId: f.branchId }
    : allowed === "ALL"
      ? {}
      : { branchId: { in: allowed } };
  return inTenant(deps, ctx, async (tx) => {
    await ensureRetentionRulesTx(tx, ctx.tenantId);
    const statuses =
      f.status === "OPEN"
        ? (["OPEN", "ACTIONED"] as const)
        : ([f.status] as const);
    const counts = await tx.retentionFlag.groupBy({
      by: ["kind"],
      where: { status: { in: [...statuses] }, ...branchWhere },
      _count: { _all: true },
    });
    const flags = await tx.retentionFlag.findMany({
      where: {
        status: { in: [...statuses] },
        ...branchWhere,
        ...(f.kind ? { kind: f.kind } : {}),
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
    });
    const members = await tx.memberProfile.findMany({
      where: {
        id: {
          in: flags.map((x) => x.memberId).filter((v): v is string => !!v),
        },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        memberCode: true,
      },
    });
    const leads = await tx.lead.findMany({
      where: {
        id: { in: flags.map((x) => x.leadId).filter((v): v is string => !!v) },
      },
      select: { id: true, firstName: true, lastName: true, phone: true },
    });
    const since = new Date(now.getTime() - 30 * DAY);
    const outcomes = await tx.recoveryOutcome.groupBy({
      by: ["kind"],
      where: { occurredAt: { gte: since } },
      _count: { _all: true },
      _sum: { amountMinor: true },
    });
    const fromAutomations = await tx.recoveryOutcome.count({
      where: { occurredAt: { gte: since }, executionId: { not: null } },
    });
    const flagged30 = await tx.retentionFlag.count({
      where: { createdAt: { gte: since }, ...branchWhere },
    });
    const resolvedWithOutcome = await tx.retentionFlag.count({
      where: {
        createdAt: { gte: since },
        ...branchWhere,
        outcomes: { some: {} },
      },
    });
    return {
      filters: f,
      counts: Object.fromEntries(
        RETENTION_KINDS.map((k) => [
          k,
          counts.find((c) => c.kind === k)?._count._all ?? 0,
        ]),
      ) as Record<RetentionKind, number>,
      rows: flags.map((x) => {
        const p =
          members.find((m) => m.id === x.memberId) ??
          leads.find((l) => l.id === x.leadId);
        return {
          id: x.id,
          kind: x.kind,
          status: x.status,
          reason: x.reason,
          action: x.action,
          recommended: RETENTION_RULES[x.kind as RetentionKind].action,
          memberId: x.memberId,
          leadId: x.leadId,
          branchId: x.branchId,
          name: p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : "—",
          phone: p?.phone ? maskPhone(p.phone) : null,
          hasPhone: !!p?.phone,
          createdAt: x.createdAt,
          outcome: x.outcome,
        };
      }),
      recovery: {
        days: 30,
        flagged: flagged30,
        recoveredFromFlags: resolvedWithOutcome,
        renewals: outcomes.find((o) => o.kind === "RENEWED")?._count._all ?? 0,
        renewalValueMinor: Number(
          outcomes.find((o) => o.kind === "RENEWED")?._sum.amountMinor ?? 0,
        ),
        overdueRecoveredMinor: Number(
          outcomes.find((o) => o.kind === "PAID")?._sum.amountMinor ?? 0,
        ),
        reactivated:
          outcomes.find((o) => o.kind === "REACTIVATED")?._count._all ?? 0,
        conversions:
          outcomes.find((o) => o.kind === "CONVERTED")?._count._all ?? 0,
        fromAutomations,
      },
    };
  });
}

async function loadFlag(
  tx: TenantTransaction,
  ctx: AuthContext,
  flagId: string,
) {
  const f = await tx.retentionFlag.findUnique({ where: { id: flagId } });
  if (!f) throw new AppError("NOT_FOUND", "Flag not found.");
  requirePermission(ctx, "retention.view", { branchId: f.branchId });
  if (!["OPEN", "ACTIONED"].includes(f.status))
    throw new AppError("CONFLICT", "This flag is closed.");
  return f;
}

/** One-click "create task" from the dashboard. */
export async function createTaskForFlag(
  deps: CoreDeps,
  ctx: AuthContext,
  flagId: string,
  raw: unknown = {},
) {
  await guard(deps, ctx, { permission: "tasks.manage", write: true });
  const input = parseInput(
    z.object({
      dueInHours: z.coerce.number().int().min(0).max(720).default(24),
    }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const f = await loadFlag(tx, ctx, flagId);
    requirePermission(ctx, "tasks.manage", { branchId: f.branchId });
    const branchId =
      f.branchId ??
      (f.memberId
        ? (
            await tx.memberProfile.findUnique({
              where: { id: f.memberId },
              select: { homeBranchId: true },
            })
          )?.homeBranchId
        : null) ??
      (f.leadId
        ? (
            await tx.lead.findUnique({
              where: { id: f.leadId },
              select: { branchId: true },
            })
          )?.branchId
        : null);
    if (!branchId) throw new AppError("CONFLICT", "No branch for this person.");
    const rule = RETENTION_RULES[f.kind as RetentionKind];
    const task = await tx.followUpTask.create({
      data: {
        tenantId: ctx.tenantId,
        branchId,
        kind: "FOLLOW_UP",
        title: `${rule.label}: ${rule.action}`.slice(0, 200),
        notes: f.reason,
        dueAt: new Date(nowOf(deps).getTime() + input.dueInHours * 3600_000),
        assigneeUserId: ctx.userId,
        memberId: f.memberId,
        leadId: f.leadId,
        createdById: ctx.userId,
      },
    });
    await tx.retentionFlag.update({
      where: { id: f.id },
      data: {
        status: "ACTIONED",
        action: "Task created",
        actionedAt: nowOf(deps),
        actionedById: ctx.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: "retention.task_created",
      entityType: "RetentionFlag",
      entityId: f.id,
      branchId,
      meta: { taskId: task.id },
    });
    return { taskId: task.id };
  });
}

export async function dismissFlag(
  deps: CoreDeps,
  ctx: AuthContext,
  flagId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "retention.view", write: true });
  const { reason } = parseInput(
    z.object({ reason: z.string().trim().min(3, "Say why.").max(200) }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const f = await loadFlag(tx, ctx, flagId);
    await tx.retentionFlag.update({
      where: { id: f.id },
      data: {
        status: "DISMISSED",
        outcome: `Dismissed: ${reason}`,
        actionedAt: nowOf(deps),
        actionedById: ctx.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: "retention.flag_dismissed",
      entityType: "RetentionFlag",
      entityId: f.id,
      branchId: f.branchId,
      meta: { reason },
    });
  });
}

export function todayForTenant(timeZone: string, now: Date) {
  return todayIn(timeZone, now);
}
