import { randomUUID } from "node:crypto";
import type { Prisma, TenantTransaction } from "@gym/db";
import { inOrder } from "@gym/db";
import { z } from "zod";
import { recordAudit, type AuditActor } from "../audit";
import { allowedBranchIds, hasPermission, type AuthContext } from "../authz";
import { AppError } from "../errors";
import { activatePaidMemberships } from "../memberships/activation";
import { formatMoney, money } from "../money";
import { notify } from "../notifications";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import {
  addDays,
  fromDbDate,
  startOfDayUtc,
  todayIn,
  toDbDate,
  type LocalDate,
} from "../time/dates";
import { parseInput } from "../validation";
import {
  allocateExplicit,
  allocateOldestFirst,
  AllocationError,
  type AllocationPlan,
  type OpenInvoice,
} from "./allocation";
import { financialYearOf, formatDocumentNumber } from "./numbering";
import {
  computeTaxLine,
  proportionalTaxSplit,
  sumTotals,
  supplyType,
  type TaxLineResult,
} from "./tax";

export const num = (value: bigint | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(n)) throw new RangeError("Amount out of range");
  return n;
};

const inr = (minor: number, currency = "INR") =>
  formatMoney(money(minor, currency));

type Actor = AuditActor & { userId?: string };

// --- numbering ------------------------------------------------------------------------------

const SERIES_PREFIX = {
  INVOICE: null,
  CREDIT_NOTE: "CN",
  RECEIPT: "RC",
} as const;

/**
 * Next number in a gap-free series. The series row is created if missing and then locked
 * FOR UPDATE, so concurrent issuers queue on it; a rolled-back transaction releases the number.
 */
export async function nextDocumentNumber(
  tx: TenantTransaction,
  tenantId: string,
  kind: "INVOICE" | "CREDIT_NOTE" | "RECEIPT",
  seriesKey: string,
  date: LocalDate,
  invoicePrefix: string,
): Promise<string> {
  const fy = financialYearOf(date);
  const prefix = SERIES_PREFIX[kind] ?? invoicePrefix;
  await tx.$executeRaw`
    INSERT INTO app.invoice_series (id, tenant_id, kind, series_key, financial_year, prefix, next_number)
    VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${kind}::app."SeriesKind", ${seriesKey}, ${fy}, ${prefix}, 1)
    ON CONFLICT (tenant_id, kind, series_key, financial_year) DO NOTHING`;
  const rows = await tx.$queryRaw<
    { id: string; next_number: number; prefix: string }[]
  >`
    SELECT id::text, next_number, prefix FROM app.invoice_series
     WHERE tenant_id = ${tenantId}::uuid AND kind = ${kind}::app."SeriesKind"
       AND series_key = ${seriesKey} AND financial_year = ${fy}
     FOR UPDATE`;
  const series = rows[0];
  if (!series) throw new AppError("INTERNAL", "Invoice series missing");
  const number = formatDocumentNumber(series.prefix, fy, series.next_number);
  await tx.$executeRaw`UPDATE app.invoice_series SET next_number = next_number + 1 WHERE id = ${series.id}::uuid`;
  return number;
}

// --- issuing -------------------------------------------------------------------------------

export type InvoiceLineInput = {
  kind: "MEMBERSHIP" | "JOINING_FEE" | "OTHER" | "PT_PACKAGE";
  description: string;
  sacCode?: string | null;
  unitPriceMinor: number;
  quantity?: number;
  discountMinor?: number;
  rateBps: number;
};

export type InvoiceDraft = {
  documentType: "TAX_INVOICE" | "BILL";
  pricesIncludeTax: boolean;
  placeOfSupply: string | null;
  supply: "INTRA" | "INTER" | "NONE";
  supplier: Record<string, string | null>;
  recipient: Record<string, string | null>;
  seriesKey: string;
  lines: (InvoiceLineInput & { result: TaxLineResult })[];
  totals: ReturnType<typeof sumTotals>;
  currency: string;
};

/** Everything that goes on the invoice, computed but not stored (used for previews too). */
export async function draftInvoice(
  tx: TenantTransaction,
  tenantId: string,
  input: { branchId: string; memberId: string; lines: InvoiceLineInput[] },
): Promise<InvoiceDraft> {
  const [tenant, settings, branch, member] = await inOrder([
    tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    tx.tenantSettings.findUnique({ where: { tenantId } }),
    tx.branch.findUnique({ where: { id: input.branchId } }),
    tx.memberProfile.findUnique({ where: { id: input.memberId } }),
  ]);
  if (!branch) throw new AppError("NOT_FOUND", "Branch not found.");
  if (!member) throw new AppError("NOT_FOUND", "Member not found.");
  const registered = settings?.gstRegistered ?? false;
  // A branch registered on its own GSTIN issues on that GSTIN (D-11 per-branch override).
  const gstin = registered ? (branch.gstin ?? settings?.gstin ?? null) : null;
  const supplierState = gstin
    ? gstin.slice(0, 2)
    : (branch.stateCode ?? settings?.stateCode ?? null);
  const placeOfSupply =
    settings?.placeOfSupplyRule === "MEMBER_STATE"
      ? (member.stateCode ?? branch.stateCode)
      : branch.stateCode;
  const supply = supplyType({
    gstRegistered: registered && !!gstin,
    supplierStateCode: supplierState,
    placeOfSupply,
  });
  const pricesIncludeTax = settings?.pricesIncludeTax ?? true;
  const lines = input.lines.map((line) => ({
    ...line,
    sacCode: line.sacCode ?? settings?.defaultSacCode ?? null,
    result: computeTaxLine(line, supply, pricesIncludeTax),
  }));
  return {
    documentType: supply === "NONE" ? "BILL" : "TAX_INVOICE",
    pricesIncludeTax,
    placeOfSupply,
    supply,
    supplier: {
      legalName: tenant.legalName,
      displayName: tenant.displayName,
      gstin,
      branch: branch.name,
      address:
        [
          branch.addressLine1,
          branch.addressLine2,
          branch.city,
          branch.postalCode,
        ]
          .filter(Boolean)
          .join(", ") || null,
      stateCode: supplierState,
      phone: branch.phone,
    },
    recipient: {
      name: [member.firstName, member.lastName].filter(Boolean).join(" "),
      memberCode: member.memberCode,
      email: member.email,
      phone: member.phone,
      address:
        [member.addressLine1, member.city, member.postalCode]
          .filter(Boolean)
          .join(", ") || null,
      stateCode: member.stateCode,
    },
    seriesKey: gstin ?? "UNREGISTERED",
    lines,
    totals: sumTotals(lines.map((l) => l.result)),
    currency: tenant.currency,
  };
}

/** Issues an invoice inside the caller's transaction. Numbers are gap-free (see nextDocumentNumber). */
export async function issueInvoiceTx(
  tx: TenantTransaction,
  actor: Actor,
  tenantId: string,
  input: {
    branchId: string;
    memberId: string;
    membershipId?: string | null;
    lines: InvoiceLineInput[];
    issueDate: LocalDate;
    notes?: string | null;
  },
) {
  if (input.lines.length === 0)
    throw new AppError(
      "VALIDATION_FAILED",
      "An invoice needs at least one line.",
    );
  const draft = await draftInvoice(tx, tenantId, input);
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId } });
  const number = await nextDocumentNumber(
    tx,
    tenantId,
    "INVOICE",
    draft.seriesKey,
    input.issueDate,
    settings?.invoicePrefix ?? "INV",
  );
  const invoice = await tx.gymInvoice.create({
    data: {
      tenantId,
      branchId: input.branchId,
      memberId: input.memberId,
      membershipId: input.membershipId ?? null,
      number,
      documentType: draft.documentType,
      status: draft.totals.totalMinor === 0 ? "PAID" : "ISSUED",
      issueDate: toDbDate(input.issueDate),
      dueDate: toDbDate(
        addDays(input.issueDate, settings?.invoiceDueDays ?? 0),
      ),
      currency: draft.currency,
      pricesIncludeTax: draft.pricesIncludeTax,
      placeOfSupply: draft.placeOfSupply,
      taxableMinor: draft.totals.taxableMinor,
      cgstMinor: draft.totals.cgstMinor,
      sgstMinor: draft.totals.sgstMinor,
      igstMinor: draft.totals.igstMinor,
      totalMinor: draft.totals.totalMinor,
      supplier: draft.supplier as Prisma.InputJsonValue,
      recipient: draft.recipient as Prisma.InputJsonValue,
      notes: input.notes ?? null,
      createdById: actor.userId ?? null,
      lines: {
        create: draft.lines.map((l, position) => ({
          position,
          kind: l.kind,
          description: l.description,
          sacCode: l.sacCode,
          quantity: l.quantity ?? 1,
          unitPriceMinor: l.unitPriceMinor,
          discountMinor: l.result.discountMinor,
          taxableMinor: l.result.taxableMinor,
          taxRateBps: l.result.taxRateBps,
          cgstRateBps: l.result.cgstRateBps,
          sgstRateBps: l.result.sgstRateBps,
          igstRateBps: l.result.igstRateBps,
          cgstMinor: l.result.cgstMinor,
          sgstMinor: l.result.sgstMinor,
          igstMinor: l.result.igstMinor,
          totalMinor: l.result.totalMinor,
        })),
      },
    },
  });
  await recordAudit(tx, actor, {
    action: "invoice.issued",
    entityType: "GymInvoice",
    entityId: invoice.id,
    branchId: input.branchId,
    after: {
      number,
      total: draft.totals.totalMinor,
      documentType: draft.documentType,
    },
  });

  if (settings?.autoApplyCredit ?? true) {
    await applyCreditTx(tx, actor, tenantId, input.memberId);
  }
  const member = await tx.memberProfile.findUniqueOrThrow({
    where: { id: input.memberId },
  });
  const balance = (await invoiceBalances(tx, [invoice.id])).get(invoice.id);
  await notify(tx, tenantId, {
    templateKey: "invoice.issued",
    recipient: {
      memberId: member.id,
      userId: member.userId,
      email: member.email,
    },
    data: {
      name: member.firstName,
      gym: draft.supplier.displayName,
      documentTitle:
        draft.documentType === "TAX_INVOICE" ? "Tax Invoice" : "Bill",
      number,
      total: inr(draft.totals.totalMinor, draft.currency),
      due: inr(
        balance?.outstandingMinor ?? draft.totals.totalMinor,
        draft.currency,
      ),
    },
    link: `/m/invoices/${invoice.id}`,
    dedupeKey: `invoice:${invoice.id}`,
  });
  return tx.gymInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
}

// --- balances ------------------------------------------------------------------------------

export type InvoiceBalance = {
  totalMinor: number;
  allocatedMinor: number;
  creditedMinor: number;
  outstandingMinor: number;
};

/** total − live allocations − credit notes, never below zero (KPI "Outstanding dues"). */
export async function invoiceBalances(
  tx: TenantTransaction,
  invoiceIds: string[],
): Promise<Map<string, InvoiceBalance>> {
  if (invoiceIds.length === 0) return new Map();
  const [invoices, allocations, credits] = await inOrder([
    tx.gymInvoice.findMany({
      where: { id: { in: invoiceIds } },
      select: { id: true, totalMinor: true, status: true },
    }),
    tx.paymentAllocation.groupBy({
      by: ["invoiceId"],
      where: { invoiceId: { in: invoiceIds }, reversedAt: null },
      _sum: { amountMinor: true },
    }),
    tx.creditNote.groupBy({
      by: ["invoiceId"],
      where: { invoiceId: { in: invoiceIds } },
      _sum: { totalMinor: true },
    }),
  ]);
  const alloc = new Map(
    allocations.map((a) => [a.invoiceId, num(a._sum.amountMinor)]),
  );
  const cred = new Map(
    credits.map((c) => [c.invoiceId, num(c._sum.totalMinor)]),
  );
  return new Map(
    invoices.map((i) => {
      const total = num(i.totalMinor);
      const allocated = alloc.get(i.id) ?? 0;
      const credited = cred.get(i.id) ?? 0;
      const outstanding =
        i.status === "VOID" ? 0 : Math.max(0, total - allocated - credited);
      return [
        i.id,
        {
          totalMinor: total,
          allocatedMinor: allocated,
          creditedMinor: credited,
          outstandingMinor: outstanding,
        },
      ];
    }),
  );
}

/**
 * Status from balances: PAID when settled; REFUNDED / PARTIALLY_REFUNDED when a credit note took
 * back money already paid; VOID when an unpaid invoice was fully credited (cancelled).
 */
export function statusFromBalance(b: InvoiceBalance, voided: boolean) {
  if (voided) return "VOID" as const;
  const excess = b.allocatedMinor + b.creditedMinor - b.totalMinor;
  if (b.creditedMinor >= b.totalMinor && b.totalMinor > 0)
    return b.allocatedMinor > 0 ? ("REFUNDED" as const) : ("VOID" as const);
  if (b.creditedMinor > 0 && excess > 0 && b.allocatedMinor > 0)
    return "PARTIALLY_REFUNDED" as const;
  if (b.outstandingMinor === 0) return "PAID" as const;
  if (b.allocatedMinor > 0) return "PARTIALLY_PAID" as const;
  return "ISSUED" as const;
}

export async function refreshInvoiceStatuses(
  tx: TenantTransaction,
  invoiceIds: string[],
): Promise<void> {
  const balances = await invoiceBalances(tx, invoiceIds);
  const invoices = await tx.gymInvoice.findMany({
    where: { id: { in: invoiceIds } },
    select: { id: true, status: true, voidedAt: true },
  });
  for (const invoice of invoices) {
    const balance = balances.get(invoice.id);
    if (!balance) continue;
    const status = statusFromBalance(balance, invoice.voidedAt !== null);
    if (status !== invoice.status) {
      await tx.gymInvoice.update({
        where: { id: invoice.id },
        data: { status },
      });
    }
  }
}

export async function openInvoices(
  tx: TenantTransaction,
  memberId: string,
): Promise<OpenInvoice[]> {
  const invoices = await tx.gymInvoice.findMany({
    where: { memberId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
    select: { id: true, issueDate: true, number: true },
  });
  const balances = await invoiceBalances(
    tx,
    invoices.map((i) => i.id),
  );
  return invoices
    .map((i) => ({
      id: i.id,
      issueDate: fromDbDate(i.issueDate),
      number: i.number,
      outstandingMinor: balances.get(i.id)?.outstandingMinor ?? 0,
    }))
    .filter((i) => i.outstandingMinor > 0);
}

export async function creditBalance(
  tx: TenantTransaction,
  memberId: string,
): Promise<number> {
  const sum = await tx.memberCreditEntry.aggregate({
    where: { memberId },
    _sum: { amountMinor: true },
  });
  return num(sum._sum.amountMinor);
}

/** Uses the member's credit on their open invoices, oldest first. */
export async function applyCreditTx(
  tx: TenantTransaction,
  actor: Actor,
  tenantId: string,
  memberId: string,
): Promise<number> {
  const balance = await creditBalance(tx, memberId);
  if (balance <= 0) return 0;
  const open = await openInvoices(tx, memberId);
  if (open.length === 0) return 0;
  const plan = allocateOldestFirst(balance, open);
  let used = 0;
  for (const a of plan.allocations) {
    await tx.paymentAllocation.create({
      data: {
        tenantId,
        invoiceId: a.invoiceId,
        source: "CREDIT",
        amountMinor: a.amountMinor,
        createdById: actor.userId ?? null,
      },
    });
    await tx.memberCreditEntry.create({
      data: {
        tenantId,
        memberId,
        amountMinor: -a.amountMinor,
        kind: "APPLIED",
        invoiceId: a.invoiceId,
        createdById: actor.userId ?? null,
      },
    });
    used += a.amountMinor;
  }
  const touched = plan.allocations.map((a) => a.invoiceId);
  await refreshInvoiceStatuses(tx, touched);
  await activatePaidMemberships(tx, actor, tenantId, touched);
  if (used > 0) {
    await recordAudit(tx, actor, {
      action: "credit.applied",
      entityType: "MemberProfile",
      entityId: memberId,
      meta: { usedMinor: used },
    });
  }
  return used;
}

// --- access helpers -----------------------------------------------------------------------

async function loadMemberForBilling(
  tx: TenantTransaction,
  ctx: AuthContext,
  memberId: string,
  key: "billing.view" | "billing.collect" | "billing.refund" | "billing.void",
) {
  const member = await tx.memberProfile.findUnique({ where: { id: memberId } });
  if (!member) throw new AppError("NOT_FOUND", "Member not found.");
  if (!hasPermission(ctx, key, { branchId: member.homeBranchId })) {
    throw new AppError("FORBIDDEN", "You don't have permission to do that.");
  }
  return member;
}

function branchFilter(ctx: AuthContext, key: "billing.view") {
  const allowed = allowedBranchIds(ctx, key);
  return allowed === "ALL" ? {} : { branchId: { in: allowed } };
}

// --- payments ------------------------------------------------------------------------------

export const PAYMENT_METHODS = [
  "CASH",
  "UPI",
  "BANK_TRANSFER",
  "CARD_TERMINAL",
  "CHEQUE",
  "OTHER",
] as const;

export const recordPaymentSchema = z.object({
  memberId: z.uuid(),
  branchId: z.uuid().optional(),
  method: z.enum(PAYMENT_METHODS),
  amountMinor: z.coerce
    .number()
    .int()
    .positive("Enter an amount.")
    .max(10_000_000_00),
  receivedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.")
    .optional(),
  reference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(500).optional(),
  proofFileId: z.uuid().optional(),
  /** Explicit split; omitted = oldest invoice first. */
  allocations: z
    .array(
      z.object({
        invoiceId: z.uuid(),
        amountMinor: z.coerce.number().int().min(0),
      }),
    )
    .optional(),
});

/** Records a manual payment, allocates it, turns any excess into credit, and activates memberships. */
export async function recordPaymentTx(
  tx: TenantTransaction,
  ctx: AuthContext,
  input: z.infer<typeof recordPaymentSchema>,
  now: Date,
) {
  const member = await loadMemberForBilling(
    tx,
    ctx,
    input.memberId,
    "billing.collect",
  );
  const branchId = input.branchId ?? ctx.activeBranchId ?? member.homeBranchId;
  if (input.method !== "CASH" && input.method !== "OTHER" && !input.reference) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Add the transaction or cheque reference.",
      {
        fields: { reference: ["Add the transaction or cheque reference."] },
      },
    );
  }
  const today = todayIn(ctx.timezone, now);
  const receivedOn = input.receivedOn ?? today;
  if (receivedOn > today) {
    throw new AppError(
      "VALIDATION_FAILED",
      "A payment can't be in the future.",
      { fields: { receivedOn: ["A payment can't be in the future."] } },
    );
  }
  const open = await openInvoices(tx, member.id);
  let plan;
  try {
    plan = input.allocations
      ? allocateExplicit(input.amountMinor, open, input.allocations)
      : allocateOldestFirst(input.amountMinor, open);
  } catch (err) {
    if (err instanceof AllocationError)
      throw new AppError("VALIDATION_FAILED", err.message);
    throw err;
  }
  // Payments on a past date are stamped at noon tenant time; today's at the actual time.
  const receivedAt =
    receivedOn === today
      ? now
      : new Date(
          startOfDayUtc(receivedOn, ctx.timezone).getTime() + 12 * 3_600_000,
        );
  return persistPaymentTx(tx, ctx, ctx.tenantId, {
    member,
    branchId,
    method: input.method,
    amountMinor: input.amountMinor,
    reference: input.reference ?? null,
    notes: input.notes ?? null,
    proofFileId: input.proofFileId ?? null,
    receivedAt,
    receivedOn,
    today,
    receivedByUserId: ctx.userId,
    plan,
  });
}

export type PersistPaymentInput = {
  member: {
    id: string;
    userId: string | null;
    email: string | null;
    firstName: string;
  };
  branchId: string;
  method: (typeof PAYMENT_METHODS)[number] | "ONLINE";
  amountMinor: number;
  reference: string | null;
  notes: string | null;
  proofFileId: string | null;
  receivedAt: Date;
  receivedOn: LocalDate;
  today: LocalDate;
  receivedByUserId: string | null;
  plan: AllocationPlan;
  /** M4: online payments. */
  providerPaymentId?: string | null;
  paymentLinkId?: string | null;
};

/**
 * Writes a payment (manual or online): receipt number, allocations, overpayment credit, invoice
 * statuses, membership/PT activation, audit and the receipt notification — in the caller's
 * transaction.
 */
export async function persistPaymentTx(
  tx: TenantTransaction,
  actor: Actor,
  tenantId: string,
  p: PersistPaymentInput,
) {
  const receiptNumber = await nextDocumentNumber(
    tx,
    tenantId,
    "RECEIPT",
    "TENANT",
    p.today,
    "RC",
  );
  const payment = await tx.gymPayment.create({
    data: {
      tenantId,
      branchId: p.branchId,
      memberId: p.member.id,
      method: p.method,
      amountMinor: p.amountMinor,
      reference: p.reference,
      notes: p.notes,
      receivedAt: p.receivedAt,
      receivedByUserId: p.receivedByUserId,
      receiptNumber,
      proofFileId: p.proofFileId,
      providerPaymentId: p.providerPaymentId ?? null,
      paymentLinkId: p.paymentLinkId ?? null,
    },
  });
  for (const a of p.plan.allocations) {
    await tx.paymentAllocation.create({
      data: {
        tenantId,
        invoiceId: a.invoiceId,
        paymentId: payment.id,
        source: "PAYMENT",
        amountMinor: a.amountMinor,
        createdById: actor.userId ?? null,
      },
    });
  }
  if (p.plan.creditMinor > 0) {
    await tx.memberCreditEntry.create({
      data: {
        tenantId,
        memberId: p.member.id,
        amountMinor: p.plan.creditMinor,
        kind: "OVERPAYMENT",
        paymentId: payment.id,
        createdById: actor.userId ?? null,
        note: `Overpayment on receipt ${receiptNumber}`,
      },
    });
  }
  const touched = p.plan.allocations.map((a) => a.invoiceId);
  await refreshInvoiceStatuses(tx, touched);
  const activated = await activatePaidMemberships(tx, actor, tenantId, touched);
  await recordAudit(tx, actor, {
    action: p.providerPaymentId
      ? "payment.received_online"
      : "payment.recorded",
    entityType: "GymPayment",
    entityId: payment.id,
    branchId: p.branchId,
    after: {
      receiptNumber,
      method: p.method,
      amountMinor: p.amountMinor,
      allocations: p.plan.allocations,
      creditMinor: p.plan.creditMinor,
      ...(p.providerPaymentId
        ? { providerPaymentId: p.providerPaymentId }
        : {}),
    },
  });
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  await notify(tx, tenantId, {
    templateKey: "payment.received",
    recipient: {
      memberId: p.member.id,
      userId: p.member.userId,
      email: p.member.email,
    },
    data: {
      name: p.member.firstName,
      gym: tenant.displayName,
      amount: inr(p.amountMinor, tenant.currency),
      method:
        p.method === "ONLINE"
          ? "online payment"
          : p.method.replace("_", " ").toLowerCase(),
      date: p.receivedOn,
      receipt: receiptNumber,
    },
    link: "/m/invoices",
    dedupeKey: `payment:${payment.id}`,
  });
  return {
    payment,
    allocations: p.plan.allocations,
    creditMinor: p.plan.creditMinor,
    activatedMembershipIds: activated,
  };
}

export async function recordPayment(
  deps: CoreDeps,
  ctx: AuthContext,
  rawInput: unknown,
) {
  await guard(deps, ctx, { permission: "billing.collect", write: true });
  const input = parseInput(recordPaymentSchema, rawInput);
  return inTenant(deps, ctx, (tx) =>
    recordPaymentTx(tx, ctx, input, nowOf(deps)),
  );
}

const reasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason (at least 5 characters).")
  .max(500);

/**
 * Voids a payment: allocations are reversed (kept for history) and credit it created is taken
 * back. Refused if that credit was already used elsewhere. Memberships it activated stay active;
 * staff decide whether to freeze or cancel them (noted in the audit entry).
 */
export async function voidPayment(
  deps: CoreDeps,
  ctx: AuthContext,
  paymentId: string,
  rawReason: unknown,
) {
  await guard(deps, ctx, { permission: "billing.void", write: true });
  const reason = parseInput(reasonSchema, rawReason);
  return inTenant(deps, ctx, async (tx) => {
    const payment = await tx.gymPayment.findUnique({
      where: { id: paymentId },
      include: { allocations: true },
    });
    if (!payment) throw new AppError("NOT_FOUND", "Payment not found.");
    await loadMemberForBilling(tx, ctx, payment.memberId, "billing.void");
    if (payment.status === "VOID")
      throw new AppError("CONFLICT", "This payment is already void.");
    // M4: online money sits with the payment provider; it can only go back as a refund.
    if (payment.providerPaymentId)
      throw new AppError(
        "CONFLICT",
        "Online payments can't be voided. Refund it instead.",
      );
    const overpaid = await tx.memberCreditEntry.aggregate({
      where: { paymentId: payment.id, kind: "OVERPAYMENT" },
      _sum: { amountMinor: true },
    });
    const credit = num(overpaid._sum.amountMinor);
    if (credit > 0) {
      const balance = await creditBalance(tx, payment.memberId);
      if (balance < credit) {
        throw new AppError(
          "CONFLICT",
          "Part of this payment's credit was already used on another invoice. Issue a credit note there first.",
        );
      }
      await tx.memberCreditEntry.create({
        data: {
          tenantId: ctx.tenantId,
          memberId: payment.memberId,
          amountMinor: -credit,
          kind: "PAYMENT_VOID",
          paymentId: payment.id,
          createdById: ctx.userId,
          note: `Void of receipt ${payment.receiptNumber}`,
        },
      });
    }
    const now = nowOf(deps);
    await tx.paymentAllocation.updateMany({
      where: { paymentId: payment.id, reversedAt: null },
      data: { reversedAt: now },
    });
    await tx.gymPayment.update({
      where: { id: payment.id },
      data: {
        status: "VOID",
        voidedAt: now,
        voidReason: reason,
        voidedById: ctx.userId,
      },
    });
    const touched = payment.allocations.map((a) => a.invoiceId);
    await refreshInvoiceStatuses(tx, touched);
    const memberships = await tx.gymInvoice.findMany({
      where: { id: { in: touched }, membership: { status: "ACTIVE" } },
      select: { membershipId: true },
    });
    await recordAudit(tx, ctx, {
      action: "payment.voided",
      entityType: "GymPayment",
      entityId: payment.id,
      branchId: payment.branchId,
      before: { status: "SUCCEEDED", amountMinor: num(payment.amountMinor) },
      meta: {
        reason,
        activeMembershipsLeftActive: memberships.map((m) => m.membershipId),
      },
    });
    return { voided: true };
  });
}

export async function applyCredit(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
) {
  await guard(deps, ctx, { permission: "billing.collect", write: true });
  return inTenant(deps, ctx, async (tx) => {
    await loadMemberForBilling(tx, ctx, memberId, "billing.collect");
    const used = await applyCreditTx(tx, ctx, ctx.tenantId, memberId);
    if (used === 0)
      throw new AppError(
        "CONFLICT",
        "There is no credit or no open invoice to apply it to.",
      );
    return { usedMinor: used };
  });
}

// --- credit notes, voids, refunds ------------------------------------------------------------

const creditNoteSchema = z.object({
  amountMinor: z.coerce.number().int().positive("Enter an amount."),
  reason: reasonSchema,
});

/**
 * Issues a credit note (corrections, cancellations, refunds). Money already paid beyond what is
 * now owed moves to member credit, from where it can be refunded or reused.
 */
export async function issueCreditNoteTx(
  tx: TenantTransaction,
  actor: Actor,
  tenantId: string,
  invoiceId: string,
  input: { amountMinor: number; reason: string },
  today: LocalDate,
) {
  const invoice = await tx.gymInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found.");
  if (invoice.voidedAt) throw new AppError("CONFLICT", "This invoice is void.");
  const balance = (await invoiceBalances(tx, [invoiceId])).get(invoiceId)!;
  const creditable = balance.totalMinor - balance.creditedMinor;
  if (input.amountMinor > creditable) {
    throw new AppError(
      "VALIDATION_FAILED",
      `At most ${inr(creditable, invoice.currency)} can still be credited on this invoice.`,
      {
        fields: { amountMinor: ["More than the invoice has left to credit."] },
      },
    );
  }
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId } });
  const supplier = invoice.supplier as { gstin?: string | null };
  const number = await nextDocumentNumber(
    tx,
    tenantId,
    "CREDIT_NOTE",
    supplier.gstin ?? "UNREGISTERED",
    today,
    settings?.invoicePrefix ?? "INV",
  );
  const split = proportionalTaxSplit(input.amountMinor, {
    taxableMinor: num(invoice.taxableMinor),
    cgstMinor: num(invoice.cgstMinor),
    sgstMinor: num(invoice.sgstMinor),
    igstMinor: num(invoice.igstMinor),
    totalMinor: num(invoice.totalMinor),
  });
  const note = await tx.creditNote.create({
    data: {
      tenantId,
      invoiceId,
      number,
      issueDate: toDbDate(today),
      reason: input.reason,
      ...split,
      createdById: actor.userId ?? null,
      lines: {
        create: [
          {
            description:
              `Credit against ${invoice.number}: ${input.reason}`.slice(0, 200),
            ...split,
          },
        ],
      },
    },
  });
  // Paid more than is now owed? The excess becomes credit.
  const excess =
    balance.allocatedMinor -
    (balance.totalMinor - balance.creditedMinor - input.amountMinor);
  if (excess > 0) {
    await tx.memberCreditEntry.create({
      data: {
        tenantId,
        memberId: invoice.memberId,
        amountMinor: Math.min(excess, input.amountMinor),
        kind: "ADJUSTMENT",
        invoiceId,
        createdById: actor.userId ?? null,
        note: `Credit note ${number}`,
      },
    });
  }
  await refreshInvoiceStatuses(tx, [invoiceId]);
  await recordAudit(tx, actor, {
    action: "credit_note.issued",
    entityType: "CreditNote",
    entityId: note.id,
    branchId: invoice.branchId,
    after: {
      number,
      invoice: invoice.number,
      amountMinor: input.amountMinor,
      reason: input.reason,
    },
  });
  return note;
}

export async function issueCreditNote(
  deps: CoreDeps,
  ctx: AuthContext,
  invoiceId: string,
  rawInput: unknown,
) {
  await guard(deps, ctx, { permission: "billing.refund", write: true });
  const input = parseInput(creditNoteSchema, rawInput);
  return inTenant(deps, ctx, async (tx) => {
    const invoice = await tx.gymInvoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found.");
    await loadMemberForBilling(tx, ctx, invoice.memberId, "billing.refund");
    return issueCreditNoteTx(
      tx,
      ctx,
      ctx.tenantId,
      invoiceId,
      input,
      todayIn(ctx.timezone, nowOf(deps)),
    );
  });
}

/** Voids an invoice nobody has paid anything on. Its number stays used (gap-free series). */
export async function voidInvoice(
  deps: CoreDeps,
  ctx: AuthContext,
  invoiceId: string,
  rawReason: unknown,
) {
  await guard(deps, ctx, { permission: "billing.void", write: true });
  const reason = parseInput(reasonSchema, rawReason);
  return inTenant(deps, ctx, async (tx) => {
    const invoice = await tx.gymInvoice.findUnique({
      where: { id: invoiceId },
      include: { membership: true },
    });
    if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found.");
    await loadMemberForBilling(tx, ctx, invoice.memberId, "billing.void");
    const balance = (await invoiceBalances(tx, [invoiceId])).get(invoiceId)!;
    if (invoice.voidedAt)
      throw new AppError("CONFLICT", "This invoice is already void.");
    if (balance.allocatedMinor > 0 || balance.creditedMinor > 0) {
      throw new AppError(
        "CONFLICT",
        "Money or credit notes are already recorded on this invoice. Issue a credit note instead.",
      );
    }
    await tx.gymInvoice.update({
      where: { id: invoiceId },
      data: { status: "VOID", voidedAt: nowOf(deps), voidReason: reason },
    });
    // M3: an unpaid PT package sold on this invoice is cancelled with it.
    const ptCancelled = await tx.ptPackageBalance.updateMany({
      where: { invoiceId, status: "PENDING_PAYMENT" },
      data: { status: "CANCELLED", cancelledAt: nowOf(deps) },
    });
    await recordAudit(tx, ctx, {
      action: "invoice.voided",
      entityType: "GymInvoice",
      entityId: invoiceId,
      branchId: invoice.branchId,
      meta: {
        number: invoice.number,
        reason,
        ...(ptCancelled.count
          ? { ptPackagesCancelled: ptCancelled.count }
          : {}),
      },
    });
    return { voided: true, membershipId: invoice.membershipId };
  });
}

const refundSchema = z.object({
  memberId: z.uuid(),
  amountMinor: z.coerce.number().int().positive("Enter an amount."),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(100).optional(),
  reason: reasonSchema,
});

/**
 * Records money handed back outside the gateway (cash, bank transfer). Paid out of the member's
 * credit, which a credit note creates. Online refunds are M4.
 */
export async function recordManualRefundTx(
  tx: TenantTransaction,
  ctx: AuthContext,
  input: z.infer<typeof refundSchema>,
) {
  await loadMemberForBilling(tx, ctx, input.memberId, "billing.refund");
  const balance = await creditBalance(tx, input.memberId);
  if (input.amountMinor > balance) {
    throw new AppError(
      "VALIDATION_FAILED",
      `The member only has ${inr(balance)} of credit. Issue a credit note first.`,
    );
  }
  const entry = await tx.memberCreditEntry.create({
    data: {
      tenantId: ctx.tenantId,
      memberId: input.memberId,
      amountMinor: -input.amountMinor,
      kind: "MANUAL_REFUND",
      createdById: ctx.userId,
      note: `${input.method.replace("_", " ").toLowerCase()}${input.reference ? ` ${input.reference}` : ""}: ${input.reason}`,
    },
  });
  await recordAudit(tx, ctx, {
    action: "refund.recorded",
    entityType: "MemberProfile",
    entityId: input.memberId,
    after: {
      amountMinor: input.amountMinor,
      method: input.method,
      reference: input.reference ?? null,
    },
    meta: { reason: input.reason },
  });
  return entry;
}

export async function recordManualRefund(
  deps: CoreDeps,
  ctx: AuthContext,
  rawInput: unknown,
) {
  await guard(deps, ctx, { permission: "billing.refund", write: true });
  const input = parseInput(refundSchema, rawInput);
  return inTenant(deps, ctx, (tx) => recordManualRefundTx(tx, ctx, input));
}

// --- reads ---------------------------------------------------------------------------------

export async function memberFinancialSummary(
  tx: TenantTransaction,
  memberId: string,
) {
  const [invoiced, paid, credit] = await inOrder([
    tx.gymInvoice.aggregate({
      where: { memberId, voidedAt: null },
      _sum: { totalMinor: true },
    }),
    tx.gymPayment.aggregate({
      where: { memberId, status: "SUCCEEDED" },
      _sum: { amountMinor: true },
    }),
    tx.memberCreditEntry.aggregate({
      where: { memberId },
      _sum: { amountMinor: true },
    }),
  ]);
  const open = await openInvoices(tx, memberId);
  return {
    invoicedMinor: num(invoiced._sum.totalMinor),
    paidMinor: num(paid._sum.amountMinor),
    outstandingMinor: open.reduce((s, i) => s + i.outstandingMinor, 0),
    creditMinor: num(credit._sum.amountMinor),
  };
}

export async function getInvoice(
  deps: CoreDeps,
  ctx: AuthContext,
  invoiceId: string,
) {
  return inTenant(deps, ctx, async (tx) => {
    const invoice = await tx.gymInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        lines: { orderBy: { position: "asc" } },
        allocations: {
          include: { payment: true },
          orderBy: { createdAt: "asc" },
        },
        creditNotes: { orderBy: { createdAt: "asc" } },
        member: true,
      },
    });
    if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found.");
    if (!hasPermission(ctx, "billing.view", { branchId: invoice.branchId })) {
      throw new AppError(
        "FORBIDDEN",
        "You don't have permission to see this invoice.",
      );
    }
    const balance = (await invoiceBalances(tx, [invoiceId])).get(invoiceId)!;
    return { invoice, balance };
  });
}

const listInvoicesSchema = z.object({
  status: z.enum(["open", "paid", "void", "all"]).default("all"),
  memberId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export async function listInvoices(
  deps: CoreDeps,
  ctx: AuthContext,
  rawInput: unknown,
) {
  await guard(deps, ctx, { permission: "billing.view" });
  const input = parseInput(listInvoicesSchema, rawInput);
  const pageSize = 25;
  const where: Prisma.GymInvoiceWhereInput = {
    ...branchFilter(ctx, "billing.view"),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.memberId ? { memberId: input.memberId } : {}),
    ...(input.status === "open"
      ? { status: { in: ["ISSUED", "PARTIALLY_PAID"] } }
      : {}),
    ...(input.status === "paid" ? { status: "PAID" } : {}),
    ...(input.status === "void" ? { status: "VOID" } : {}),
    ...(input.from || input.to
      ? {
          issueDate: {
            ...(input.from ? { gte: toDbDate(input.from) } : {}),
            ...(input.to ? { lt: toDbDate(input.to) } : {}),
          },
        }
      : {}),
  };
  return inTenant(deps, ctx, async (tx) => {
    const [rows, total] = await inOrder([
      tx.gymInvoice.findMany({
        where,
        include: {
          member: {
            select: { firstName: true, lastName: true, memberCode: true },
          },
        },
        orderBy: [{ issueDate: "desc" }, { number: "desc" }],
        skip: (input.page - 1) * pageSize,
        take: pageSize,
      }),
      tx.gymInvoice.count({ where }),
    ]);
    const balances = await invoiceBalances(
      tx,
      rows.map((r) => r.id),
    );
    return {
      rows: rows.map((r) => ({ ...r, balance: balances.get(r.id)! })),
      total,
      page: input.page,
      pageSize,
    };
  });
}

const listPaymentsSchema = z.object({
  memberId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export async function listPayments(
  deps: CoreDeps,
  ctx: AuthContext,
  rawInput: unknown,
) {
  await guard(deps, ctx, { permission: "billing.view" });
  const input = parseInput(listPaymentsSchema, rawInput);
  const pageSize = 25;
  const where: Prisma.GymPaymentWhereInput = {
    ...branchFilter(ctx, "billing.view"),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.memberId ? { memberId: input.memberId } : {}),
    ...(input.from || input.to
      ? {
          receivedAt: {
            ...(input.from ? { gte: new Date(input.from) } : {}),
            ...(input.to ? { lt: new Date(input.to) } : {}),
          },
        }
      : {}),
  };
  return inTenant(deps, ctx, async (tx) => {
    const [rows, total] = await inOrder([
      tx.gymPayment.findMany({
        where,
        include: {
          member: {
            select: { firstName: true, lastName: true, memberCode: true },
          },
          allocations: { include: { invoice: { select: { number: true } } } },
        },
        orderBy: { receivedAt: "desc" },
        skip: (input.page - 1) * pageSize,
        take: pageSize,
      }),
      tx.gymPayment.count({ where }),
    ]);
    return { rows, total, page: input.page, pageSize };
  });
}
