import type { Prisma, PrismaClient } from "@gym/db";
import {
  parseRazorpayWebhook,
  verifyWebhookSignature,
  type ProviderSubscription,
  type SubscriptionProvider,
} from "@gym/integrations/payments";
import { z } from "zod";
import { computeTaxLine, sumTotals, supplyType } from "../billing/tax";
import { checkGstin, GSTIN_MESSAGES, isGstStateCode } from "../gst";
import type { SecretBox } from "../crypto/secret-box";
import type { EntitlementCache } from "../entitlements";
import { AppError } from "../errors";
import { formatMoney, money } from "../money";
import { redactPayload } from "../payments/sync";
import {
  dunningStage,
  monthlyEquivalent,
  saasStatusFrom,
  trialReminderDue,
  type SaasStatus,
} from "../payments/rules";
import {
  requirePlatformPermission,
  type PlatformContext,
} from "../platform/context";
import { recordPlatformAudit } from "../platform/services";
import { readPlatformSettings } from "../platform-settings";
import { indianFinancialYear } from "../time";
import { addDays, todayIn, toDbDate } from "../time/dates";
import { parseInput } from "../validation";

/**
 * SaaS billing (M4 §6): what a gym pays the operator, through the operator's own Razorpay account.
 * Runs on the gym_platform role and touches only `platform` tables (spec §5: SaaS and gym billing
 * share no tables). Status changes come from verified platform webhooks only, plus the clock
 * (grace ends, period ends).
 */
export type BillingDeps = {
  /** gym_platform client. */
  db: PrismaClient;
  entitlements: EntitlementCache;
  secrets: SecretBox;
  subscriptions: (account: {
    provider: "RAZORPAY" | "FAKE";
    keyId: string;
    keySecret: string;
  }) => SubscriptionProvider;
  /** Emails to gym owners (dunning, trial reminders). */
  mailer?: (message: {
    to: string;
    subject: string;
    text: string;
  }) => Promise<void>;
  /** Public URL of the gym app (links in emails). */
  appUrl?: string;
  now?: () => Date;
  /** Allow the fake provider (development and tests only). */
  allowFake?: boolean;
};

type Tx = Prisma.TransactionClient;
const nowOf = (d: Pick<BillingDeps, "now">) => (d.now ? d.now() : new Date());
const DAY = 86_400_000;
const TOTAL_COUNT = { MONTHLY: 120, HALF_YEARLY: 20, YEARLY: 10 } as const;
const CYCLE_LABEL = {
  MONTHLY: "monthly",
  HALF_YEARLY: "every 6 months",
  YEARLY: "yearly",
} as const;

async function tenantAudit(
  tx: Tx,
  tenantId: string,
  ctx: PlatformContext | null,
  action: string,
  meta: Record<string, unknown>,
) {
  await tx.$executeRaw`SELECT platform_api.record_tenant_audit(
    ${tenantId}::uuid, ${ctx?.platformUserId ?? null}::uuid, ${action}, 'TenantSubscription', ${tenantId},
    ${JSON.stringify(meta)}::jsonb)`;
}

// --- the operator's payment account ---------------------------------------------------------

async function account(deps: BillingDeps) {
  const row = await deps.db.platformPaymentAccount.findFirst({
    where: { active: true },
  });
  if (!row)
    throw new AppError(
      "CONFLICT",
      "The platform's payment account isn't set up yet. Contact support.",
      {
        details: { code: "NOT_CONNECTED" },
      },
    );
  return row;
}

function providerOf(
  deps: BillingDeps,
  row: { provider: string; keyId: string; keySecretEnc: string },
) {
  return deps.subscriptions({
    provider: row.provider === "FAKE" ? "FAKE" : "RAZORPAY",
    keyId: row.keyId,
    keySecret: deps.secrets.decrypt(row.keySecretEnc).toString("utf8"),
  });
}

export async function getPlatformPaymentAccount(
  deps: BillingDeps,
  ctx: PlatformContext,
) {
  requirePlatformPermission(ctx, "platform.billing.view");
  const row = await deps.db.platformPaymentAccount.findFirst({
    where: { active: true },
  });
  return row
    ? {
        provider: row.provider,
        mode: row.mode,
        keyId: row.keyId,
        secretLast4: row.secretLast4,
        lastVerifiedAt: row.lastVerifiedAt,
      }
    : null;
}

const accountSchema = z.object({
  provider: z.enum(["RAZORPAY", "FAKE"]).default("RAZORPAY"),
  mode: z.enum(["TEST", "LIVE"]),
  keyId: z.string().trim().min(8).max(64),
  keySecret: z.string().trim().min(8).max(128),
  webhookSecret: z.string().trim().min(8).max(128),
});

export async function setPlatformPaymentAccount(
  deps: BillingDeps,
  ctx: PlatformContext,
  raw: unknown,
) {
  requirePlatformPermission(ctx, "platform.billing.manage");
  const input = parseInput(accountSchema, raw);
  if (input.provider === "FAKE" && !deps.allowFake)
    throw new AppError(
      "FORBIDDEN",
      "The test provider is only available in development.",
    );
  const check = await deps
    .subscriptions({
      provider: input.provider,
      keyId: input.keyId,
      keySecret: input.keySecret,
    })
    .verifyCredentials();
  if (!check.ok)
    throw new AppError("VALIDATION_FAILED", check.reason, {
      fields: { keySecret: [check.reason] },
    });
  await deps.db.$transaction(async (tx) => {
    await tx.platformPaymentAccount.updateMany({
      where: { active: true },
      data: { active: false },
    });
    await tx.platformPaymentAccount.create({
      data: {
        provider: input.provider,
        mode: input.mode,
        keyId: input.keyId,
        keySecretEnc: deps.secrets.encrypt(input.keySecret),
        webhookSecretEnc: deps.secrets.encrypt(input.webhookSecret),
        secretLast4: input.keySecret.slice(-4),
        lastVerifiedAt: nowOf(deps),
        updatedById: ctx.platformUserId,
      },
    });
    await recordPlatformAudit(tx, ctx, {
      action: "platform.payment_account_set",
      entityType: "PlatformPaymentAccount",
      after: {
        provider: input.provider,
        mode: input.mode,
        keyId: input.keyId,
        secretLast4: input.keySecret.slice(-4),
      },
    });
  });
}

// --- prices ---------------------------------------------------------------------------------

export async function listPrices(db: Pick<PrismaClient, "saasPlanPrice">) {
  const rows = await db.saasPlanPrice.findMany({
    where: { active: true, plan: { status: "ACTIVE" } },
    include: {
      plan: {
        select: {
          id: true,
          code: true,
          name: true,
          version: true,
          description: true,
        },
      },
    },
    orderBy: [{ amountMinor: "asc" }],
  });
  return rows.map((p) => ({
    id: p.id,
    cycle: p.cycle,
    amountMinor: Number(p.amountMinor),
    monthlyMinor: monthlyEquivalent(Number(p.amountMinor), p.cycle),
    currency: p.currency,
    providerPlanId: p.providerPlanId,
    plan: p.plan,
  }));
}

const priceSchema = z.object({
  amount: z.coerce.number().positive().max(10_000_000),
});

/** Changing a price detaches it from the provider plan (Razorpay plans are immutable). */
export async function updatePrice(
  deps: BillingDeps,
  ctx: PlatformContext,
  priceId: string,
  raw: unknown,
) {
  requirePlatformPermission(ctx, "platform.billing.manage");
  const { amount } = parseInput(priceSchema, raw);
  const before = await deps.db.saasPlanPrice.findUnique({
    where: { id: priceId },
  });
  if (!before) throw new AppError("NOT_FOUND", "Price not found.");
  await deps.db.$transaction(async (tx) => {
    await tx.saasPlanPrice.update({
      where: { id: priceId },
      data: {
        amountMinor: BigInt(Math.round(amount * 100)),
        providerPlanId: null,
      },
    });
    await recordPlatformAudit(tx, ctx, {
      action: "platform.price_updated",
      entityType: "SaasPlanPrice",
      entityId: priceId,
      before: { amountMinor: Number(before.amountMinor) },
      after: { amountMinor: Math.round(amount * 100) },
    });
  });
}

/** Creates the provider plan for a price if it has none (lazily, at first checkout too). */
export async function ensureProviderPlan(deps: BillingDeps, priceId: string) {
  const price = await deps.db.saasPlanPrice.findUniqueOrThrow({
    where: { id: priceId },
    include: { plan: true },
  });
  if (price.providerPlanId) return price.providerPlanId;
  const provider = providerOf(deps, await account(deps));
  const created = await provider.createPlan({
    period: price.cycle === "YEARLY" ? "yearly" : "monthly",
    interval: price.cycle === "HALF_YEARLY" ? 6 : 1,
    name: `${price.plan.name} (${CYCLE_LABEL[price.cycle]})`,
    amountMinor: Number(price.amountMinor),
    currency: price.currency,
  });
  await deps.db.saasPlanPrice.update({
    where: { id: price.id },
    data: { providerPlanId: created.id },
  });
  return created.id;
}

// --- checkout, plan change, cancel ----------------------------------------------------------

/**
 * Owner picks a plan and billing cycle. No provider subscription yet (or a cancelled one): a new
 * subscription and its checkout URL. An active one: upgrades now, downgrades at the period end.
 * Nothing changes locally until verified webhooks confirm it (except the booked downgrade).
 */
export async function startCheckout(
  deps: BillingDeps,
  input: { tenantId: string; priceId: string; requestedByUserId: string },
): Promise<
  | { kind: "checkout"; url: string }
  | { kind: "changed"; when: "now" | "cycle_end" }
> {
  const price = await deps.db.saasPlanPrice.findUnique({
    where: { id: input.priceId },
    include: { plan: true },
  });
  if (!price || !price.active || price.plan.status !== "ACTIVE")
    throw new AppError("NOT_FOUND", "Pick a plan.");
  const sub = await deps.db.tenantSubscription.findUniqueOrThrow({
    where: { tenantId: input.tenantId },
    include: { price: true },
  });
  const providerPlanId = await ensureProviderPlan(deps, price.id);
  const provider = providerOf(deps, await account(deps));
  const live =
    sub.providerSubscriptionId &&
    ["ACTIVE", "PAST_DUE", "GRACE"].includes(sub.status) &&
    sub.providerStatus !== "cancelled";
  if (live && sub.providerSubscriptionId) {
    const currentMonthly = sub.price
      ? monthlyEquivalent(Number(sub.price.amountMinor), sub.price.cycle)
      : 0;
    const nextMonthly = monthlyEquivalent(
      Number(price.amountMinor),
      price.cycle,
    );
    const when = nextMonthly >= currentMonthly ? "now" : "cycle_end";
    await provider.changePlan(sub.providerSubscriptionId, providerPlanId, when);
    await deps.db.$transaction(async (tx) => {
      await tx.tenantSubscription.update({
        where: { id: sub.id },
        data:
          when === "now"
            ? {
                planId: price.planId,
                priceId: price.id,
                pendingPlanId: null,
                pendingPriceId: null,
              }
            : { pendingPlanId: price.planId, pendingPriceId: price.id },
      });
      await recordPlatformAudit(tx, null, {
        action:
          when === "now"
            ? "subscription.upgraded"
            : "subscription.downgrade_booked",
        entityType: "TenantSubscription",
        entityId: sub.id,
        tenantId: input.tenantId,
        after: { plan: price.plan.code, cycle: price.cycle },
        meta: { requestedByUserId: input.requestedByUserId },
      });
      await tenantAudit(
        tx,
        input.tenantId,
        null,
        when === "now"
          ? "subscription.upgraded"
          : "subscription.downgrade_booked",
        {
          plan: price.plan.code,
          cycle: price.cycle,
          requestedByUserId: input.requestedByUserId,
        },
      );
    });
    if (when === "now")
      await deps.entitlements.invalidate(input.tenantId).catch(() => undefined);
    return { kind: "changed", when };
  }
  const created = await provider.createSubscription({
    planId: providerPlanId,
    totalCount: TOTAL_COUNT[price.cycle],
    notes: { tenantId: input.tenantId, priceId: price.id },
    customerNotify: true,
  });
  await deps.db.$transaction(async (tx) => {
    await tx.tenantSubscription.update({
      where: { id: sub.id },
      data: {
        providerSubscriptionId: created.id,
        providerStatus: created.status,
        pendingPlanId: price.planId,
        pendingPriceId: price.id,
        cancelAtPeriodEnd: false,
      },
    });
    await recordPlatformAudit(tx, null, {
      action: "subscription.checkout_started",
      entityType: "TenantSubscription",
      entityId: sub.id,
      tenantId: input.tenantId,
      after: {
        plan: price.plan.code,
        cycle: price.cycle,
        providerSubscriptionId: created.id,
      },
      meta: { requestedByUserId: input.requestedByUserId },
    });
  });
  if (!created.shortUrl)
    throw new AppError(
      "PROVIDER_ERROR",
      "Razorpay didn't return a checkout link.",
    );
  return { kind: "checkout", url: created.shortUrl };
}

export async function cancelAtPeriodEnd(
  deps: BillingDeps,
  input: { tenantId: string; requestedByUserId: string },
) {
  const sub = await deps.db.tenantSubscription.findUniqueOrThrow({
    where: { tenantId: input.tenantId },
  });
  if (!sub.providerSubscriptionId || sub.status === "CANCELLED")
    throw new AppError("CONFLICT", "There's no paid subscription to cancel.");
  await providerOf(deps, await account(deps)).cancelSubscription(
    sub.providerSubscriptionId,
    true,
  );
  await deps.db.$transaction(async (tx) => {
    await tx.tenantSubscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: true },
    });
    await recordPlatformAudit(tx, null, {
      action: "subscription.cancel_at_period_end",
      entityType: "TenantSubscription",
      entityId: sub.id,
      tenantId: input.tenantId,
      meta: { requestedByUserId: input.requestedByUserId },
    });
    await tenantAudit(
      tx,
      input.tenantId,
      null,
      "subscription.cancel_at_period_end",
      {
        requestedByUserId: input.requestedByUserId,
      },
    );
  });
}

// --- platform webhooks ----------------------------------------------------------------------

export type PlatformWebhookReceipt =
  | { status: 400; reason: string }
  | { status: 200; duplicate: boolean; eventRowId: string | null };

/** /api/webhooks/razorpay-platform (admin app): verify → store once → the caller enqueues. */
export async function receivePlatformWebhook(
  deps: BillingDeps,
  input: {
    rawBody: string;
    signature: string | null;
    eventIdHeader: string | null;
  },
): Promise<PlatformWebhookReceipt> {
  const row = await deps.db.platformPaymentAccount.findFirst({
    where: { active: true },
  });
  if (!row) return { status: 400, reason: "no platform account" };
  const secret = deps.secrets.decrypt(row.webhookSecretEnc).toString("utf8");
  if (!verifyWebhookSignature(input.rawBody, input.signature, secret))
    return { status: 400, reason: "invalid signature" };
  let parsed: { event?: string };
  let eventId: string;
  try {
    parsed = JSON.parse(input.rawBody) as { event?: string };
    eventId = parseRazorpayWebhook(input.rawBody, input.eventIdHeader).eventId;
  } catch {
    return { status: 400, reason: "malformed body" };
  }
  const inserted = await deps.db.platformWebhookEvent.createMany({
    data: [
      {
        eventId,
        type: String(parsed.event ?? ""),
        payload: redactPayload(parsed),
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0)
    return { status: 200, duplicate: true, eventRowId: null };
  const stored = await deps.db.platformWebhookEvent.findUniqueOrThrow({
    where: { eventId },
  });
  return { status: 200, duplicate: false, eventRowId: stored.id };
}

async function nextInvoiceNumber(tx: Tx, now: Date) {
  const fy = indianFinancialYear(now); // e.g. 2026-27
  const key = `saas-invoice:${fy}`;
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO platform.platform_counter (key, value) VALUES (${key}, 1)
    ON CONFLICT (key) DO UPDATE SET value = platform.platform_counter.value + 1
    RETURNING value`;
  return `SAAS/${fy.slice(2)}/${String(rows[0]!.value).padStart(5, "0")}`;
}

/** SaaS invoice for a captured subscription payment (GST-inclusive price; B2B recipient). */
async function issuePlatformInvoice(
  tx: Tx,
  deps: BillingDeps,
  input: {
    tenantId: string;
    providerPaymentId: string;
    amountMinor: number;
    currency: string;
    method: string | null;
    capturedAt: Date;
    periodStart: Date | null;
    periodEnd: Date | null;
    description: string;
  },
) {
  const existing = await tx.platformPayment.findUnique({
    where: { providerPaymentId: input.providerPaymentId },
  });
  if (existing) return null;
  const settings = await readPlatformSettings(tx);
  const supplier = settings["billing.supplier"];
  const [identity] = await tx.$queryRaw<
    {
      legal_name: string;
      display_name: string;
      gstin: string | null;
      state_code: string | null;
    }[]
  >`
    SELECT * FROM platform_api.tenant_billing_identity(${input.tenantId}::uuid)`;
  const supply = supplyType({
    gstRegistered: !!supplier.gstin,
    supplierStateCode: supplier.stateCode,
    // B2B services: place of supply is the recipient's state.
    placeOfSupply: identity?.state_code ?? supplier.stateCode,
  });
  const line = computeTaxLine(
    {
      unitPriceMinor: input.amountMinor,
      rateBps: settings["billing.tax_rate_bps"],
    },
    supply,
    true,
  );
  const totals = sumTotals([line]);
  const invoice = await tx.platformInvoice.create({
    data: {
      tenantId: input.tenantId,
      number: await nextInvoiceNumber(tx, input.capturedAt),
      issueDate: toDbDate(todayIn("Asia/Kolkata", input.capturedAt)),
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      description: input.description,
      supplier: { ...supplier, sacCode: settings["billing.sac_code"] },
      recipient: {
        legalName: identity?.legal_name ?? null,
        displayName: identity?.display_name ?? null,
        gstin: identity?.gstin ?? null,
        stateCode: identity?.state_code ?? null,
      },
      taxableMinor: totals.taxableMinor,
      cgstMinor: totals.cgstMinor,
      sgstMinor: totals.sgstMinor,
      igstMinor: totals.igstMinor,
      totalMinor: totals.totalMinor,
      currency: input.currency,
      status: "PAID",
      providerPaymentId: input.providerPaymentId,
    },
  });
  await tx.platformPayment.create({
    data: {
      tenantId: input.tenantId,
      invoiceId: invoice.id,
      providerPaymentId: input.providerPaymentId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      method: input.method,
      capturedAt: input.capturedAt,
    },
  });
  return invoice;
}

/**
 * Worker: applies one stored platform webhook. Re-reads the subscription from the provider (the
 * source of truth), so late or reordered events converge on the same state; a charged payment is
 * recorded once (unique provider payment id).
 */
export async function processPlatformWebhook(
  deps: BillingDeps,
  eventRowId: string,
) {
  const event = await deps.db.platformWebhookEvent.findUnique({
    where: { id: eventRowId },
  });
  if (!event || event.status === "PROCESSED" || event.status === "IGNORED")
    return { outcome: "already" };
  try {
    const normalized = parseRazorpayWebhook(
      JSON.stringify(event.payload),
      event.eventId,
    );
    if (normalized.kind !== "subscription") {
      await deps.db.platformWebhookEvent.update({
        where: { id: event.id },
        data: {
          status: "IGNORED",
          processedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
      return { outcome: "ignored" };
    }
    let remote: ProviderSubscription = normalized.subscription;
    try {
      remote = await providerOf(deps, await account(deps)).fetchSubscription(
        normalized.subscription.id,
      );
    } catch {
      /* fall back to the event's own snapshot */
    }
    const outcome = await applySubscriptionState(
      deps,
      remote,
      normalized.type === "charged" ? normalized.payment : null,
    );
    await deps.db.platformWebhookEvent.update({
      where: { id: event.id },
      data: {
        status: outcome === "unknown" ? "IGNORED" : "PROCESSED",
        processedAt: new Date(),
        attempts: { increment: 1 },
        error: null,
      },
    });
    return { outcome };
  } catch (err) {
    await deps.db.platformWebhookEvent.update({
      where: { id: event.id },
      data: {
        status: "FAILED",
        attempts: { increment: 1 },
        error: err instanceof Error ? err.message.slice(0, 500) : "error",
      },
    });
    throw err;
  }
}

export async function applySubscriptionState(
  deps: BillingDeps,
  remote: ProviderSubscription,
  payment: {
    id: string;
    amountMinor: number;
    currency: string;
    method: string | null;
    createdAt: Date;
    status: string;
  } | null,
): Promise<"updated" | "unknown"> {
  const now = nowOf(deps);
  const settings = await readPlatformSettings(deps.db);
  const sub =
    (await deps.db.tenantSubscription.findUnique({
      where: { providerSubscriptionId: remote.id },
    })) ??
    (remote.notes.tenantId
      ? await deps.db.tenantSubscription.findFirst({
          where: {
            tenantId: remote.notes.tenantId,
            providerSubscriptionId: remote.id,
          },
        })
      : null);
  if (!sub) return "unknown";
  const price = await deps.db.saasPlanPrice.findFirst({
    where: { providerPlanId: remote.planId },
  });
  let changed: { from: SaasStatus; to: SaasStatus } | null = null;
  await deps.db.$transaction(async (tx) => {
    const graceEndsAt =
      remote.status === "halted"
        ? (sub.graceEndsAt ??
          new Date(now.getTime() + settings["billing.grace_days"] * DAY))
        : null;
    const to = saasStatusFrom({
      current: sub.status,
      providerStatus: remote.status,
      now,
      graceEndsAt,
      currentPeriodEnd: remote.currentEnd ?? sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    });
    const activePlan =
      price && remote.status === "active"
        ? { planId: price.planId, priceId: price.id }
        : {};
    const pendingDone = price && sub.pendingPriceId === price.id;
    await tx.tenantSubscription.update({
      where: { id: sub.id },
      data: {
        status: to,
        providerStatus: remote.status,
        currentPeriodStart: remote.currentStart ?? sub.currentPeriodStart,
        currentPeriodEnd: remote.currentEnd ?? sub.currentPeriodEnd,
        pastDueAt:
          to === "PAST_DUE"
            ? (sub.pastDueAt ?? now)
            : to === "ACTIVE"
              ? null
              : sub.pastDueAt,
        graceEndsAt: to === "ACTIVE" ? null : (graceEndsAt ?? sub.graceEndsAt),
        ...activePlan,
        ...(pendingDone ? { pendingPlanId: null, pendingPriceId: null } : {}),
        ...(payment ? { lastPaymentAt: payment.createdAt } : {}),
      },
    });
    if (payment && payment.status === "captured") {
      const planName = price
        ? (await tx.saasPlan.findUnique({ where: { id: price.planId } }))?.name
        : null;
      await issuePlatformInvoice(tx, deps, {
        tenantId: sub.tenantId,
        providerPaymentId: payment.id,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        method: payment.method,
        capturedAt: payment.createdAt,
        periodStart: remote.currentStart,
        periodEnd: remote.currentEnd,
        description: `${planName ?? "Subscription"}${price ? `, ${CYCLE_LABEL[price.cycle]}` : ""}`,
      });
    }
    if (to !== sub.status) {
      changed = { from: sub.status, to };
      await recordPlatformAudit(tx, null, {
        action: "subscription.status_changed",
        entityType: "TenantSubscription",
        entityId: sub.id,
        tenantId: sub.tenantId,
        before: { status: sub.status },
        after: { status: to, providerStatus: remote.status },
      });
      await tenantAudit(tx, sub.tenantId, null, "subscription.status_changed", {
        from: sub.status,
        to,
      });
    }
  });
  await deps.entitlements.invalidate(sub.tenantId).catch(() => undefined);
  const c = changed as { from: SaasStatus; to: SaasStatus } | null;
  if (c)
    await sendDunning(deps, sub.tenantId, c.from, c.to, sub.currentPeriodEnd);
  return "updated";
}

// --- dunning and the clock ------------------------------------------------------------------

const DUNNING_TEXT: Record<
  string,
  (gym: string, app: string) => { subject: string; text: string }
> = {
  PAYMENT_FAILED: (gym, app) => ({
    subject: `${gym}: your subscription payment failed`,
    text: `Hi,\n\nThe latest payment for ${gym}'s subscription didn't go through. Razorpay will retry automatically; you can also update your payment method from Settings → Plan & usage (${app}/settings/plan).`,
  }),
  GRACE_STARTED: (gym, app) => ({
    subject: `${gym}: action needed to keep your account active`,
    text: `Hi,\n\nWe couldn't collect ${gym}'s subscription payment after several attempts. Your account stays fully usable during a short grace period; please pay from Settings → Plan & usage (${app}/settings/plan) to avoid read-only mode.`,
  }),
  SUSPENDED: (gym, app) => ({
    subject: `${gym}: your account is now read-only`,
    text: `Hi,\n\n${gym}'s subscription is unpaid, so the account is read-only. Nothing has been deleted. Restart your subscription from Settings → Plan & usage (${app}/settings/plan) to unlock it.`,
  }),
  RECOVERED: (gym) => ({
    subject: `${gym}: payment received, thank you`,
    text: `Hi,\n\nWe received ${gym}'s subscription payment. Everything is back to normal.`,
  }),
};

async function ownerEmails(db: PrismaClient, tenantId: string) {
  const rows = await db.$queryRaw<
    { email: string }[]
  >`SELECT email FROM platform_api.tenant_owner_contacts(${tenantId}::uuid)`;
  return rows.map((r) => r.email);
}

async function sendOnce(
  deps: BillingDeps,
  tenantId: string,
  stage: string,
  dedupeKey: string,
  message: { subject: string; text: string },
) {
  const emails = await ownerEmails(deps.db, tenantId);
  const inserted = await deps.db.dunningAttempt.createMany({
    data: [{ tenantId, stage, dedupeKey, emails }],
    skipDuplicates: true,
  });
  if (inserted.count === 0 || !deps.mailer) return false;
  for (const to of emails) await deps.mailer({ to, ...message });
  return true;
}

async function sendDunning(
  deps: BillingDeps,
  tenantId: string,
  from: SaasStatus,
  to: SaasStatus,
  periodEnd: Date | null,
) {
  const stage = dunningStage(from, to);
  if (!stage) return;
  const tenant = await deps.db.tenant.findUniqueOrThrow({
    where: { id: tenantId },
  });
  const message = DUNNING_TEXT[stage]!(tenant.displayName, deps.appUrl ?? "");
  // One email per stage per billing period.
  await sendOnce(
    deps,
    tenantId,
    stage,
    `${tenantId}:${stage}:${periodEnd?.toISOString() ?? "none"}`,
    message,
  );
}

/**
 * Hourly: grace periods that ended → SUSPENDED; cancelled-at-period-end subscriptions whose period
 * ended → CANCELLED; trial-ending reminders (3 days and 1 day before).
 */
export async function runBillingLifecycle(deps: BillingDeps) {
  const now = nowOf(deps);
  let suspended = 0;
  let cancelled = 0;
  let reminders = 0;
  // Catch-up: verified events that were stored but never queued, or failed (up to 10 tries).
  let replayed = 0;
  const stuck = await deps.db.platformWebhookEvent.findMany({
    where: {
      status: { in: ["RECEIVED", "FAILED"] },
      attempts: { lt: 10 },
      receivedAt: { lte: new Date(now.getTime() - 5 * 60_000) },
    },
    orderBy: { receivedAt: "asc" },
    take: 100,
  });
  for (const e of stuck) {
    try {
      await processPlatformWebhook(deps, e.id);
      replayed++;
    } catch {
      /* recorded as FAILED with the error; shown on System health */
    }
  }
  const graceOver = await deps.db.tenantSubscription.findMany({
    where: { status: "GRACE", graceEndsAt: { lte: now } },
  });
  for (const s of graceOver) {
    await deps.db.$transaction(async (tx) => {
      const { count } = await tx.tenantSubscription.updateMany({
        where: { id: s.id, status: "GRACE" },
        data: { status: "SUSPENDED" },
      });
      if (!count) return;
      await recordPlatformAudit(tx, null, {
        action: "subscription.suspended",
        entityType: "TenantSubscription",
        entityId: s.id,
        tenantId: s.tenantId,
      });
      await tenantAudit(tx, s.tenantId, null, "subscription.suspended", {
        reason: "grace period ended",
      });
    });
    await deps.entitlements.invalidate(s.tenantId).catch(() => undefined);
    await sendDunning(
      deps,
      s.tenantId,
      "GRACE",
      "SUSPENDED",
      s.currentPeriodEnd,
    );
    suspended++;
  }
  const ended = await deps.db.tenantSubscription.findMany({
    where: {
      cancelAtPeriodEnd: true,
      status: { not: "CANCELLED" },
      currentPeriodEnd: { lte: now },
    },
  });
  for (const s of ended) {
    await deps.db.$transaction(async (tx) => {
      await tx.tenantSubscription.update({
        where: { id: s.id },
        data: { status: "CANCELLED" },
      });
      await recordPlatformAudit(tx, null, {
        action: "subscription.cancelled",
        entityType: "TenantSubscription",
        entityId: s.id,
        tenantId: s.tenantId,
      });
      await tenantAudit(tx, s.tenantId, null, "subscription.cancelled", {
        reason: "period ended",
      });
    });
    await deps.entitlements.invalidate(s.tenantId).catch(() => undefined);
    cancelled++;
  }
  const trials = await deps.db.tenantSubscription.findMany({
    where: {
      status: "TRIALING",
      trialEndsAt: { gt: now, lte: new Date(now.getTime() + 4 * DAY) },
    },
    include: { tenant: true },
  });
  for (const t of trials) {
    const today = todayIn(t.tenant.timezone, now);
    const ends = todayIn(t.tenant.timezone, t.trialEndsAt!);
    const due = trialReminderDue(ends, today);
    if (!due) continue;
    const sent = await sendOnce(
      deps,
      t.tenantId,
      "TRIAL_ENDING",
      `${t.tenantId}:trial:${due}:${ends}`,
      {
        subject: `${t.tenant.displayName}: your free trial ends ${due === 1 ? "tomorrow" : `in ${due} days`}`,
        text: `Hi,\n\nYour free trial ends on ${ends}. Pick a plan in Settings → Plan & usage (${deps.appUrl ?? ""}/settings/plan) to keep everything running. Your data stays safe either way.`,
      },
    );
    if (sent) reminders++;
  }
  return { suspended, cancelled, reminders, replayed };
}

// --- admin: overview, trial extension, comp -------------------------------------------------

export async function billingOverview(deps: BillingDeps, ctx: PlatformContext) {
  requirePlatformPermission(ctx, "platform.billing.view");
  const now = nowOf(deps);
  const subs = await deps.db.tenantSubscription.findMany({
    include: {
      tenant: { select: { id: true, displayName: true, status: true } },
      plan: true,
      price: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  // KPI_DEFINITIONS: MRR = monthly equivalent of paying subscriptions (ACTIVE, PAST_DUE, GRACE).
  const paying = subs.filter(
    (s) =>
      ["ACTIVE", "PAST_DUE", "GRACE"].includes(s.status) &&
      s.price &&
      s.providerSubscriptionId,
  );
  const mrrMinor = paying.reduce(
    (sum, s) =>
      sum + monthlyEquivalent(Number(s.price!.amountMinor), s.price!.cycle),
    0,
  );
  const counts = subs.reduce<Record<string, number>>(
    (acc, s) => ((acc[s.status] = (acc[s.status] ?? 0) + 1), acc),
    {},
  );
  return {
    mrrMinor,
    arrMinor: mrrMinor * 12,
    counts,
    trialsEnding: subs
      .filter(
        (s) =>
          s.status === "TRIALING" &&
          s.trialEndsAt &&
          s.trialEndsAt.getTime() - now.getTime() < 7 * DAY,
      )
      .map((s) => ({ tenant: s.tenant, trialEndsAt: s.trialEndsAt })),
    pastDue: subs
      .filter((s) => ["PAST_DUE", "GRACE", "SUSPENDED"].includes(s.status))
      .map((s) => ({
        tenant: s.tenant,
        status: s.status,
        pastDueAt: s.pastDueAt,
        graceEndsAt: s.graceEndsAt,
      })),
    subscriptions: subs.map((s) => ({
      id: s.id,
      tenant: s.tenant,
      status: s.status,
      plan: s.plan.name,
      cycle: s.price?.cycle ?? null,
      amountMinor: s.price ? Number(s.price.amountMinor) : null,
      currentPeriodEnd: s.currentPeriodEnd,
      trialEndsAt: s.trialEndsAt,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      provider: !!s.providerSubscriptionId,
    })),
    formatted: {
      mrr: formatMoney(money(mrrMinor)),
      arr: formatMoney(money(mrrMinor * 12)),
    },
  };
}

const extendSchema = z.object({
  days: z.coerce.number().int().min(1).max(365),
  reason: z.string().trim().min(5, "Give a reason.").max(300),
});

export async function extendTrial(
  deps: BillingDeps,
  ctx: PlatformContext,
  tenantId: string,
  raw: unknown,
) {
  requirePlatformPermission(ctx, "platform.billing.manage");
  const { days, reason } = parseInput(extendSchema, raw);
  const sub = await deps.db.tenantSubscription.findUniqueOrThrow({
    where: { tenantId },
  });
  if (
    !["TRIALING", "SUSPENDED", "PAST_DUE", "GRACE"].includes(sub.status) ||
    sub.providerSubscriptionId
  )
    throw new AppError(
      "CONFLICT",
      "Only unpaid trials can be extended. Use a comp for paying gyms.",
    );
  const now = nowOf(deps);
  const base = sub.trialEndsAt && sub.trialEndsAt > now ? sub.trialEndsAt : now;
  const trialEndsAt = new Date(base.getTime() + days * DAY);
  await deps.db.$transaction(async (tx) => {
    await tx.tenantSubscription.update({
      where: { id: sub.id },
      data: { status: "TRIALING", trialEndsAt },
    });
    await recordPlatformAudit(tx, ctx, {
      action: "subscription.trial_extended",
      entityType: "TenantSubscription",
      entityId: sub.id,
      tenantId,
      before: { status: sub.status, trialEndsAt: sub.trialEndsAt },
      after: { status: "TRIALING", trialEndsAt },
      meta: { reason, days },
    });
    await tenantAudit(tx, tenantId, ctx, "subscription.trial_extended", {
      days,
      reason,
    });
  });
  await deps.entitlements.invalidate(tenantId).catch(() => undefined);
}

const compSchema = z.object({
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date."),
  reason: z.string().trim().min(5, "Give a reason.").max(300),
});

/** Free access until a date (pilots, goodwill). ACTIVE without a provider subscription. */
export async function compSubscription(
  deps: BillingDeps,
  ctx: PlatformContext,
  tenantId: string,
  raw: unknown,
) {
  requirePlatformPermission(ctx, "platform.billing.manage");
  const { until, reason } = parseInput(compSchema, raw);
  const end = toDbDate(addDays(until, 1));
  if (end <= nowOf(deps))
    throw new AppError("VALIDATION_FAILED", "Pick a future date.", {
      fields: { until: ["In the past."] },
    });
  const sub = await deps.db.tenantSubscription.findUniqueOrThrow({
    where: { tenantId },
  });
  await deps.db.$transaction(async (tx) => {
    await tx.tenantSubscription.update({
      where: { id: sub.id },
      data: {
        status: "ACTIVE",
        currentPeriodStart: nowOf(deps),
        currentPeriodEnd: end,
        cancelAtPeriodEnd: true,
        graceEndsAt: null,
        pastDueAt: null,
      },
    });
    await recordPlatformAudit(tx, ctx, {
      action: "subscription.comped",
      entityType: "TenantSubscription",
      entityId: sub.id,
      tenantId,
      before: { status: sub.status },
      after: { status: "ACTIVE", until },
      meta: { reason },
    });
    await tenantAudit(tx, tenantId, ctx, "subscription.comped", {
      until,
      reason,
    });
  });
  await deps.entitlements.invalidate(tenantId).catch(() => undefined);
}

/** Platform usage analytics from the usage counters (no tenant business records). */
export async function usageAnalytics(deps: BillingDeps, ctx: PlatformContext) {
  requirePlatformPermission(ctx, "platform.billing.view");
  const [tenants, counters] = [
    await deps.db.tenant.findMany({
      select: {
        id: true,
        displayName: true,
        status: true,
        subscription: {
          select: { status: true, plan: { select: { name: true } } },
        },
      },
    }),
    await deps.db.usageCounter.findMany(),
  ];
  const byTenant = new Map<string, Record<string, number>>();
  for (const c of counters) {
    const row = byTenant.get(c.tenantId) ?? {};
    row[c.key] = c.value;
    byTenant.set(c.tenantId, row);
  }
  const totals: Record<string, number> = {};
  for (const c of counters) totals[c.key] = (totals[c.key] ?? 0) + c.value;
  return {
    activeTenants: tenants.filter((t) => t.status === "ACTIVE").length,
    totals,
    tenants: tenants.map((t) => ({
      id: t.id,
      name: t.displayName,
      status: t.status,
      subscription: t.subscription?.status ?? null,
      plan: t.subscription?.plan.name ?? null,
      usage: byTenant.get(t.id) ?? {},
    })),
  };
}

// --- admin: billing settings (supplier on SaaS invoices, grace, SAC, GST rate) ---------------

const billingSettingsSchema = z
  .object({
    legalName: z.string().trim().min(2, "Enter the legal name.").max(200),
    gstin: z.preprocess(
      (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
      z.string().max(15).optional(),
    ),
    stateCode: z.string().regex(/^\d{2}$/, "Pick the state."),
    address: z.string().trim().max(500).optional(),
    graceDays: z.coerce
      .number()
      .int()
      .min(0, "0 to 60 days.")
      .max(60, "0 to 60 days."),
    sacCode: z
      .string()
      .trim()
      .regex(/^\d{4,8}$/, "4 to 8 digits."),
    taxRatePercent: z.coerce.number().min(0).max(28),
  })
  .superRefine((v, c) => {
    if (!isGstStateCode(v.stateCode))
      c.addIssue({
        code: "custom",
        path: ["stateCode"],
        message: "Pick the state.",
      });
    if (!v.gstin) return;
    const check = checkGstin(v.gstin);
    if (!check.valid)
      c.addIssue({
        code: "custom",
        path: ["gstin"],
        message: GSTIN_MESSAGES[check.reason],
      });
    else if (check.stateCode !== v.stateCode)
      c.addIssue({
        code: "custom",
        path: ["gstin"],
        message: "The GSTIN's state doesn't match the state picked.",
      });
  });

export async function getBillingSettings(
  deps: Pick<BillingDeps, "db">,
  ctx: PlatformContext,
) {
  requirePlatformPermission(ctx, "platform.billing.view");
  const s = await readPlatformSettings(deps.db);
  return {
    supplier: s["billing.supplier"],
    graceDays: s["billing.grace_days"],
    sacCode: s["billing.sac_code"],
    taxRateBps: s["billing.tax_rate_bps"],
  };
}

/** Operator's supplier details for SaaS invoices (no GSTIN = no GST charged) and dunning grace. */
export async function updateBillingSettings(
  deps: Pick<BillingDeps, "db">,
  ctx: PlatformContext,
  raw: unknown,
) {
  requirePlatformPermission(ctx, "platform.billing.manage");
  const input = parseInput(billingSettingsSchema, raw);
  const before = await getBillingSettings(deps, ctx);
  const next: Record<string, Prisma.InputJsonValue> = {
    "billing.supplier": {
      legalName: input.legalName,
      gstin: input.gstin || null,
      stateCode: input.stateCode,
      address: input.address ?? "",
    },
    "billing.grace_days": input.graceDays,
    "billing.sac_code": input.sacCode,
    "billing.tax_rate_bps": Math.round(input.taxRatePercent * 100),
  };
  await deps.db.$transaction(async (tx) => {
    for (const [key, value] of Object.entries(next))
      await tx.platformSetting.upsert({
        where: { key },
        create: { key, value, updatedById: ctx.platformUserId },
        update: { value, updatedById: ctx.platformUserId },
      });
    await recordPlatformAudit(tx, ctx, {
      action: "platform.billing_settings_updated",
      entityType: "PlatformSetting",
      before,
      after: next,
    });
  });
}
