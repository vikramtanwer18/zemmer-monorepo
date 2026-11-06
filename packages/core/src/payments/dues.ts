import type { TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { allowedBranchIds, type AuthContext } from "../authz";
import { invoiceBalances, num } from "../billing/service";
import { memberName } from "../members/service";
import { formatMoney, money } from "../money";
import { notify } from "../notifications";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { fromDbDate, todayIn } from "../time/dates";
import { parseInput } from "../validation";
import {
  agingBucket,
  AGING_BUCKETS,
  daysOverdue,
  duesReminderDue,
  type AgingBucket,
} from "./rules";

/** Members who owe money, with aging (KPI_DEFINITIONS: Outstanding dues). billing.view. */
export async function duesReport(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown = {},
) {
  await guard(deps, ctx, { permission: "billing.view" });
  const { branchId } = parseInput(
    z.object({ branchId: z.uuid().optional() }),
    raw,
  );
  const allowed = allowedBranchIds(ctx, "billing.view");
  const today = todayIn(ctx.timezone, nowOf(deps));
  return inTenant(deps, ctx, async (tx) => {
    const invoices = await tx.gymInvoice.findMany({
      where: {
        status: { in: ["ISSUED", "PARTIALLY_PAID"] },
        ...(branchId
          ? { branchId }
          : allowed === "ALL"
            ? {}
            : { branchId: { in: allowed } }),
      },
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
            phone: true,
          },
        },
      },
      orderBy: { dueDate: "asc" },
      take: 2000,
    });
    const balances = await invoiceBalances(
      tx,
      invoices.map((i) => i.id),
    );
    const totals = Object.fromEntries(
      AGING_BUCKETS.map((b) => [b, 0]),
    ) as Record<AgingBucket, number>;
    const byMember = new Map<
      string,
      {
        member: {
          id: string;
          name: string;
          memberCode: string;
          phone: string | null;
        };
        dueMinor: number;
        oldestDue: string;
        worst: AgingBucket;
        invoices: number;
      }
    >();
    for (const inv of invoices) {
      const out = balances.get(inv.id)?.outstandingMinor ?? 0;
      if (out <= 0) continue;
      const due = fromDbDate(inv.dueDate);
      const bucket = agingBucket(daysOverdue(due, today));
      totals[bucket] += out;
      const row = byMember.get(inv.memberId) ?? {
        member: {
          id: inv.member.id,
          name: memberName(inv.member),
          memberCode: inv.member.memberCode,
          phone: inv.member.phone,
        },
        dueMinor: 0,
        oldestDue: due,
        worst: bucket,
        invoices: 0,
      };
      row.dueMinor += out;
      row.invoices++;
      if (due < row.oldestDue) row.oldestDue = due;
      if (AGING_BUCKETS.indexOf(bucket) > AGING_BUCKETS.indexOf(row.worst))
        row.worst = bucket;
      byMember.set(inv.memberId, row);
    }
    const members = [...byMember.values()].sort((a, b) =>
      a.oldestDue < b.oldestDue ? -1 : 1,
    );
    return {
      today,
      totals,
      totalMinor: Object.values(totals).reduce((s, v) => s + v, 0),
      members: members.map((m) => ({
        ...m,
        daysOverdue: Math.max(daysOverdue(m.oldestDue, today), 0),
      })),
    };
  });
}

/**
 * Daily job: reminds members on the gym's chosen overdue days (email + in-app, service messages:
 * the member's opt-out of optional notices is respected by notify()). Once per invoice per day.
 */
export async function sendDuesReminders(
  tx: TenantTransaction,
  tenantId: string,
  today: string,
) {
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId } });
  const days = settings?.duesReminderDays ?? [1, 7, 14, 30];
  if (days.length === 0) return { reminded: 0 };
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const invoices = await tx.gymInvoice.findMany({
    where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
    include: { member: true },
    take: 2000,
  });
  const balances = await invoiceBalances(
    tx,
    invoices.map((i) => i.id),
  );
  let reminded = 0;
  for (const inv of invoices) {
    const out = balances.get(inv.id)?.outstandingMinor ?? 0;
    if (out <= 0 || inv.member.status !== "ACTIVE") continue;
    const overdue = duesReminderDue(fromDbDate(inv.dueDate), today, days);
    if (overdue === null) continue;
    const r = await notify(tx, tenantId, {
      templateKey: "invoice.overdue",
      recipient: {
        memberId: inv.memberId,
        userId: inv.member.userId,
        email: inv.member.email,
      },
      data: {
        name: inv.member.firstName,
        gym: tenant.displayName,
        amount: formatMoney(money(out, tenant.currency)),
        days: overdue,
      },
      link: "/m/invoices",
      dedupeKey: `overdue:${inv.id}:${overdue}`,
    });
    if (r.inApp === "QUEUED" || r.email === "QUEUED") reminded++;
  }
  if (reminded)
    await recordAudit(
      tx,
      { system: true, tenantId },
      {
        action: "dues.reminders_sent",
        entityType: "GymInvoice",
        meta: { reminded, date: today },
      },
    );
  return { reminded };
}

// --- payment policies (Settings → Payments) ---------------------------------------------------

const policySchema = z.object({
  paymentLinkExpiryDays: z.coerce.number().int().min(1).max(180),
  onlinePartialAllowed: z
    .union([z.boolean(), z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === true || v === "on"),
  /** Rupees. */
  onlineMinPartial: z.coerce.number().min(1).max(1_000_000),
  /** Rupees; empty = no second approval. */
  refundApprovalThreshold: z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.coerce.number().positive().nullable(),
  ),
  duesReminderDays: z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number)
        : v,
    z.array(z.number().int().min(1).max(365)).max(10),
  ),
});

export async function getPaymentPolicies(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "settings.view" });
  return inTenant(deps, ctx, async (tx) => {
    const s = await tx.tenantSettings.findUniqueOrThrow({
      where: { tenantId: ctx.tenantId },
    });
    return {
      paymentLinkExpiryDays: s.paymentLinkExpiryDays,
      onlinePartialAllowed: s.onlinePartialAllowed,
      onlineMinPartialMinor: num(s.onlineMinPartialMinor),
      refundApprovalThresholdMinor:
        s.refundApprovalThresholdMinor === null
          ? null
          : num(s.refundApprovalThresholdMinor),
      duesReminderDays: s.duesReminderDays,
    };
  });
}

export async function updatePaymentPolicies(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "settings.payments", write: true });
  const input = parseInput(policySchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const data = {
      paymentLinkExpiryDays: input.paymentLinkExpiryDays,
      onlinePartialAllowed: input.onlinePartialAllowed,
      onlineMinPartialMinor: BigInt(
        Math.max(Math.round(input.onlineMinPartial * 100), 100),
      ),
      refundApprovalThresholdMinor:
        input.refundApprovalThreshold === null
          ? null
          : BigInt(Math.round(input.refundApprovalThreshold * 100)),
      duesReminderDays: [...new Set(input.duesReminderDays)].sort(
        (a, b) => a - b,
      ),
    };
    await tx.tenantSettings.update({ where: { tenantId: ctx.tenantId }, data });
    await recordAudit(tx, ctx, {
      action: "settings.payments_updated",
      entityType: "TenantSettings",
      entityId: ctx.tenantId,
      after: {
        ...data,
        onlineMinPartialMinor: num(data.onlineMinPartialMinor),
      },
    });
  });
}
