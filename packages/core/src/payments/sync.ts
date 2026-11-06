import {
  withTenant,
  type Prisma,
  type PrismaClient,
  type TenantTransaction,
} from "@gym/db";
import {
  parseRazorpayWebhook,
  verifyWebhookSignature,
  type NormalizedEvent,
  type ProviderLink,
  type ProviderPayment,
  type ProviderRefund,
} from "@gym/integrations/payments";
import { recordAudit, type AuditActor } from "../audit";
import { allocateOldestFirst } from "../billing/allocation";
import {
  invoiceBalances,
  num,
  openInvoices,
  persistPaymentTx,
} from "../billing/service";
import { notify } from "../notifications";
import { secretsOf, type CoreDeps } from "../tenancy/deps";
import { todayIn } from "../time/dates";
import { providerFor, type IntegrationRow } from "./integration";
import { fromProviderStatus, linkStatusFrom, mergeLinkStatus } from "./rules";

const SYSTEM = (tenantId: string): AuditActor & { userId?: string } => ({
  system: true,
  tenantId,
});

// --- applying provider state ----------------------------------------------------------------

/**
 * Brings one of our payment links in line with the provider's view of it. Every captured
 * provider payment becomes exactly one GymPayment (unique provider payment id), allocated over the
 * link's invoices in order, excess to member credit, memberships/PT activated by the usual hook.
 * Locks the link row, so concurrent webhooks and reconciliation can't double-record. Safe to run
 * any number of times, with events in any order.
 */
export async function applyProviderLinkTx(
  tx: TenantTransaction,
  tenantId: string,
  linkId: string,
  observed: {
    status: ProviderLink["status"];
    payments: {
      id: string;
      amountMinor: number;
      createdAt: Date;
      method: string | null;
    }[];
  },
): Promise<{ recorded: number; status: string }> {
  await tx.$queryRaw`SELECT id FROM app.payment_link WHERE id = ${linkId}::uuid FOR UPDATE`;
  const link = await tx.paymentLink.findUniqueOrThrow({
    where: { id: linkId },
    include: {
      invoices: { orderBy: { position: "asc" } },
      payments: { select: { providerPaymentId: true, amountMinor: true } },
      member: true,
    },
  });
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const known = new Set(link.payments.map((p) => p.providerPaymentId));
  let paid = link.payments.reduce((s, p) => s + num(p.amountMinor), 0);
  let recorded = 0;
  const fresh = observed.payments
    .filter((p) => !known.has(p.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const p of fresh) {
    // A payment the provider recorded against a different gym's link would show up elsewhere;
    // here the link id itself came from our own row, so only its own payments arrive.
    const already = await tx.gymPayment.findFirst({
      where: { providerPaymentId: p.id },
      select: { id: true },
    });
    if (already) continue;
    const linkInvoiceIds = link.invoices.map((i) => i.invoiceId);
    const open = (await openInvoices(tx, link.memberId))
      .filter((i) => linkInvoiceIds.includes(i.id))
      // The link's own order (not issue date): what the member was asked to pay first.
      .map((i) => ({
        ...i,
        issueDate: String(linkInvoiceIds.indexOf(i.id)).padStart(6, "0"),
      }));
    const plan =
      open.length > 0
        ? allocateOldestFirst(p.amountMinor, open)
        : { allocations: [], creditMinor: p.amountMinor };
    const receivedOn = todayIn(tenant.timezone, p.createdAt);
    await persistPaymentTx(tx, SYSTEM(tenantId), tenantId, {
      member: link.member,
      branchId: link.branchId,
      method: "ONLINE",
      amountMinor: p.amountMinor,
      reference: p.id,
      notes: p.method ? `Paid online (${p.method})` : "Paid online",
      proofFileId: null,
      receivedAt: p.createdAt,
      receivedOn,
      today: todayIn(tenant.timezone, new Date()),
      receivedByUserId: null,
      plan,
      providerPaymentId: p.id,
      paymentLinkId: link.id,
    });
    paid += p.amountMinor;
    recorded++;
  }
  const closed =
    observed.status === "expired" || observed.status === "cancelled"
      ? (fromProviderStatus(observed.status) as "EXPIRED" | "CANCELLED")
      : null;
  const status = mergeLinkStatus(
    link.status,
    linkStatusFrom(num(link.amountMinor), paid, closed),
  );
  await tx.paymentLink.update({
    where: { id: link.id },
    data: { amountPaidMinor: paid, status, lastSyncedAt: new Date() },
  });
  return { recorded, status };
}

/** Fetches the link from the provider (the source of truth) and applies it. */
export async function syncPaymentLink(
  deps: CoreDeps,
  tenantId: string,
  linkId: string,
  fallback: ProviderPayment | null = null,
): Promise<{ recorded: number; status: string; fetched: boolean }> {
  const link = await withTenant(deps.db, tenantId, (tx) =>
    tx.paymentLink.findUnique({
      where: { id: linkId },
      include: { integration: true },
    }),
  );
  if (!link || !link.providerLinkId)
    return { recorded: 0, status: link?.status ?? "UNKNOWN", fetched: false };
  let observed: Parameters<typeof applyProviderLinkTx>[3] | null = null;
  try {
    const remote = await providerFor(
      deps,
      link.integration as IntegrationRow,
    ).fetchPaymentLink(link.providerLinkId);
    observed = { status: remote.status, payments: remote.payments };
  } catch {
    // Provider unreachable: still record the payment the (verified) webhook carried.
    if (fallback && fallback.status === "captured")
      observed = {
        status: "partially_paid",
        payments: [fallback],
      };
  }
  if (!observed) return { recorded: 0, status: link.status, fetched: false };
  const result = await withTenant(deps.db, tenantId, (tx) =>
    applyProviderLinkTx(tx, tenantId, linkId, observed),
  );
  return { ...result, fetched: true };
}

// --- refunds --------------------------------------------------------------------------------

/** Applies a provider refund state once: processed (member told) or failed (credit given back). */
export async function applyRefundStateTx(
  tx: TenantTransaction,
  tenantId: string,
  refund: ProviderRefund,
): Promise<"updated" | "unchanged" | "unknown"> {
  const row = await tx.refund.findFirst({
    where: {
      OR: [
        { providerRefundId: refund.id },
        ...(refund.receipt ? [{ receipt: refund.receipt }] : []),
      ],
    },
    include: { member: true },
  });
  if (!row) return "unknown";
  if (
    row.status === "PROCESSED" ||
    row.status === "FAILED" ||
    row.status === "REJECTED"
  )
    return "unchanged";
  if (refund.status === "pending") {
    if (!row.providerRefundId)
      await tx.refund.update({
        where: { id: row.id },
        data: { providerRefundId: refund.id },
      });
    return "unchanged";
  }
  if (refund.status === "processed") {
    await tx.refund.update({
      where: { id: row.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
        providerRefundId: refund.id,
      },
    });
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    await notify(tx, tenantId, {
      templateKey: "refund.processed",
      recipient: {
        memberId: row.memberId,
        userId: row.member.userId,
        email: row.member.email,
      },
      data: {
        name: row.member.firstName,
        gym: tenant.displayName,
        amount: (num(row.amountMinor) / 100).toLocaleString("en-IN", {
          style: "currency",
          currency: tenant.currency,
        }),
        how: "to your original payment method",
        when: "Banks usually show it within 5–7 working days.",
      },
      dedupeKey: `refund:${row.id}`,
    });
  } else {
    // Failed at the bank: the money stays with the gym as member credit, staff can retry.
    await tx.refund.update({
      where: { id: row.id },
      data: {
        status: "FAILED",
        failureReason: "The provider reported the refund failed.",
        providerRefundId: refund.id,
      },
    });
    await tx.memberCreditEntry.create({
      data: {
        tenantId,
        memberId: row.memberId,
        amountMinor: row.amountMinor,
        kind: "REFUND_REVERSED",
        paymentId: row.paymentId,
        note: `Refund ${row.receipt} failed; amount returned to credit`,
      },
    });
  }
  await recordAudit(tx, SYSTEM(tenantId), {
    action:
      refund.status === "processed" ? "refund.processed" : "refund.failed",
    entityType: "Refund",
    entityId: row.id,
    meta: { providerRefundId: refund.id },
  });
  return "updated";
}

// --- webhooks -------------------------------------------------------------------------------

const PII_KEYS = new Set([
  "email",
  "contact",
  "vpa",
  "card",
  "bank_account",
  "wallet",
  "customer",
  "acquirer_data",
  "upi",
  "notes",
]);

/** Keeps the structure we need, drops personal and card data (CLAUDE.md: no PII in logs). */
export function redactPayload(
  value: unknown,
  depth = 0,
): Prisma.InputJsonValue {
  if (depth > 8 || value === null || value === undefined)
    return null as unknown as Prisma.InputJsonValue;
  if (Array.isArray(value))
    return value.map((v) =>
      redactPayload(v, depth + 1),
    ) as Prisma.InputJsonValue;
  if (typeof value === "object") {
    const out: Record<string, Prisma.InputJsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.has(k)) continue;
      out[k] = redactPayload(v, depth + 1);
    }
    return out;
  }
  return value as Prisma.InputJsonValue;
}

export type WebhookReceipt =
  | { status: 400; reason: string }
  | { status: 404; reason: string }
  | {
      status: 200;
      duplicate: boolean;
      tenantId: string;
      webhookEventId: string | null;
    };

/**
 * /api/webhooks/razorpay/{integrationId}: find the integration → verify the signature over the
 * raw body (nothing is written for a bad one) → store the event once per provider event id →
 * the caller enqueues processing and answers 200 quickly.
 */
export async function receiveWebhook(
  deps: Pick<CoreDeps, "db" | "secrets">,
  input: {
    integrationId: string;
    rawBody: string;
    signature: string | null;
    eventIdHeader: string | null;
  },
): Promise<WebhookReceipt> {
  if (!/^[0-9a-f-]{36}$/i.test(input.integrationId))
    return { status: 404, reason: "unknown integration" };
  const rows = await deps.db.$queryRaw<
    {
      tenant_id: string;
      provider: string;
      webhook_secret_enc: string;
      status: string;
    }[]
  >`SELECT tenant_id::text, provider, webhook_secret_enc, status FROM app.webhook_integration(${input.integrationId}::uuid)`;
  const integration = rows[0];
  if (!integration) return { status: 404, reason: "unknown integration" };
  const secret = secretsOf(deps)
    .decrypt(integration.webhook_secret_enc)
    .toString("utf8");
  if (!verifyWebhookSignature(input.rawBody, input.signature, secret))
    return { status: 400, reason: "invalid signature" };
  let event: NormalizedEvent;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
    event = parseRazorpayWebhook(input.rawBody, input.eventIdHeader);
  } catch {
    return { status: 400, reason: "malformed body" };
  }
  const tenantId = integration.tenant_id;
  return withTenant(deps.db, tenantId, async (tx) => {
    const inserted = await tx.webhookEvent.createMany({
      data: [
        {
          tenantId,
          integrationId: input.integrationId,
          eventId: event.eventId,
          type: String((parsed as { event?: string }).event ?? event.kind),
          payload: redactPayload(parsed),
          status: event.kind === "ignored" ? "IGNORED" : "RECEIVED",
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0)
      return { status: 200, duplicate: true, tenantId, webhookEventId: null };
    const row = await tx.webhookEvent.findUniqueOrThrow({
      where: {
        integrationId_eventId: {
          integrationId: input.integrationId,
          eventId: event.eventId,
        },
      },
      select: { id: true, status: true },
    });
    return {
      status: 200,
      duplicate: false,
      tenantId,
      webhookEventId: row.status === "IGNORED" ? null : row.id,
    };
  });
}

/** Worker: processes one stored webhook. Re-running a processed event does nothing. */
export async function processWebhookEvent(
  deps: CoreDeps,
  tenantId: string,
  webhookEventId: string,
): Promise<{ outcome: string }> {
  const event = await withTenant(deps.db, tenantId, (tx) =>
    tx.webhookEvent.findUnique({ where: { id: webhookEventId } }),
  );
  if (!event) return { outcome: "missing" };
  if (event.status === "PROCESSED" || event.status === "IGNORED")
    return { outcome: "already" };
  const mark = (data: Prisma.WebhookEventUpdateInput) =>
    withTenant(deps.db, tenantId, (tx) =>
      tx.webhookEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 }, ...data },
      }),
    );
  try {
    const normalized = parseRazorpayWebhook(
      JSON.stringify(event.payload),
      event.eventId,
    );
    let outcome = "ignored";
    if (normalized.kind === "link") {
      const link = await withTenant(deps.db, tenantId, (tx) =>
        tx.paymentLink.findFirst({
          where: {
            integrationId: event.integrationId,
            OR: [
              { providerLinkId: normalized.linkId },
              ...(normalized.referenceId
                ? [{ referenceId: normalized.referenceId }]
                : []),
            ],
          },
          select: { id: true },
        }),
      );
      if (link) {
        const r = await syncPaymentLink(
          deps,
          tenantId,
          link.id,
          normalized.payment,
        );
        outcome = `link ${r.status}, ${r.recorded} payment(s) recorded`;
      } else outcome = "unknown link";
    } else if (normalized.kind === "refund") {
      outcome = await withTenant(deps.db, tenantId, (tx) =>
        applyRefundStateTx(tx, tenantId, normalized.refund),
      );
    }
    await mark({
      status:
        outcome === "ignored" ||
        outcome === "unknown link" ||
        outcome === "unknown"
          ? "IGNORED"
          : "PROCESSED",
      processedAt: new Date(),
      error: null,
    });
    return { outcome };
  } catch (err) {
    await mark({
      status: "FAILED",
      error: err instanceof Error ? err.message.slice(0, 500) : "error",
    });
    throw err;
  }
}

// --- reconciliation -------------------------------------------------------------------------

/**
 * Catches anything webhooks missed: links still open after `olderThanMinutes`, pending refunds,
 * and stored events that never processed. Mismatches (we think paid, provider doesn't; amounts
 * differ) become ReconciliationItems and an in-app notice to the owner.
 */
export async function reconcileTenant(
  deps: CoreDeps,
  tenantId: string,
  options: {
    kind: "QUICK" | "DAILY" | "MANUAL";
    olderThanMinutes?: number;
    now?: Date;
  } = { kind: "QUICK" },
) {
  const now = options.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - (options.olderThanMinutes ?? 10) * 60_000,
  );
  const run = await withTenant(deps.db, tenantId, (tx) =>
    tx.reconciliationRun.create({ data: { tenantId, kind: options.kind } }),
  );
  let checked = 0;
  let fixed = 0;
  const issues: {
    entity: string;
    entityId: string;
    providerId: string | null;
    issue: string;
    detail?: object;
  }[] = [];
  try {
    const since =
      options.kind === "DAILY"
        ? new Date(now.getTime() - 48 * 3_600_000)
        : null;
    const links = await withTenant(deps.db, tenantId, (tx) =>
      tx.paymentLink.findMany({
        where: {
          providerLinkId: { not: null },
          OR: [
            {
              status: { in: ["CREATED", "PARTIALLY_PAID"] },
              createdAt: { lte: cutoff },
            },
            ...(since ? [{ updatedAt: { gte: since } }] : []),
          ],
        },
        include: { integration: true },
        take: 500,
      }),
    );
    for (const link of links) {
      checked++;
      let remote: ProviderLink;
      try {
        remote = await providerFor(
          deps,
          link.integration as IntegrationRow,
        ).fetchPaymentLink(link.providerLinkId!);
      } catch (err) {
        issues.push({
          entity: "LINK",
          entityId: link.id,
          providerId: link.providerLinkId,
          issue: `Couldn't fetch from the provider: ${err instanceof Error ? err.message : "error"}`,
        });
        continue;
      }
      const result = await withTenant(deps.db, tenantId, (tx) =>
        applyProviderLinkTx(tx, tenantId, link.id, {
          status: remote.status,
          payments: remote.payments,
        }),
      );
      fixed += result.recorded;
      const ours = await withTenant(deps.db, tenantId, (tx) =>
        tx.paymentLink.findUniqueOrThrow({ where: { id: link.id } }),
      );
      if (num(ours.amountPaidMinor) !== remote.amountPaidMinor)
        issues.push({
          entity: "LINK",
          entityId: link.id,
          providerId: link.providerLinkId,
          issue: `Amount paid differs: ours ${num(ours.amountPaidMinor)}, provider ${remote.amountPaidMinor} (paise).`,
          detail: {
            ours: num(ours.amountPaidMinor),
            provider: remote.amountPaidMinor,
          },
        });
    }
    const refunds = await withTenant(deps.db, tenantId, (tx) =>
      tx.refund.findMany({
        where: {
          kind: "ONLINE",
          status: "PENDING",
          providerRefundId: { not: null },
        },
        include: {
          payment: { include: { link: { include: { integration: true } } } },
        },
        take: 200,
      }),
    );
    for (const r of refunds) {
      checked++;
      const integration = r.payment.link?.integration;
      if (!integration || !r.payment.providerPaymentId) continue;
      try {
        const remote = await providerFor(
          deps,
          integration as IntegrationRow,
        ).fetchRefund(r.payment.providerPaymentId, r.providerRefundId!);
        const outcome = await withTenant(deps.db, tenantId, (tx) =>
          applyRefundStateTx(tx, tenantId, remote),
        );
        if (outcome === "updated") fixed++;
      } catch (err) {
        issues.push({
          entity: "REFUND",
          entityId: r.id,
          providerId: r.providerRefundId,
          issue: `Couldn't fetch the refund: ${err instanceof Error ? err.message : "error"}`,
        });
      }
    }
    // Stored events that never processed (worker down, enqueue lost).
    const stuck = await withTenant(deps.db, tenantId, (tx) =>
      tx.webhookEvent.findMany({
        where: {
          status: { in: ["RECEIVED", "FAILED"] },
          receivedAt: { lte: cutoff },
          attempts: { lt: 10 },
        },
        select: { id: true },
        take: 200,
      }),
    );
    for (const e of stuck) {
      checked++;
      try {
        await processWebhookEvent(deps, tenantId, e.id);
        fixed++;
      } catch {
        /* recorded on the event itself */
      }
    }
    await withTenant(deps.db, tenantId, async (tx) => {
      for (const i of issues)
        await tx.reconciliationItem.create({
          data: {
            tenantId,
            runId: run.id,
            entity: i.entity,
            entityId: i.entityId,
            providerId: i.providerId,
            issue: i.issue,
            detail: (i.detail ?? null) as Prisma.InputJsonValue,
          },
        });
      await tx.reconciliationRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          checked,
          fixed,
          mismatches: issues.length,
        },
      });
      if (issues.length)
        await notifyOwners(tx, tenantId, issues.length, run.id);
    });
  } catch (err) {
    await withTenant(deps.db, tenantId, (tx) =>
      tx.reconciliationRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          checked,
          fixed,
          error: err instanceof Error ? err.message.slice(0, 500) : "error",
        },
      }),
    );
    throw err;
  }
  return { runId: run.id, checked, fixed, mismatches: issues.length };
}

/** In-app notice to the gym's owners (recipient choice only; no access decision is made here). */
async function notifyOwners(
  tx: TenantTransaction,
  tenantId: string,
  count: number,
  runId: string,
) {
  const owners = await tx.roleAssignment.findMany({
    where: {
      roleKey: { in: ["GYM_OWNER", "ACCOUNTANT"] },
      membership: { status: "ACTIVE" },
    },
    include: { membership: { select: { userId: true } } },
  });
  for (const o of owners) {
    await tx.notification.createMany({
      data: [
        {
          tenantId,
          userId: o.membership.userId,
          channel: "IN_APP",
          category: "SERVICE",
          templateKey: "reconciliation.mismatch",
          title: `${count} payment record(s) need checking`,
          body: "Reconciliation found differences between your records and Razorpay. Open Payments → Reconciliation.",
          link: "/payments/reconciliation",
          status: "SENT",
          sentAt: new Date(),
          dedupeKey: `recon:${runId}:${o.membership.userId}`,
        },
      ],
      skipDuplicates: true,
    });
  }
}

/** The balance a set of invoices still has (used when sizing links). */
export async function outstandingFor(
  tx: TenantTransaction,
  invoiceIds: string[],
) {
  const balances = await invoiceBalances(tx, invoiceIds);
  return invoiceIds.reduce(
    (s, id) => s + (balances.get(id)?.outstandingMinor ?? 0),
    0,
  );
}

export type { PrismaClient };
