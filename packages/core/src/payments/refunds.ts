import { randomBytes } from "node:crypto";
import { ProviderError } from "@gym/integrations/payments";
import { z } from "zod";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "../authz";
import {
  creditBalance,
  invoiceBalances,
  issueCreditNoteTx,
  num,
  PAYMENT_METHODS,
} from "../billing/service";
import { AppError } from "../errors";
import { memberName } from "../members/service";
import { cancelMembership } from "../memberships/service";
import { formatMoney, money } from "../money";
import { notify } from "../notifications";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { todayIn } from "../time/dates";
import { parseInput } from "../validation";
import { providerFor, type IntegrationRow } from "./integration";
import { needsApproval, newReferenceId, planRefundCreditNotes } from "./rules";

/**
 * Refunds (M4 §4). Every refund is backed by credit notes on the invoices the payment paid (D-11:
 * issued invoices never change); the money then leaves the member's credit — to the original
 * payment method through the provider (online) or by hand (manual, with the method recorded).
 */
const requestSchema = z.object({
  paymentId: z.uuid(),
  /** Rupees. */
  amount: z.coerce.number().positive("Enter an amount."),
  reason: z
    .string()
    .trim()
    .min(5, "Give a reason (at least 5 characters).")
    .max(500),
  method: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(PAYMENT_METHODS).optional(),
  ),
  reference: z.string().trim().max(100).optional(),
  cancelMembership: z
    .union([z.boolean(), z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === true || v === "on"),
});

const ACTIVE_STATES = ["PENDING_APPROVAL", "PENDING", "PROCESSED"] as const;

export async function requestRefund(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "billing.refund", write: true });
  const input = parseInput(requestSchema, raw);
  const amountMinor = Math.round(input.amount * 100);
  const refund = await inTenant(deps, ctx, async (tx) => {
    const payment = await tx.gymPayment.findUnique({
      where: { id: input.paymentId },
      include: { refunds: true },
    });
    if (!payment) throw new AppError("NOT_FOUND", "Payment not found.");
    requirePermission(ctx, "billing.refund", { branchId: payment.branchId });
    if (payment.status !== "SUCCEEDED")
      throw new AppError(
        "CONFLICT",
        "Only successful payments can be refunded.",
      );
    const kind = payment.providerPaymentId ? "ONLINE" : "MANUAL";
    if (kind === "MANUAL" && !input.method)
      throw new AppError(
        "VALIDATION_FAILED",
        "How is the money being given back?",
        {
          fields: { method: ["Pick how the money is given back."] },
        },
      );
    const used = payment.refunds
      .filter((r) => (ACTIVE_STATES as readonly string[]).includes(r.status))
      .reduce((s, r) => s + num(r.amountMinor), 0);
    const refundable = num(payment.amountMinor) - used;
    if (amountMinor > refundable)
      throw new AppError(
        "VALIDATION_FAILED",
        `At most ${formatMoney(money(refundable, payment.currency))} of this payment can still be refunded.`,
        { fields: { amount: ["More than can be refunded."] } },
      );
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    const threshold =
      settings?.refundApprovalThresholdMinor != null
        ? num(settings.refundApprovalThresholdMinor)
        : null;
    const row = await tx.refund.create({
      data: {
        tenantId: ctx.tenantId,
        paymentId: payment.id,
        memberId: payment.memberId,
        kind,
        amountMinor,
        reason: input.reason,
        status: needsApproval(amountMinor, threshold)
          ? "PENDING_APPROVAL"
          : "PENDING",
        method: kind === "MANUAL" ? input.method! : null,
        reference: input.reference || null,
        receipt: newReferenceId("RF", randomBytes(12).toString("base64url")),
        cancelMembership: input.cancelMembership,
        requestedById: ctx.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: "refund.requested",
      entityType: "Refund",
      entityId: row.id,
      branchId: payment.branchId,
      after: {
        kind,
        amountMinor,
        needsApproval: row.status === "PENDING_APPROVAL",
      },
      meta: { reason: input.reason, paymentId: payment.id },
    });
    return row;
  });
  if (refund.status === "PENDING_APPROVAL")
    return { refund, executed: false as const };
  return {
    refund: await executeRefund(deps, ctx, refund.id),
    executed: true as const,
  };
}

/** A second person (not the requester) approves a refund above the gym's threshold. */
export async function approveRefund(
  deps: CoreDeps,
  ctx: AuthContext,
  refundId: string,
) {
  await guard(deps, ctx, { permission: "billing.refund", write: true });
  const row = await inTenant(deps, ctx, (tx) =>
    tx.refund.findUnique({
      where: { id: refundId },
      include: { payment: true },
    }),
  );
  if (!row) throw new AppError("NOT_FOUND", "Refund not found.");
  requirePermission(ctx, "billing.refund", { branchId: row.payment.branchId });
  if (row.status !== "PENDING_APPROVAL")
    throw new AppError("CONFLICT", "This refund isn't waiting for approval.");
  if (row.requestedById === ctx.userId)
    throw new AppError(
      "FORBIDDEN",
      "Someone other than the person who asked must approve it.",
    );
  return executeRefund(deps, ctx, row.id);
}

export async function rejectRefund(
  deps: CoreDeps,
  ctx: AuthContext,
  refundId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "billing.refund", write: true });
  const { reason } = parseInput(
    z.object({ reason: z.string().trim().min(3).max(300) }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const row = await tx.refund.findUnique({
      where: { id: refundId },
      include: { payment: true },
    });
    if (!row) throw new AppError("NOT_FOUND", "Refund not found.");
    requirePermission(ctx, "billing.refund", {
      branchId: row.payment.branchId,
    });
    if (row.status !== "PENDING_APPROVAL")
      throw new AppError("CONFLICT", "This refund isn't waiting for approval.");
    await tx.refund.update({
      where: { id: row.id },
      data: {
        status: "REJECTED",
        approvedById: ctx.userId,
        decidedAt: nowOf(deps),
        failureReason: reason,
      },
    });
    await recordAudit(tx, ctx, {
      action: "refund.rejected",
      entityType: "Refund",
      entityId: row.id,
      meta: { reason },
    });
  });
}

/**
 * Credit notes + credit debit in one transaction; then (online) the provider call, whose result
 * arrives later by webhook or reconciliation. A provider error gives the money back to credit.
 */
async function executeRefund(
  deps: CoreDeps,
  ctx: AuthContext,
  refundId: string,
) {
  const now = nowOf(deps);
  const today = todayIn(ctx.timezone, now);
  const prepared = await inTenant(deps, ctx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM app.refund WHERE id = ${refundId}::uuid FOR UPDATE`;
    const row = await tx.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: {
        payment: {
          include: {
            allocations: {
              where: { reversedAt: null },
              orderBy: { createdAt: "asc" },
            },
            link: { include: { integration: true } },
          },
        },
        member: true,
      },
    });
    if (row.status !== "PENDING_APPROVAL" && row.status !== "PENDING")
      throw new AppError("CONFLICT", "This refund has already been handled.");
    if (row.processedAt || row.creditNoteIds.length)
      throw new AppError("CONFLICT", "This refund has already been handled.");
    const amountMinor = num(row.amountMinor);
    const invoiceIds = row.payment.allocations.map((a) => a.invoiceId);
    const balances = await invoiceBalances(tx, invoiceIds);
    const plan = planRefundCreditNotes(
      amountMinor,
      row.payment.allocations.map((a) => {
        const b = balances.get(a.invoiceId)!;
        return {
          invoiceId: a.invoiceId,
          allocatedMinor: num(a.amountMinor),
          creditableMinor: b.totalMinor - b.creditedMinor,
        };
      }),
    );
    const noteIds: string[] = [];
    for (const n of plan.notes) {
      const note = await issueCreditNoteTx(
        tx,
        ctx,
        ctx.tenantId,
        n.invoiceId,
        { amountMinor: n.amountMinor, reason: `Refund: ${row.reason}` },
        today,
      );
      noteIds.push(note.id);
    }
    // The money must now be free credit (not still needed for what's due).
    const credit = await creditBalance(tx, row.memberId);
    if (credit < amountMinor)
      throw new AppError(
        "CONFLICT",
        `Only ${formatMoney(money(Math.max(credit, 0)))} can be refunded now: the rest still pays for what's due. Cancel the membership or credit the invoice first.`,
      );
    await tx.memberCreditEntry.create({
      data: {
        tenantId: ctx.tenantId,
        memberId: row.memberId,
        amountMinor: -amountMinor,
        kind: row.kind === "ONLINE" ? "ONLINE_REFUND" : "MANUAL_REFUND",
        paymentId: row.paymentId,
        createdById: ctx.userId,
        note: `Refund ${row.receipt}${row.method ? ` (${row.method.toLowerCase().replace("_", " ")})` : ""}: ${row.reason}`,
      },
    });
    const updated = await tx.refund.update({
      where: { id: row.id },
      data: {
        status: row.kind === "MANUAL" ? "PROCESSED" : "PENDING",
        creditNoteIds: noteIds,
        approvedById: row.status === "PENDING_APPROVAL" ? ctx.userId : null,
        decidedAt: now,
        processedAt: row.kind === "MANUAL" ? now : null,
      },
    });
    await recordAudit(tx, ctx, {
      action: row.kind === "ONLINE" ? "refund.initiated" : "refund.recorded",
      entityType: "Refund",
      entityId: row.id,
      branchId: row.payment.branchId,
      after: { amountMinor, creditNotes: noteIds.length, kind: row.kind },
      meta: { reason: row.reason },
    });
    if (row.kind === "MANUAL") {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
      });
      await notify(tx, ctx.tenantId, {
        templateKey: "refund.processed",
        recipient: {
          memberId: row.memberId,
          userId: row.member.userId,
          email: row.member.email,
        },
        data: {
          name: row.member.firstName,
          gym: tenant.displayName,
          amount: formatMoney(money(amountMinor, tenant.currency)),
          how: `by ${row.method!.toLowerCase().replace("_", " ")}`,
          when: "",
        },
        dedupeKey: `refund:${row.id}`,
      });
    }
    return { row: updated, payment: row.payment };
  });
  let result = prepared.row;
  if (prepared.row.kind === "ONLINE") {
    const integration = prepared.payment.link?.integration;
    try {
      if (!integration || !prepared.payment.providerPaymentId)
        throw new ProviderError("No online payment to refund against.", null);
      const remote = await providerFor(
        deps,
        integration as IntegrationRow,
      ).createRefund({
        paymentId: prepared.payment.providerPaymentId,
        amountMinor: num(prepared.row.amountMinor),
        receipt: prepared.row.receipt,
        notes: { tenantId: ctx.tenantId, refundId: prepared.row.id },
      });
      result = await inTenant(deps, ctx, (tx) =>
        tx.refund.update({
          where: { id: prepared.row.id },
          data: { providerRefundId: remote.id },
        }),
      );
    } catch (err) {
      await inTenant(deps, ctx, async (tx) => {
        await tx.refund.update({
          where: { id: prepared.row.id },
          data: {
            status: "FAILED",
            failureReason:
              err instanceof Error
                ? err.message.slice(0, 300)
                : "Provider error",
          },
        });
        await tx.memberCreditEntry.create({
          data: {
            tenantId: ctx.tenantId,
            memberId: prepared.row.memberId,
            amountMinor: prepared.row.amountMinor,
            kind: "REFUND_REVERSED",
            paymentId: prepared.row.paymentId,
            createdById: ctx.userId,
            note: `Refund ${prepared.row.receipt} not sent; amount kept as credit`,
          },
        });
        await recordAudit(tx, ctx, {
          action: "refund.failed",
          entityType: "Refund",
          entityId: prepared.row.id,
          meta: {
            error: err instanceof Error ? err.message.slice(0, 200) : "error",
          },
        });
      });
      throw new AppError(
        "PROVIDER_ERROR",
        `Razorpay didn't accept the refund${err instanceof Error ? `: ${err.message}` : ""}. The credit note stands and the amount stays as member credit.`,
      );
    }
  }
  // Optional: cancel the membership the payment was for (M2 cancellation, no further refund).
  if (prepared.row.cancelMembership) {
    const invoice = await inTenant(deps, ctx, (tx) =>
      tx.gymInvoice.findFirst({
        where: {
          allocations: { some: { paymentId: prepared.row.paymentId } },
          membershipId: { not: null },
        },
        select: { membershipId: true },
      }),
    );
    if (invoice?.membershipId && hasPermission(ctx, "memberships.manage"))
      await cancelMembership(deps, ctx, invoice.membershipId, {
        reason: `Refunded: ${prepared.row.reason}`,
        refundMinor: 0,
      }).catch(() => undefined);
  }
  return result;
}

const listSchema = z.object({
  status: z.enum(["all", "waiting", "pending"]).default("all"),
});

export async function listRefunds(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "billing.view" });
  const input = parseInput(listSchema, raw);
  const allowed = allowedBranchIds(ctx, "billing.view");
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.refund.findMany({
      where: {
        ...(input.status === "waiting" ? { status: "PENDING_APPROVAL" } : {}),
        ...(input.status === "pending" ? { status: "PENDING" } : {}),
        ...(allowed === "ALL"
          ? {}
          : { payment: { branchId: { in: allowed } } }),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
          },
        },
        payment: { select: { receiptNumber: true, branchId: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      amountMinor: num(r.amountMinor),
      reason: r.reason,
      method: r.method,
      receipt: r.receipt,
      failureReason: r.failureReason,
      createdAt: r.createdAt,
      receiptNumber: r.payment.receiptNumber,
      member: { ...r.member, name: memberName(r.member) },
      requestedByMe: r.requestedById === ctx.userId,
      canDecide:
        r.status === "PENDING_APPROVAL" &&
        r.requestedById !== ctx.userId &&
        hasPermission(ctx, "billing.refund", { branchId: r.payment.branchId }),
    }));
  });
}

/** What the refund form needs: the payment, how much can still be refunded, online or manual. */
export async function getPaymentForRefund(
  deps: CoreDeps,
  ctx: AuthContext,
  paymentId: string,
) {
  await guard(deps, ctx, { permission: "billing.refund" });
  return inTenant(deps, ctx, async (tx) => {
    const payment = await tx.gymPayment.findUnique({
      where: { id: paymentId },
      include: {
        refunds: true,
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
          },
        },
        allocations: {
          where: { reversedAt: null },
          include: {
            invoice: { select: { number: true, membershipId: true } },
          },
        },
      },
    });
    if (!payment) throw new AppError("NOT_FOUND", "Payment not found.");
    requirePermission(ctx, "billing.refund", { branchId: payment.branchId });
    const used = payment.refunds
      .filter((r) => (ACTIVE_STATES as readonly string[]).includes(r.status))
      .reduce((s, r) => s + num(r.amountMinor), 0);
    return {
      id: payment.id,
      receiptNumber: payment.receiptNumber,
      amountMinor: num(payment.amountMinor),
      method: payment.method,
      status: payment.status,
      online: !!payment.providerPaymentId,
      refundableMinor: num(payment.amountMinor) - used,
      member: { ...payment.member, name: memberName(payment.member) },
      invoices: payment.allocations.map((a) => a.invoice.number),
      hasMembership: payment.allocations.some((a) => a.invoice.membershipId),
      refunds: payment.refunds.map((r) => ({
        id: r.id,
        amountMinor: num(r.amountMinor),
        status: r.status,
        createdAt: r.createdAt,
      })),
    };
  });
}
