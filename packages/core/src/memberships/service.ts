import { inOrder, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit, type AuditActor } from "../audit";
import { hasPermission, requirePermission, type AuthContext } from "../authz";
import {
  draftInvoice,
  invoiceBalances,
  issueCreditNoteTx,
  issueInvoiceTx,
  num,
  recordManualRefundTx,
  recordPaymentSchema,
  recordPaymentTx,
  type InvoiceLineInput,
  PAYMENT_METHODS,
} from "../billing/service";
import { AppError } from "../errors";
import { loadMember } from "../members/service";
import { notify } from "../notifications";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import {
  addDays,
  compareDates,
  diffDays,
  fromDbDate,
  isLocalDate,
  todayIn,
  toDbDate,
  type LocalDate,
} from "../time/dates";
import { parseInput } from "../validation";
import { leadForSaleTx } from "../crm/conversion";
import { activatePaidMemberships } from "./activation";
import {
  applyCoupon,
  checkFreeze,
  endDateFor,
  freezeDaysUsed,
  isPastGrace,
  nextState,
  overlaps,
  renewalStart,
  type MembershipStateValue,
} from "./rules";

export * from "./rules";

type Actor = AuditActor & { userId?: string };

/** The state machine's answer as a stable error code (CONFLICT) instead of a RangeError. */
function transition(
  action: Parameters<typeof nextState>[0],
  from: MembershipStateValue,
): MembershipStateValue {
  try {
    return nextState(action, from);
  } catch (err) {
    if (err instanceof RangeError) throw new AppError("CONFLICT", err.message);
    throw err;
  }
}

const dateField = z.string().refine(isLocalDate, "Pick a valid date.");

const paymentNowSchema = z
  .object({
    method: z.enum(PAYMENT_METHODS),
    amountMinor: z.coerce.number().int().positive(),
    reference: z.string().trim().max(100).optional(),
  })
  .optional();

export const saleSchema = z.object({
  memberId: z.uuid(),
  planId: z.uuid("Pick a plan."),
  startDate: dateField.optional(),
  couponCode: z.string().trim().toUpperCase().max(20).optional(),
  branchId: z.uuid().optional(),
  payment: paymentNowSchema,
  /** M5: the lead this sale converts (it becomes WON when the membership activates). */
  leadId: z.preprocess((v) => (v === "" ? undefined : v), z.uuid().optional()),
});

async function membershipEvent(
  tx: TenantTransaction,
  tenantId: string,
  membershipId: string,
  type:
    | "CREATED"
    | "ACTIVATED"
    | "RENEWED"
    | "EXTENDED"
    | "FROZEN"
    | "UNFROZEN"
    | "CANCELLED"
    | "EXPIRED",
  from: MembershipStateValue | null,
  to: MembershipStateValue | null,
  data: Record<string, unknown>,
  actorUserId: string | null,
) {
  await tx.membershipEvent.create({
    data: {
      tenantId,
      membershipId,
      type,
      fromStatus: from,
      toStatus: to,
      data: data as object,
      actorUserId,
    },
  });
}

type SaleQuote = {
  plan: Awaited<
    ReturnType<TenantTransaction["membershipPlan"]["findUniqueOrThrow"]>
  >;
  branchId: string;
  startDate: LocalDate;
  endDate: LocalDate;
  couponId: string | null;
  discountMinor: number;
  lines: InvoiceLineInput[];
  warnings: string[];
};

/** Everything a sale would do, without doing it (also used by preview). */
/** A member buying or renewing for themselves in the app (M4): no staff permissions. */
export type MemberSaleActor = {
  kind: "member";
  tenantId: string;
  userId: string;
  memberId: string;
};

type SaleActor = AuthContext | MemberSaleActor;

const isMemberActor = (a: SaleActor): a is MemberSaleActor =>
  "kind" in a && a.kind === "member";

async function quoteSale(
  tx: TenantTransaction,
  ctx: SaleActor,
  input: z.infer<typeof saleSchema>,
  today: LocalDate,
  options: { renewedFrom?: { endDate: LocalDate } } = {},
): Promise<SaleQuote> {
  const member = isMemberActor(ctx)
    ? await tx.memberProfile.findUniqueOrThrow({ where: { id: ctx.memberId } })
    : await loadMember(tx, ctx, input.memberId, "memberships.sell");
  if (member.status !== "ACTIVE")
    throw new AppError("CONFLICT", "Only active members can buy a membership.");
  const plan = await tx.membershipPlan.findUnique({
    where: { id: input.planId },
    include: { branches: true },
  });
  if (!plan || plan.status !== "ACTIVE")
    throw new AppError("VALIDATION_FAILED", "Pick an active plan.", {
      fields: { planId: ["Pick an active plan."] },
    });
  const branchId = isMemberActor(ctx)
    ? member.homeBranchId
    : (input.branchId ?? ctx.activeBranchId ?? member.homeBranchId);
  if (isMemberActor(ctx)) {
    // Members may buy only plans the gym offers online; a renewal keeps their own plan.
    if (!options.renewedFrom && !plan.onlinePurchase)
      throw new AppError("FORBIDDEN", "This plan can't be bought in the app.");
    if (input.couponCode)
      throw new AppError(
        "VALIDATION_FAILED",
        "Coupons are applied at the front desk.",
      );
  } else requirePermission(ctx, "memberships.sell", { branchId });
  if (
    plan.branches.length > 0 &&
    !plan.branches.some((b) => b.branchId === branchId)
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      "This plan isn't sold at this branch.",
      { fields: { planId: ["Not sold at this branch."] } },
    );
  }
  const startDate = options.renewedFrom
    ? renewalStart(options.renewedFrom.endDate, today)
    : (input.startDate ?? today);
  if (compareDates(startDate, today) < 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The start date can't be in the past.",
      { fields: { startDate: ["Can't be in the past."] } },
    );
  }
  const endDate = endDateFor(startDate, {
    unit: plan.durationUnit,
    count: plan.durationCount,
  });
  const warnings: string[] = [];

  if (!plan.allowAddOn) {
    const running = await tx.membership.findMany({
      where: {
        memberId: member.id,
        status: { in: ["PENDING_PAYMENT", "ACTIVE", "PAUSED"] },
        plan: { allowAddOn: false },
      },
    });
    const clash = running.find((m) =>
      overlaps(
        { start: fromDbDate(m.startDate), end: fromDbDate(m.endDate) },
        { start: startDate, end: endDate },
      ),
    );
    if (clash) {
      throw new AppError(
        "CONFLICT",
        `This member already has a membership until ${fromDbDate(clash.endDate)}. Renew it, or start the new one after it ends.`,
        {
          fields: {
            startDate: [
              `Overlaps a membership ending ${fromDbDate(clash.endDate)}.`,
            ],
          },
        },
      );
    }
  }

  let discountMinor = 0;
  let couponId: string | null = null;
  if (input.couponCode) {
    const coupon = await tx.coupon.findUnique({
      where: {
        tenantId_code: { tenantId: ctx.tenantId, code: input.couponCode },
      },
    });
    if (!coupon)
      throw new AppError(
        "VALIDATION_FAILED",
        "That coupon code doesn't exist.",
        { fields: { couponCode: ["Unknown coupon."] } },
      );
    const check = applyCoupon(
      {
        kind: coupon.kind,
        value: coupon.value,
        validFrom: coupon.validFrom ? fromDbDate(coupon.validFrom) : null,
        validTo: coupon.validTo ? fromDbDate(coupon.validTo) : null,
        maxRedemptions: coupon.maxRedemptions,
        redemptions: coupon.redemptions,
        planCodes: coupon.planCodes,
        status: coupon.status,
      },
      plan.code,
      num(plan.priceMinor),
      today,
    );
    if (!check.ok)
      throw new AppError("VALIDATION_FAILED", check.reason, {
        fields: { couponCode: [check.reason] },
      });
    discountMinor = check.discountMinor;
    couponId = coupon.id;
  }

  const lines: InvoiceLineInput[] = [
    {
      kind: "MEMBERSHIP",
      description: `${plan.name} membership, ${startDate} to ${endDate}`,
      sacCode: plan.sacCode,
      unitPriceMinor: num(plan.priceMinor),
      discountMinor,
      rateBps: plan.taxRateBps,
    },
  ];
  // Joining fee: only on a member's first ever membership (renewals and re-joins don't pay it).
  if (num(plan.joiningFeeMinor) > 0 && !options.renewedFrom) {
    const previous = await tx.membership.count({
      where: { memberId: member.id, status: { not: "CANCELLED" } },
    });
    if (previous === 0) {
      lines.push({
        kind: "JOINING_FEE",
        description: "Joining fee",
        sacCode: plan.sacCode,
        unitPriceMinor: num(plan.joiningFeeMinor),
        rateBps: plan.taxRateBps,
      });
    } else {
      warnings.push("No joining fee: the member has had a membership before.");
    }
  }
  return {
    plan,
    branchId,
    startDate,
    endDate,
    couponId,
    discountMinor,
    lines,
    warnings,
  };
}

export async function previewSale(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "memberships.sell" });
  const input = parseInput(saleSchema, raw);
  const today = todayIn(ctx.timezone, nowOf(deps));
  return inTenant(deps, ctx, async (tx) => {
    const quote = await quoteSale(tx, ctx, input, today);
    const draft = await draftInvoice(tx, ctx.tenantId, {
      branchId: quote.branchId,
      memberId: input.memberId,
      lines: quote.lines,
    });
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    return {
      plan: { id: quote.plan.id, name: quote.plan.name },
      startDate: quote.startDate,
      endDate: quote.endDate,
      discountMinor: quote.discountMinor,
      draft,
      activation: settings?.membershipActivation ?? "FULL_PAYMENT",
      warnings: quote.warnings,
    };
  });
}

async function redeemCoupon(tx: TenantTransaction, couponId: string) {
  // Conditional increment: two concurrent sales can't both take the last redemption.
  const updated = await tx.$executeRaw`
    UPDATE app.coupon SET redemptions = redemptions + 1
     WHERE id = ${couponId}::uuid AND (max_redemptions IS NULL OR redemptions < max_redemptions)`;
  if (updated !== 1)
    throw new AppError("CONFLICT", "This coupon has just been used up.", {
      fields: { couponCode: ["Used up."] },
    });
}

async function createMembershipTx(
  tx: TenantTransaction,
  ctx: Pick<AuthContext, "tenantId" | "userId">,
  quote: SaleQuote,
  memberId: string,
  today: LocalDate,
  renewedFromId: string | null,
  leadId: string | null = null,
) {
  if (quote.couponId) await redeemCoupon(tx, quote.couponId);
  if (leadId) await leadForSaleTx(tx, leadId, memberId);
  const membership = await tx.membership.create({
    data: {
      tenantId: ctx.tenantId,
      memberId,
      planId: quote.plan.id,
      branchId: quote.branchId,
      status: "PENDING_PAYMENT",
      startDate: toDbDate(quote.startDate),
      endDate: toDbDate(quote.endDate),
      priceMinor: quote.plan.priceMinor,
      discountMinor: quote.discountMinor,
      couponId: quote.couponId,
      renewedFromId,
      leadId,
      createdById: ctx.userId,
    },
  });
  await membershipEvent(
    tx,
    ctx.tenantId,
    membership.id,
    "CREATED",
    null,
    "PENDING_PAYMENT",
    { plan: `${quote.plan.code}@${quote.plan.version}`, renewedFromId },
    ctx.userId,
  );
  const invoice = await issueInvoiceTx(tx, ctx, ctx.tenantId, {
    branchId: quote.branchId,
    memberId,
    membershipId: membership.id,
    lines: quote.lines,
    issueDate: today,
  });
  // IMMEDIATE policy, a free plan, or credit already covering it.
  await activatePaidMemberships(tx, ctx, ctx.tenantId, [invoice.id]);
  return { membership, invoice };
}

/**
 * Sells a membership: membership (PENDING_PAYMENT) + invoice + optional payment now, and
 * activation per the tenant policy — all in one transaction.
 */
export async function sellMembership(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "memberships.sell", write: true });
  const input = parseInput(saleSchema, raw);
  const now = nowOf(deps);
  const today = todayIn(ctx.timezone, now);
  if (input.payment) requirePermission(ctx, "billing.collect");
  return inTenant(deps, ctx, async (tx) => {
    const quote = await quoteSale(tx, ctx, input, today);
    const { membership, invoice } = await createMembershipTx(
      tx,
      ctx,
      quote,
      input.memberId,
      today,
      null,
      input.leadId ?? null,
    );
    let payment = null;
    if (input.payment) {
      const parsed = recordPaymentSchema.parse({
        memberId: input.memberId,
        branchId: quote.branchId,
        method: input.payment.method,
        amountMinor: input.payment.amountMinor,
        reference: input.payment.reference,
        allocations: [
          {
            invoiceId: invoice.id,
            amountMinor: Math.min(
              input.payment.amountMinor,
              (await invoiceBalances(tx, [invoice.id])).get(invoice.id)!
                .outstandingMinor,
            ),
          },
        ],
      });
      payment = await recordPaymentTx(tx, ctx, parsed, now);
    }
    await recordAudit(tx, ctx, {
      action: "membership.sold",
      entityType: "Membership",
      entityId: membership.id,
      branchId: quote.branchId,
      after: {
        plan: quote.plan.name,
        startDate: quote.startDate,
        endDate: quote.endDate,
        invoice: invoice.number,
        discountMinor: quote.discountMinor,
      },
    });
    const fresh = await tx.membership.findUniqueOrThrow({
      where: { id: membership.id },
    });
    return { membership: fresh, invoice, payment: payment?.payment ?? null };
  });
}

async function loadMembership(
  tx: TenantTransaction,
  ctx: AuthContext,
  membershipId: string,
  key: "memberships.manage" | "memberships.sell" | "memberships.view",
) {
  const membership = await tx.membership.findUnique({
    where: { id: membershipId },
    include: { plan: true, member: true },
  });
  if (!membership) throw new AppError("NOT_FOUND", "Membership not found.");
  if (
    !hasPermission(ctx, key, { branchId: membership.member.homeBranchId }) &&
    !hasPermission(ctx, key, { branchId: membership.branchId })
  ) {
    throw new AppError(
      "FORBIDDEN",
      "You don't have permission to do that for this membership.",
    );
  }
  return membership;
}

const renewSchema = z.object({
  planId: z.uuid().optional(),
  couponCode: z.string().trim().toUpperCase().max(20).optional(),
  payment: paymentNowSchema,
});

/** Renew: a new membership starting the day after the current end (or today if ended). */
export async function renewMembership(
  deps: CoreDeps,
  ctx: AuthContext,
  membershipId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "memberships.sell", write: true });
  const input = parseInput(renewSchema, raw);
  const now = nowOf(deps);
  const today = todayIn(ctx.timezone, now);
  if (input.payment) requirePermission(ctx, "billing.collect");
  return inTenant(deps, ctx, async (tx) => {
    const current = await loadMembership(
      tx,
      ctx,
      membershipId,
      "memberships.sell",
    );
    transition("renew", current.status);
    let planId = input.planId;
    if (!planId) {
      // The same plan, or its newest sellable version if it was edited since.
      const plan =
        current.plan.status === "ACTIVE"
          ? current.plan
          : await tx.membershipPlan.findFirst({
              where: { code: current.plan.code, status: "ACTIVE" },
              orderBy: { version: "desc" },
            });
      if (!plan)
        throw new AppError(
          "CONFLICT",
          "This plan is no longer sold. Pick another plan.",
        );
      planId = plan.id;
    }
    const already = await tx.membership.findFirst({
      where: { renewedFromId: current.id, status: { not: "CANCELLED" } },
    });
    if (already)
      throw new AppError(
        "CONFLICT",
        "This membership has already been renewed.",
      );
    const quote = await quoteSale(
      tx,
      ctx,
      { memberId: current.memberId, planId, couponCode: input.couponCode },
      today,
      { renewedFrom: { endDate: fromDbDate(current.endDate) } },
    );
    const { membership, invoice } = await createMembershipTx(
      tx,
      ctx,
      quote,
      current.memberId,
      today,
      current.id,
    );
    await membershipEvent(
      tx,
      ctx.tenantId,
      current.id,
      "RENEWED",
      current.status,
      current.status,
      { renewalId: membership.id },
      ctx.userId,
    );
    if (input.payment) {
      const outstanding = (await invoiceBalances(tx, [invoice.id])).get(
        invoice.id,
      )!.outstandingMinor;
      await recordPaymentTx(
        tx,
        ctx,
        recordPaymentSchema.parse({
          memberId: current.memberId,
          branchId: quote.branchId,
          ...input.payment,
          allocations:
            outstanding > 0
              ? [
                  {
                    invoiceId: invoice.id,
                    amountMinor: Math.min(
                      outstanding,
                      input.payment.amountMinor,
                    ),
                  },
                ]
              : [],
        }),
        now,
      );
    }
    await recordAudit(tx, ctx, {
      action: "membership.renewed",
      entityType: "Membership",
      entityId: membership.id,
      branchId: quote.branchId,
      meta: {
        renewedFrom: current.id,
        startDate: quote.startDate,
        endDate: quote.endDate,
        invoice: invoice.number,
      },
    });
    return {
      membership: await tx.membership.findUniqueOrThrow({
        where: { id: membership.id },
      }),
      invoice,
    };
  });
}

const extendSchema = z.object({
  days: z.coerce.number().int().min(1, "At least 1 day.").max(365),
  reason: z
    .string()
    .trim()
    .min(5, "Give a reason (at least 5 characters).")
    .max(500),
});

/** Staff goodwill extension (no charge), with a reason. */
export async function extendMembership(
  deps: CoreDeps,
  ctx: AuthContext,
  membershipId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "memberships.manage", write: true });
  const input = parseInput(extendSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const m = await loadMembership(tx, ctx, membershipId, "memberships.manage");
    transition("extend", m.status);
    const endDate = addDays(fromDbDate(m.endDate), input.days);
    await tx.membership.update({
      where: { id: m.id },
      data: { endDate: toDbDate(endDate) },
    });
    await membershipEvent(
      tx,
      ctx.tenantId,
      m.id,
      "EXTENDED",
      m.status,
      m.status,
      {
        days: input.days,
        reason: input.reason,
        from: fromDbDate(m.endDate),
        to: endDate,
      },
      ctx.userId,
    );
    await recordAudit(tx, ctx, {
      action: "membership.extended",
      entityType: "Membership",
      entityId: m.id,
      branchId: m.branchId,
      meta: { days: input.days, reason: input.reason, endDate },
    });
    return { endDate };
  });
}

const freezeSchema = z.object({
  startDate: dateField.optional(),
  days: z.coerce.number().int().min(1, "At least 1 day.").max(365),
  reason: z.string().trim().min(3, "Give a reason.").max(500),
});

/**
 * Freezes per the plan's rules. The end date moves out by the frozen days right away (KPI open
 * question 2, proposed default). A freeze starting today pauses now; a later one is started by
 * the daily job. A freeze fee, if the plan has one, is invoiced.
 */
export async function freezeMembership(
  deps: CoreDeps,
  ctx: AuthContext,
  membershipId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "memberships.manage", write: true });
  const input = parseInput(freezeSchema, raw);
  const today = todayIn(ctx.timezone, nowOf(deps));
  const start = input.startDate ?? today;
  return inTenant(deps, ctx, async (tx) => {
    const m = await loadMembership(tx, ctx, membershipId, "memberships.manage");
    transition("freeze", m.status);
    const open = await tx.membershipFreeze.findFirst({
      where: { membershipId: m.id, endedAt: null },
    });
    if (open)
      throw new AppError(
        "CONFLICT",
        "This membership already has a freeze scheduled or running.",
      );
    const check = checkFreeze(
      { maxDays: m.plan.freezeMaxDays, maxTimes: m.plan.freezeMaxTimes },
      { frozenDays: m.frozenDays, freezeCount: m.freezeCount },
      { start, days: input.days },
      { startDate: fromDbDate(m.startDate), endDate: fromDbDate(m.endDate) },
      today,
    );
    if (!check.ok)
      throw new AppError("VALIDATION_FAILED", check.reason, {
        fields: { days: [check.reason] },
      });
    const freeze = await tx.membershipFreeze.create({
      data: {
        tenantId: ctx.tenantId,
        membershipId: m.id,
        startDate: toDbDate(start),
        endDate: toDbDate(addDays(start, input.days - 1)),
        days: input.days,
        reason: input.reason,
        createdById: ctx.userId,
      },
    });
    const newEnd = addDays(fromDbDate(m.endDate), input.days);
    const startsNow = start === today;
    await tx.membership.update({
      where: { id: m.id },
      data: {
        endDate: toDbDate(newEnd),
        frozenDays: m.frozenDays + input.days,
        freezeCount: m.freezeCount + 1,
        ...(startsNow ? { status: "PAUSED" } : {}),
      },
    });
    await membershipEvent(
      tx,
      ctx.tenantId,
      m.id,
      "FROZEN",
      m.status,
      startsNow ? "PAUSED" : m.status,
      {
        freezeId: freeze.id,
        start,
        days: input.days,
        reason: input.reason,
        endDate: newEnd,
      },
      ctx.userId,
    );
    if (num(m.plan.freezeFeeMinor) > 0) {
      await issueInvoiceTx(tx, ctx, ctx.tenantId, {
        branchId: m.branchId,
        memberId: m.memberId,
        lines: [
          {
            kind: "OTHER",
            description: `Freeze fee (${input.days} days)`,
            sacCode: m.plan.sacCode,
            unitPriceMinor: num(m.plan.freezeFeeMinor),
            rateBps: m.plan.taxRateBps,
          },
        ],
        issueDate: today,
      });
    }
    await recordAudit(tx, ctx, {
      action: "membership.frozen",
      entityType: "Membership",
      entityId: m.id,
      branchId: m.branchId,
      meta: { start, days: input.days, reason: input.reason },
    });
    return freeze;
  });
}

async function unfreezeTx(
  tx: TenantTransaction,
  actor: Actor,
  tenantId: string,
  membershipId: string,
  today: LocalDate,
) {
  const m = await tx.membership.findUniqueOrThrow({
    where: { id: membershipId },
  });
  const freeze = await tx.membershipFreeze.findFirst({
    where: { membershipId, endedAt: null },
    orderBy: { startDate: "desc" },
  });
  if (!freeze)
    throw new AppError("CONFLICT", "This membership has no freeze to end.");
  const used = freezeDaysUsed(fromDbDate(freeze.startDate), today, freeze.days);
  const unused = freeze.days - used;
  await tx.membershipFreeze.update({
    where: { id: freeze.id },
    data: { endedAt: new Date(), days: used },
  });
  const newEnd = addDays(fromDbDate(m.endDate), -unused);
  await tx.membership.update({
    where: { id: m.id },
    data: {
      status: m.status === "PAUSED" ? "ACTIVE" : m.status,
      endDate: toDbDate(newEnd),
      frozenDays: m.frozenDays - unused,
      // A freeze cancelled before it started doesn't count towards the limit.
      freezeCount: used === 0 ? m.freezeCount - 1 : m.freezeCount,
    },
  });
  await membershipEvent(
    tx,
    tenantId,
    m.id,
    "UNFROZEN",
    m.status,
    m.status === "PAUSED" ? "ACTIVE" : m.status,
    { freezeId: freeze.id, daysUsed: used, endDate: newEnd },
    actor.userId ?? null,
  );
  await recordAudit(tx, actor, {
    action: "membership.unfrozen",
    entityType: "Membership",
    entityId: m.id,
    branchId: m.branchId,
    meta: { daysUsed: used, endDate: newEnd },
  });
  return { daysUsed: used, endDate: newEnd };
}

export async function unfreezeMembership(
  deps: CoreDeps,
  ctx: AuthContext,
  membershipId: string,
) {
  await guard(deps, ctx, { permission: "memberships.manage", write: true });
  const today = todayIn(ctx.timezone, nowOf(deps));
  return inTenant(deps, ctx, async (tx) => {
    await loadMembership(tx, ctx, membershipId, "memberships.manage");
    return unfreezeTx(tx, ctx, ctx.tenantId, membershipId, today);
  });
}

const cancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, "Give a reason (at least 5 characters).")
    .max(500),
  refundMinor: z.coerce.number().int().min(0).default(0),
  refundMethod: z.enum(PAYMENT_METHODS).optional(),
  refundReference: z.string().trim().max(100).optional(),
});

/** What the plan's refund rule allows back, given what was paid and what is left. */
export function maxRefundFor(
  rule: "NONE" | "PRORATA" | "FULL_BEFORE_START",
  paidMinor: number,
  period: { startDate: LocalDate; endDate: LocalDate },
  today: LocalDate,
): number {
  if (rule === "NONE" || paidMinor <= 0) return 0;
  const notStarted = compareDates(today, period.startDate) < 0;
  if (rule === "FULL_BEFORE_START") return notStarted ? paidMinor : 0;
  const total = diffDays(period.startDate, period.endDate) + 1;
  const remaining = notStarted
    ? total
    : Math.max(0, diffDays(today, period.endDate));
  return Math.floor((paidMinor * remaining) / total);
}

/**
 * Cancels per the plan policy: unpaid dues are cancelled with a credit note; a refund (within
 * the plan's rule) is a credit note plus a recorded manual refund. Online refunds are M4.
 */
export async function cancelMembership(
  deps: CoreDeps,
  ctx: AuthContext,
  membershipId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "memberships.manage", write: true });
  const input = parseInput(cancelSchema, raw);
  const today = todayIn(ctx.timezone, nowOf(deps));
  if (input.refundMinor > 0) {
    requirePermission(ctx, "billing.refund");
    if (!input.refundMethod)
      throw new AppError(
        "VALIDATION_FAILED",
        "How is the money being returned?",
        { fields: { refundMethod: ["Pick a method."] } },
      );
  }
  return inTenant(deps, ctx, async (tx) => {
    const m = await loadMembership(tx, ctx, membershipId, "memberships.manage");
    const to = transition("cancel", m.status);
    const invoices = await tx.gymInvoice.findMany({
      where: { membershipId: m.id, voidedAt: null },
    });
    const balances = await invoiceBalances(
      tx,
      invoices.map((i) => i.id),
    );
    const paid = [...balances.values()].reduce(
      (s, b) => s + b.allocatedMinor,
      0,
    );
    const max = maxRefundFor(
      m.plan.refundRule,
      paid,
      { startDate: fromDbDate(m.startDate), endDate: fromDbDate(m.endDate) },
      today,
    );
    if (input.refundMinor > max) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The plan's refund rule allows at most ₹${(max / 100).toFixed(2)}.`,
        { fields: { refundMinor: ["More than the plan allows."] } },
      );
    }
    await tx.membership.update({
      where: { id: m.id },
      data: { status: to, cancelledAt: new Date(), cancelReason: input.reason },
    });
    await membershipEvent(
      tx,
      ctx.tenantId,
      m.id,
      "CANCELLED",
      m.status,
      to,
      { reason: input.reason, refundMinor: input.refundMinor },
      ctx.userId,
    );
    let refundLeft = input.refundMinor;
    for (const invoice of invoices) {
      const b = balances.get(invoice.id)!;
      if (b.outstandingMinor > 0) {
        await issueCreditNoteTx(
          tx,
          ctx,
          ctx.tenantId,
          invoice.id,
          {
            amountMinor: b.outstandingMinor,
            reason: `Membership cancelled: ${input.reason}`,
          },
          today,
        );
      }
      const refundHere = Math.min(refundLeft, b.allocatedMinor);
      if (refundHere > 0) {
        await issueCreditNoteTx(
          tx,
          ctx,
          ctx.tenantId,
          invoice.id,
          {
            amountMinor: refundHere,
            reason: `Refund on cancellation: ${input.reason}`,
          },
          today,
        );
        refundLeft -= refundHere;
      }
    }
    if (input.refundMinor > 0) {
      await recordManualRefundTx(tx, ctx, {
        memberId: m.memberId,
        amountMinor: input.refundMinor,
        method: input.refundMethod!,
        reference: input.refundReference,
        reason: `Cancellation of ${m.plan.name}: ${input.reason}`,
      });
    }
    await recordAudit(tx, ctx, {
      action: "membership.cancelled",
      entityType: "Membership",
      entityId: m.id,
      branchId: m.branchId,
      meta: { reason: input.reason, refundMinor: input.refundMinor },
    });
    return { cancelled: true, refundMinor: input.refundMinor };
  });
}

// --- daily job ----------------------------------------------------------------------------

/**
 * The daily membership job for one tenant (worker, hourly; idempotent). With `today` in the
 * tenant's timezone:
 * 1. starts freezes due today and ends freezes whose last day has passed;
 * 2. ACTIVE memberships past end date + plan grace days → EXPIRED (+ event, audit, notice);
 * 3. reminders N days before the end (tenant setting, default 7/3/1), once each.
 */
export async function runDailyMembershipJob(
  tx: TenantTransaction,
  tenantId: string,
  today: LocalDate,
) {
  const system = { system: true as const, tenantId };
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId } });
  const result = { frozen: 0, unfrozen: 0, expired: 0, reminded: 0 };

  const starting = await tx.membershipFreeze.findMany({
    where: {
      endedAt: null,
      startDate: { lte: toDbDate(today) },
      membership: { status: "ACTIVE" },
    },
  });
  for (const f of starting) {
    if (compareDates(fromDbDate(f.endDate), today) < 0) continue;
    await tx.membership.update({
      where: { id: f.membershipId },
      data: { status: "PAUSED" },
    });
    await membershipEvent(
      tx,
      tenantId,
      f.membershipId,
      "FROZEN",
      "ACTIVE",
      "PAUSED",
      { freezeId: f.id, started: today },
      null,
    );
    result.frozen++;
  }
  const ending = await tx.membershipFreeze.findMany({
    where: { endedAt: null, endDate: { lt: toDbDate(today) } },
  });
  for (const f of ending) {
    await tx.membershipFreeze.update({
      where: { id: f.id },
      data: { endedAt: new Date() },
    });
    const m = await tx.membership.findUniqueOrThrow({
      where: { id: f.membershipId },
    });
    if (m.status === "PAUSED") {
      await tx.membership.update({
        where: { id: m.id },
        data: { status: "ACTIVE" },
      });
      await membershipEvent(
        tx,
        tenantId,
        m.id,
        "UNFROZEN",
        "PAUSED",
        "ACTIVE",
        { freezeId: f.id, automatic: true },
        null,
      );
      result.unfrozen++;
    }
  }

  const active = await tx.membership.findMany({
    where: { status: "ACTIVE", endDate: { lt: toDbDate(today) } },
    include: { plan: true, member: true },
  });
  for (const m of active) {
    if (!isPastGrace(fromDbDate(m.endDate), m.plan.graceDays, today)) continue;
    await tx.membership.update({
      where: { id: m.id },
      data: { status: "EXPIRED" },
    });
    await membershipEvent(
      tx,
      tenantId,
      m.id,
      "EXPIRED",
      "ACTIVE",
      "EXPIRED",
      { endDate: fromDbDate(m.endDate), graceDays: m.plan.graceDays, today },
      null,
    );
    await recordAudit(tx, system, {
      action: "membership.expired",
      entityType: "Membership",
      entityId: m.id,
      branchId: m.branchId,
    });
    await notify(tx, tenantId, {
      templateKey: "membership.expired",
      recipient: {
        memberId: m.memberId,
        userId: m.member.userId,
        email: m.member.email,
      },
      data: {
        name: m.member.firstName,
        gym: tenant.displayName,
        plan: m.plan.name,
        end: fromDbDate(m.endDate),
      },
      link: "/m/",
      dedupeKey: `expired:${m.id}`,
    });
    result.expired++;
  }

  for (const days of settings?.expiryReminderDays ?? [7, 3, 1]) {
    const end = addDays(today, days);
    const due = await tx.membership.findMany({
      where: { status: "ACTIVE", endDate: toDbDate(end) },
      include: { plan: true, member: true },
    });
    for (const m of due) {
      const renewed = await tx.membership.count({
        where: { renewedFromId: m.id, status: { not: "CANCELLED" } },
      });
      if (renewed > 0) continue;
      const sent = await notify(tx, tenantId, {
        templateKey: "membership.expiring",
        recipient: {
          memberId: m.memberId,
          userId: m.member.userId,
          email: m.member.email,
        },
        data: {
          name: m.member.firstName,
          gym: tenant.displayName,
          plan: m.plan.name,
          end: fromDbDate(m.endDate),
          days,
        },
        link: "/m/",
        dedupeKey: `expiring:${m.id}:${days}`,
      });
      if (sent.email === "QUEUED" || sent.inApp === "QUEUED") result.reminded++;
    }
  }
  return result;
}

export async function membershipTimeline(
  deps: CoreDeps,
  ctx: AuthContext,
  membershipId: string,
) {
  return inTenant(deps, ctx, async (tx) => {
    const m = await loadMembership(tx, ctx, membershipId, "memberships.view");
    const [events, freezes, invoices] = await inOrder([
      tx.membershipEvent.findMany({
        where: { membershipId },
        orderBy: { createdAt: "asc" },
      }),
      tx.membershipFreeze.findMany({
        where: { membershipId },
        orderBy: { startDate: "asc" },
      }),
      tx.gymInvoice.findMany({
        where: { membershipId },
        select: { id: true, number: true, status: true, totalMinor: true },
      }),
    ]);
    return { membership: m, events, freezes, invoices };
  });
}

// --- M4: members buying and renewing in the app -----------------------------------------------

/**
 * A member buys a plan in the app: membership (PENDING_PAYMENT) + invoice, nothing paid yet. The
 * caller then creates a payment link; the membership activates when the verified payment lands.
 */
export async function memberBuyPlanTx(
  tx: TenantTransaction,
  actor: MemberSaleActor,
  planId: string,
  today: LocalDate,
) {
  const quote = await quoteSale(
    tx,
    actor,
    { memberId: actor.memberId, planId },
    today,
  );
  const { membership, invoice } = await createMembershipTx(
    tx,
    actor,
    quote,
    actor.memberId,
    today,
    null,
  );
  await recordAudit(tx, actor, {
    action: "membership.bought_online",
    entityType: "Membership",
    entityId: membership.id,
    branchId: quote.branchId,
    after: { plan: quote.plan.name, invoice: invoice.number },
  });
  return { membership, invoice };
}

/** A member renews their own membership in the app (same plan, newest version). */
export async function memberRenewTx(
  tx: TenantTransaction,
  actor: MemberSaleActor,
  membershipId: string,
  today: LocalDate,
) {
  const current = await tx.membership.findUnique({
    where: { id: membershipId },
    include: { plan: true },
  });
  if (!current || current.memberId !== actor.memberId)
    throw new AppError("NOT_FOUND", "Membership not found.");
  transition("renew", current.status);
  const plan =
    current.plan.status === "ACTIVE"
      ? current.plan
      : await tx.membershipPlan.findFirst({
          where: { code: current.plan.code, status: "ACTIVE" },
          orderBy: { version: "desc" },
        });
  if (!plan)
    throw new AppError(
      "CONFLICT",
      "This plan is no longer sold. Ask at the front desk.",
    );
  const already = await tx.membership.findFirst({
    where: { renewedFromId: current.id, status: { not: "CANCELLED" } },
    include: { invoices: { select: { id: true } } },
  });
  if (already)
    return { membership: already, invoice: null, existing: true as const };
  const quote = await quoteSale(
    tx,
    actor,
    { memberId: actor.memberId, planId: plan.id },
    today,
    { renewedFrom: { endDate: fromDbDate(current.endDate) } },
  );
  const { membership, invoice } = await createMembershipTx(
    tx,
    actor,
    quote,
    actor.memberId,
    today,
    current.id,
  );
  await membershipEvent(
    tx,
    actor.tenantId,
    current.id,
    "RENEWED",
    current.status,
    current.status,
    { renewalId: membership.id, via: "member app" },
    actor.userId,
  );
  await recordAudit(tx, actor, {
    action: "membership.renewed_online",
    entityType: "Membership",
    entityId: membership.id,
    branchId: quote.branchId,
    meta: { renewedFrom: current.id, invoice: invoice.number },
  });
  return { membership, invoice, existing: false as const };
}
