import { randomBytes } from "node:crypto";
import { withTenant, type TenantTransaction } from "@gym/db";
import { ProviderError } from "@gym/integrations/payments";
import { z } from "zod";
import { recordAudit, type AuditActor } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "../authz";
import { invoiceBalances, num, openInvoices } from "../billing/service";
import { AppError } from "../errors";
import type { MemberContext } from "../members/self";
import { memberName } from "../members/service";
import { memberBuyPlanTx, memberRenewTx } from "../memberships/service";
import { formatMoney, money } from "../money";
import { notify } from "../notifications";
import { checkEntitlement } from "../entitlements";
import {
  entitlementsFor,
  guard,
  inTenant,
  nowOf,
  type CoreDeps,
} from "../tenancy/deps";
import { todayIn } from "../time/dates";
import { parseInput } from "../validation";
import {
  providerFor,
  requireIntegrationTx,
  type IntegrationRow,
} from "./integration";
import { newReferenceId } from "./rules";
import { syncPaymentLink } from "./sync";

type LinkPurpose = "INVOICES" | "BALANCE" | "RENEWAL" | "PURCHASE";

const inMember = <T>(
  deps: CoreDeps,
  mctx: MemberContext,
  fn: (tx: TenantTransaction) => Promise<T>,
) => withTenant(deps.db, mctx.tenantId, fn, { userId: mctx.userId });

/**
 * Creates a link in three steps so a provider failure never leaves money unaccounted:
 * 1) our row (CREATED, unique reference id) in a transaction, 2) the provider call with that
 * reference id (the provider refuses duplicates), 3) store the provider id and URL. If (2) fails
 * the row is cancelled and the error explained.
 */
async function createLink(
  deps: CoreDeps,
  actor: AuditActor & { userId?: string | null },
  tenantId: string,
  input: {
    memberId: string;
    invoiceIds: string[];
    purpose: LinkPurpose;
    acceptPartial: boolean;
    minPartialMinor: number | null;
    description: string;
    callbackPath: string | null;
    createdByUserId: string | null;
    amountMinor?: number;
  },
) {
  const now = nowOf(deps);
  // Plan feature (402 when the gym's plan has no online payments), for staff and member links.
  checkEntitlement(
    await entitlementsFor(deps, tenantId),
    "online_payments.enabled",
  );
  const prepared = await withTenant(deps.db, tenantId, async (tx) => {
    const integration = await requireIntegrationTx(tx);
    const member = await tx.memberProfile.findUniqueOrThrow({
      where: { id: input.memberId },
    });
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId },
    });
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    const balances = await invoiceBalances(tx, input.invoiceIds);
    const invoices = await tx.gymInvoice.findMany({
      where: { id: { in: input.invoiceIds } },
    });
    if (
      invoices.length !== input.invoiceIds.length ||
      invoices.some((i) => i.memberId !== member.id)
    )
      throw new AppError("NOT_FOUND", "Invoice not found.");
    const outstanding = input.invoiceIds.reduce(
      (s, id) => s + (balances.get(id)?.outstandingMinor ?? 0),
      0,
    );
    if (outstanding <= 0)
      throw new AppError("CONFLICT", "Nothing is due on these invoices.");
    const amount = Math.min(input.amountMinor ?? outstanding, outstanding);
    const minPartial = input.acceptPartial
      ? Math.min(Math.max(input.minPartialMinor ?? 100, 100), amount)
      : null;
    const expiresAt = new Date(
      Math.max(
        now.getTime() + (settings?.paymentLinkExpiryDays ?? 7) * 86_400_000,
        now.getTime() + 20 * 60_000,
      ),
    );
    const link = await tx.paymentLink.create({
      data: {
        tenantId,
        integrationId: integration.id,
        memberId: member.id,
        branchId: invoices[0]!.branchId,
        referenceId: newReferenceId(
          "GL",
          randomBytes(12).toString("base64url"),
        ),
        purpose: input.purpose,
        amountMinor: amount,
        currency: tenant.currency,
        acceptPartial:
          input.acceptPartial && minPartial !== null && minPartial < amount,
        minPartialMinor: minPartial,
        expiresAt,
        createdByUserId: input.createdByUserId,
      },
    });
    await tx.paymentLinkInvoice.createMany({
      data: input.invoiceIds.map((invoiceId, position) => ({
        tenantId,
        linkId: link.id,
        invoiceId,
        position,
      })),
    });
    return { integration, member, link, tenant, invoices };
  });
  const { integration, member, link } = prepared;
  let remote;
  try {
    remote = await providerFor(
      deps,
      integration as IntegrationRow,
    ).createPaymentLink({
      amountMinor: num(link.amountMinor),
      currency: link.currency,
      referenceId: link.referenceId,
      description: input.description,
      acceptPartial: link.acceptPartial,
      minPartialMinor: link.minPartialMinor
        ? num(link.minPartialMinor)
        : undefined,
      expiresAt: link.expiresAt ?? undefined,
      customer: {
        name: memberName(member),
        email: member.email,
        contact: member.phone,
      },
      callbackUrl:
        input.callbackPath && deps.appUrl
          ? `${deps.appUrl}${input.callbackPath.replace("{linkId}", link.id)}`
          : undefined,
      notes: { tenantId, linkId: link.id, integrationId: integration.id },
    });
  } catch (err) {
    await withTenant(deps.db, tenantId, (tx) =>
      tx.paymentLink.update({
        where: { id: link.id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      }),
    );
    throw new AppError(
      "PROVIDER_ERROR",
      `Razorpay couldn't create the payment link${err instanceof ProviderError ? `: ${err.message}` : "."} Try again in a minute.`,
    );
  }
  return withTenant(deps.db, tenantId, async (tx) => {
    const saved = await tx.paymentLink.update({
      where: { id: link.id },
      data: {
        providerLinkId: remote.id,
        shortUrl: remote.shortUrl,
        expiresAt: remote.expiresAt ?? link.expiresAt,
      },
    });
    await recordAudit(tx, actor, {
      action: "payment_link.created",
      entityType: "PaymentLink",
      entityId: saved.id,
      branchId: saved.branchId,
      after: {
        purpose: saved.purpose,
        amountMinor: num(saved.amountMinor),
        acceptPartial: saved.acceptPartial,
        invoices: prepared.invoices.map((i) => i.number),
      },
    });
    return saved;
  });
}

// --- staff ----------------------------------------------------------------------------------

const staffLinkSchema = z.object({
  invoiceIds: z.preprocess(
    (v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : v),
    z.array(z.uuid()).min(1, "Pick an invoice.").max(20),
  ),
  acceptPartial: z
    .union([z.boolean(), z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === true || v === "on"),
  /** Rupees, e.g. "500". */
  minPartial: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().positive().optional(),
  ),
  sendEmail: z
    .union([z.boolean(), z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === true || v === "on"),
});

/** Staff: a link for one or more open invoices of one member, optionally emailed. */
export async function sendPaymentLink(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, {
    permission: "billing.collect",
    write: true,
    entitlement: "online_payments.enabled",
  });
  const input = parseInput(staffLinkSchema, raw);
  const first = await inTenant(deps, ctx, (tx) =>
    tx.gymInvoice.findUnique({
      where: { id: input.invoiceIds[0]! },
      include: { member: true },
    }),
  );
  if (!first) throw new AppError("NOT_FOUND", "Invoice not found.");
  requirePermission(ctx, "billing.collect", {
    branchId: first.member.homeBranchId,
  });
  const numbers = await inTenant(deps, ctx, (tx) =>
    tx.gymInvoice.findMany({
      where: { id: { in: input.invoiceIds } },
      select: { number: true },
    }),
  );
  const link = await createLink(deps, ctx, ctx.tenantId, {
    memberId: first.memberId,
    invoiceIds: input.invoiceIds,
    purpose: "INVOICES",
    acceptPartial: input.acceptPartial,
    minPartialMinor: input.minPartial
      ? Math.round(input.minPartial * 100)
      : null,
    description: `Invoice ${numbers.map((n) => n.number).join(", ")}`,
    callbackPath: "/m/pay/return?link={linkId}",
    createdByUserId: ctx.userId,
  });
  if (input.sendEmail)
    await inTenant(deps, ctx, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
      });
      await notify(tx, ctx.tenantId, {
        templateKey: "payment.link",
        recipient: {
          memberId: first.memberId,
          userId: first.member.userId,
          email: first.member.email,
        },
        data: {
          name: first.member.firstName,
          gym: tenant.displayName,
          amount: formatMoney(money(num(link.amountMinor), link.currency)),
          what: numbers.map((n) => n.number).join(", "),
          url: link.shortUrl,
          expires:
            link.expiresAt?.toLocaleDateString("en-IN", {
              timeZone: ctx.timezone,
              dateStyle: "medium",
            }) ?? "",
        },
        link: link.shortUrl,
        dedupeKey: `link:${link.id}`,
      });
    });
  return link;
}

export async function cancelPaymentLink(
  deps: CoreDeps,
  ctx: AuthContext,
  linkId: string,
) {
  await guard(deps, ctx, { permission: "billing.collect", write: true });
  const link = await inTenant(deps, ctx, (tx) =>
    tx.paymentLink.findUnique({
      where: { id: linkId },
      include: { integration: true },
    }),
  );
  if (!link) throw new AppError("NOT_FOUND", "Link not found.");
  requirePermission(ctx, "billing.collect", { branchId: link.branchId });
  if (link.status !== "CREATED" && link.status !== "PARTIALLY_PAID")
    throw new AppError("CONFLICT", "This link can't be cancelled any more.");
  if (link.providerLinkId) {
    try {
      await providerFor(
        deps,
        link.integration as IntegrationRow,
      ).cancelPaymentLink(link.providerLinkId);
    } catch (err) {
      // Paid in the meantime? Sync instead of cancelling.
      await syncPaymentLink(deps, ctx.tenantId, link.id);
      throw new AppError(
        "CONFLICT",
        `Razorpay didn't cancel the link${err instanceof ProviderError ? `: ${err.message}` : ""}. It may have just been paid; check the invoice.`,
      );
    }
  }
  return inTenant(deps, ctx, async (tx) => {
    const updated = await tx.paymentLink.update({
      where: { id: link.id },
      data: {
        status: link.amountPaidMinor > 0n ? "PARTIALLY_PAID" : "CANCELLED",
        cancelledAt: nowOf(deps),
      },
    });
    await recordAudit(tx, ctx, {
      action: "payment_link.cancelled",
      entityType: "PaymentLink",
      entityId: link.id,
      branchId: link.branchId,
    });
    return updated;
  });
}

const listSchema = z.object({
  status: z.enum(["open", "all"]).default("all"),
  memberId: z.uuid().optional(),
  invoiceId: z.uuid().optional(),
});

export async function listPaymentLinks(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "billing.view" });
  const input = parseInput(listSchema, raw);
  const allowed = allowedBranchIds(ctx, "billing.view");
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.paymentLink.findMany({
      where: {
        ...(allowed === "ALL" ? {} : { branchId: { in: allowed } }),
        ...(input.status === "open"
          ? { status: { in: ["CREATED", "PARTIALLY_PAID"] } }
          : {}),
        ...(input.memberId ? { memberId: input.memberId } : {}),
        ...(input.invoiceId
          ? { invoices: { some: { invoiceId: input.invoiceId } } }
          : {}),
        providerLinkId: { not: null },
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
        invoices: { include: { invoice: { select: { number: true } } } },
      },
    });
    return rows.map((l) => ({
      id: l.id,
      status: l.status,
      purpose: l.purpose,
      amountMinor: num(l.amountMinor),
      amountPaidMinor: num(l.amountPaidMinor),
      acceptPartial: l.acceptPartial,
      shortUrl: l.shortUrl,
      expiresAt: l.expiresAt,
      createdAt: l.createdAt,
      member: { ...l.member, name: memberName(l.member) },
      invoices: l.invoices.map((i) => i.invoice.number),
      canCancel:
        (l.status === "CREATED" || l.status === "PARTIALLY_PAID") &&
        hasPermission(ctx, "billing.collect", { branchId: l.branchId }),
    }));
  });
}

/** Staff "re-check": fetch the link from the provider now. */
export async function recheckPaymentLink(
  deps: CoreDeps,
  ctx: AuthContext,
  linkId: string,
) {
  await guard(deps, ctx, { permission: "billing.view" });
  const link = await inTenant(deps, ctx, (tx) =>
    tx.paymentLink.findUnique({ where: { id: linkId } }),
  );
  if (!link) throw new AppError("NOT_FOUND", "Link not found.");
  requirePermission(ctx, "billing.view", { branchId: link.branchId });
  return syncPaymentLink(deps, ctx.tenantId, link.id);
}

// --- member app -----------------------------------------------------------------------------

function memberActor(mctx: MemberContext) {
  return {
    kind: "member" as const,
    tenantId: mctx.tenantId,
    userId: mctx.userId,
    memberId: mctx.memberId,
  };
}

/** Is online payment available at this gym (for showing the buttons)? */
export async function onlinePaymentsEnabled(
  deps: CoreDeps,
  mctx: MemberContext,
) {
  const ent = await entitlementsFor(deps, mctx.tenantId);
  return inMember(deps, mctx, async (tx) => {
    const integration = await tx.paymentIntegration.findFirst({
      where: { status: "ACTIVE" },
    });
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId: mctx.tenantId },
    });
    return {
      enabled: !!integration && ent.values["online_payments.enabled"] === true,
      partialAllowed: settings?.onlinePartialAllowed ?? true,
      minPartialMinor: num(settings?.onlineMinPartialMinor ?? 50000),
    };
  });
}

const balanceSchema = z.object({
  /** Rupees; omitted = everything due. */
  amount: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().positive().optional(),
  ),
});

/**
 * Member pays their balance: one link over all open invoices (oldest first). If the gym allows
 * partial payments the member may pay part of it (at least the gym's minimum).
 */
export async function payMyBalance(
  deps: CoreDeps,
  mctx: MemberContext,
  raw: unknown,
) {
  const input = parseInput(balanceSchema, raw);
  const { invoices, settings } = await inMember(deps, mctx, async (tx) => ({
    invoices: (await openInvoices(tx, mctx.memberId)).sort((a, b) =>
      a.issueDate < b.issueDate ? -1 : 1,
    ),
    settings: await tx.tenantSettings.findUnique({
      where: { tenantId: mctx.tenantId },
    }),
  }));
  if (invoices.length === 0)
    throw new AppError("CONFLICT", "You have nothing to pay. Thank you!");
  const due = invoices.reduce((s, i) => s + i.outstandingMinor, 0);
  const minPartial = num(settings?.onlineMinPartialMinor ?? 50000);
  const partialAllowed = settings?.onlinePartialAllowed ?? true;
  let amount = due;
  if (input.amount !== undefined) {
    amount = Math.round(input.amount * 100);
    if (amount < due && !partialAllowed)
      throw new AppError(
        "VALIDATION_FAILED",
        "This gym takes the full amount online.",
        {
          fields: { amount: ["Pay the full amount."] },
        },
      );
    if (amount < Math.min(minPartial, due))
      throw new AppError(
        "VALIDATION_FAILED",
        `Pay at least ${formatMoney(money(Math.min(minPartial, due)))}.`,
        {
          fields: {
            amount: [
              `At least ${formatMoney(money(Math.min(minPartial, due)))}.`,
            ],
          },
        },
      );
    amount = Math.min(amount, due);
  }
  return createLink(
    deps,
    { tenantId: mctx.tenantId, userId: mctx.userId },
    mctx.tenantId,
    {
      memberId: mctx.memberId,
      invoiceIds: invoices.map((i) => i.id),
      purpose: "BALANCE",
      acceptPartial: false,
      minPartialMinor: null,
      description: `Balance: ${invoices.map((i) => i.number).join(", ")}`,
      callbackPath: "/m/pay/return?link={linkId}",
      createdByUserId: null,
      amountMinor: amount,
    },
  );
}

/** Member renews their current membership online: renewal invoice + link. */
export async function renewMyMembership(
  deps: CoreDeps,
  mctx: MemberContext,
  membershipId: string,
) {
  const today = todayIn(mctx.timezone, nowOf(deps));
  const sale = await inMember(deps, mctx, async (tx) => {
    await requireIntegrationTx(tx);
    return memberRenewTx(tx, memberActor(mctx), membershipId, today);
  });
  const invoiceId =
    sale.invoice?.id ??
    (
      await inMember(deps, mctx, (tx) =>
        tx.gymInvoice.findFirst({
          where: { membershipId: sale.membership.id },
          select: { id: true },
        }),
      )
    )?.id;
  if (!invoiceId)
    throw new AppError("CONFLICT", "Couldn't find the renewal invoice.");
  return createLink(
    deps,
    { tenantId: mctx.tenantId, userId: mctx.userId },
    mctx.tenantId,
    {
      memberId: mctx.memberId,
      invoiceIds: [invoiceId],
      purpose: "RENEWAL",
      acceptPartial: false,
      minPartialMinor: null,
      description: "Membership renewal",
      callbackPath: "/m/pay/return?link={linkId}",
      createdByUserId: null,
    },
  );
}

/** Plans this member may buy in the app. */
export async function plansForMe(deps: CoreDeps, mctx: MemberContext) {
  return inMember(deps, mctx, async (tx) => {
    const member = await tx.memberProfile.findUniqueOrThrow({
      where: { id: mctx.memberId },
    });
    const plans = await tx.membershipPlan.findMany({
      where: { status: "ACTIVE", onlinePurchase: true },
      include: { branches: true },
      orderBy: { priceMinor: "asc" },
    });
    return plans
      .filter(
        (p) =>
          p.branches.length === 0 ||
          p.branches.some((b) => b.branchId === member.homeBranchId),
      )
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        priceMinor: num(p.priceMinor),
        joiningFeeMinor: num(p.joiningFeeMinor),
        duration: `${p.durationCount} ${p.durationUnit.toLowerCase()}${p.durationCount === 1 ? "" : "s"}`,
      }));
  });
}

/** Member buys a plan online: pending membership + invoice + link. */
export async function buyPlanOnline(
  deps: CoreDeps,
  mctx: MemberContext,
  planId: string,
) {
  const today = todayIn(mctx.timezone, nowOf(deps));
  const { invoice } = await inMember(deps, mctx, async (tx) => {
    await requireIntegrationTx(tx);
    return memberBuyPlanTx(
      tx,
      memberActor(mctx),
      z.uuid().parse(planId),
      today,
    );
  });
  return createLink(
    deps,
    { tenantId: mctx.tenantId, userId: mctx.userId },
    mctx.tenantId,
    {
      memberId: mctx.memberId,
      invoiceIds: [invoice.id],
      purpose: "PURCHASE",
      acceptPartial: false,
      minPartialMinor: null,
      description: "Membership",
      callbackPath: "/m/pay/return?link={linkId}",
      createdByUserId: null,
    },
  );
}

/**
 * The return page polls this. It never trusts the redirect's query string: it reports what we
 * have recorded, and (at most every few seconds) asks the provider directly — a verified source —
 * in case the webhook is late.
 */
export async function myPaymentStatus(
  deps: CoreDeps,
  mctx: MemberContext,
  linkId: string,
) {
  const link = await inMember(deps, mctx, (tx) =>
    tx.paymentLink.findUnique({ where: { id: z.uuid().parse(linkId) } }),
  );
  if (!link || link.memberId !== mctx.memberId)
    throw new AppError("NOT_FOUND", "Payment not found.");
  const stale =
    !link.lastSyncedAt || Date.now() - link.lastSyncedAt.getTime() > 5_000;
  if (
    (link.status === "CREATED" || link.status === "PARTIALLY_PAID") &&
    stale
  ) {
    try {
      await syncPaymentLink(deps, mctx.tenantId, link.id);
    } catch {
      /* the webhook or reconciliation will catch up */
    }
  }
  const fresh = await inMember(deps, mctx, (tx) =>
    tx.paymentLink.findUniqueOrThrow({ where: { id: link.id } }),
  );
  return {
    status: fresh.status,
    amountMinor: num(fresh.amountMinor),
    amountPaidMinor: num(fresh.amountPaidMinor),
    purpose: fresh.purpose,
    shortUrl: fresh.shortUrl,
  };
}
