import type { TenantTransaction } from "@gym/db";
import type { PaymentProvider } from "@gym/integrations/payments";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import {
  guard,
  inTenant,
  nowOf,
  paymentsOf,
  secretsOf,
  type CoreDeps,
} from "../tenancy/deps";
import { parseInput } from "../validation";

/**
 * A gym's own Razorpay account (D-10). Secrets are sealed with the data-encryption key, never
 * returned to the browser and never written to the audit log; only the last 4 characters of the
 * key secret are shown.
 */
export type IntegrationRow = {
  id: string;
  tenantId: string;
  provider: "RAZORPAY" | "FAKE";
  keyId: string;
  keySecretEnc: string;
  webhookSecretEnc: string;
  status: "ACTIVE" | "DISCONNECTED";
};

export function providerFor(
  deps: Pick<CoreDeps, "payments" | "secrets">,
  integration: Pick<IntegrationRow, "provider" | "keyId" | "keySecretEnc">,
): PaymentProvider {
  return paymentsOf(deps)({
    provider: integration.provider,
    keyId: integration.keyId,
    keySecret: secretsOf(deps)
      .decrypt(integration.keySecretEnc)
      .toString("utf8"),
  });
}

export async function activeIntegrationTx(tx: TenantTransaction) {
  return tx.paymentIntegration.findFirst({ where: { status: "ACTIVE" } });
}

/** The active integration, or a clear "not connected" error for staff and members. */
export async function requireIntegrationTx(tx: TenantTransaction) {
  const integration = await activeIntegrationTx(tx);
  if (!integration)
    throw new AppError(
      "CONFLICT",
      "Online payments aren't set up for this gym yet. Pay at the front desk.",
      { details: { code: "NOT_CONNECTED" } },
    );
  return integration;
}

/** Where the gym points Razorpay's webhook (shown in settings). */
export function webhookPath(integrationId: string) {
  return `/api/webhooks/razorpay/${integrationId}`;
}

export const WEBHOOK_EVENTS = [
  "payment_link.paid",
  "payment_link.partially_paid",
  "payment_link.expired",
  "payment_link.cancelled",
  "refund.processed",
  "refund.failed",
] as const;

export async function getPaymentIntegration(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "settings.view" });
  return inTenant(deps, ctx, async (tx) => {
    const row = await activeIntegrationTx(tx);
    if (!row) return null;
    return {
      id: row.id,
      provider: row.provider,
      mode: row.mode,
      keyId: row.keyId,
      secretLast4: row.secretLast4,
      lastVerifiedAt: row.lastVerifiedAt,
      connectedAt: row.createdAt,
      webhookPath: webhookPath(row.id),
      events: WEBHOOK_EVENTS,
    };
  });
}

const connectSchema = z.object({
  provider: z.enum(["RAZORPAY", "FAKE"]).default("RAZORPAY"),
  mode: z.enum(["TEST", "LIVE"]),
  keyId: z
    .string()
    .trim()
    .min(8, "Paste the key id from Razorpay (Settings → API keys).")
    .max(64),
  keySecret: z.string().trim().min(8, "Paste the key secret.").max(128),
  webhookSecret: z
    .string()
    .trim()
    .min(8, "Paste the webhook secret you set in Razorpay.")
    .max(128),
});

/**
 * Connects (or replaces) the gym's account: the credentials are checked with the provider first,
 * then sealed and stored; the previous account is disconnected in the same transaction.
 */
export async function connectPaymentIntegration(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
  options: { allowFake?: boolean } = {},
) {
  await guard(deps, ctx, {
    permission: "settings.payments",
    write: true,
    entitlement: "online_payments.enabled",
  });
  const input = parseInput(connectSchema, raw);
  if (input.provider === "FAKE" && !options.allowFake)
    throw new AppError(
      "FORBIDDEN",
      "The test provider is only available in development.",
    );
  const expectedPrefix = input.mode === "LIVE" ? "rzp_live_" : "rzp_test_";
  if (input.provider === "RAZORPAY" && !input.keyId.startsWith(expectedPrefix))
    throw new AppError(
      "VALIDATION_FAILED",
      `A ${input.mode.toLowerCase()} key id starts with ${expectedPrefix}.`,
      { fields: { keyId: [`Should start with ${expectedPrefix}`] } },
    );
  const check = await paymentsOf(deps)({
    provider: input.provider,
    keyId: input.keyId,
    keySecret: input.keySecret,
  }).verifyCredentials();
  if (!check.ok)
    throw new AppError("VALIDATION_FAILED", check.reason, {
      fields: { keySecret: [check.reason] },
    });
  const box = secretsOf(deps);
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const previous = await activeIntegrationTx(tx);
    if (previous)
      await tx.paymentIntegration.update({
        where: { id: previous.id },
        data: {
          status: "DISCONNECTED",
          disconnectedAt: now,
          disconnectedById: ctx.userId,
        },
      });
    const row = await tx.paymentIntegration.create({
      data: {
        tenantId: ctx.tenantId,
        provider: input.provider,
        mode: input.mode,
        keyId: input.keyId,
        keySecretEnc: box.encrypt(input.keySecret),
        webhookSecretEnc: box.encrypt(input.webhookSecret),
        secretLast4: input.keySecret.slice(-4),
        lastVerifiedAt: now,
        connectedById: ctx.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: previous
        ? "payment_integration.rotated"
        : "payment_integration.connected",
      entityType: "PaymentIntegration",
      entityId: row.id,
      // Never the secrets themselves.
      after: {
        provider: row.provider,
        mode: row.mode,
        keyId: row.keyId,
        secretLast4: row.secretLast4,
        replaced: previous?.id ?? null,
      },
    });
    return { id: row.id, webhookPath: webhookPath(row.id) };
  });
}

/** Re-checks the stored credentials with the provider ("Verify" button). */
export async function verifyPaymentIntegration(
  deps: CoreDeps,
  ctx: AuthContext,
) {
  await guard(deps, ctx, { permission: "settings.payments", write: true });
  const row = await inTenant(deps, ctx, (tx) => requireIntegrationTx(tx));
  const check = await providerFor(deps, row).verifyCredentials();
  await inTenant(deps, ctx, async (tx) => {
    if (check.ok)
      await tx.paymentIntegration.update({
        where: { id: row.id },
        data: { lastVerifiedAt: nowOf(deps) },
      });
    await recordAudit(tx, ctx, {
      action: "payment_integration.verified",
      entityType: "PaymentIntegration",
      entityId: row.id,
      meta: { ok: check.ok },
    });
  });
  return check;
}

export async function disconnectPaymentIntegration(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "settings.payments", write: true });
  const { reason } = parseInput(
    z.object({ reason: z.string().trim().min(3, "Say why.").max(300) }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const row = await requireIntegrationTx(tx);
    await tx.paymentIntegration.update({
      where: { id: row.id },
      data: {
        status: "DISCONNECTED",
        disconnectedAt: nowOf(deps),
        disconnectedById: ctx.userId,
      },
    });
    // Open links can no longer be paid through us; members see "pay at the desk".
    await recordAudit(tx, ctx, {
      action: "payment_integration.disconnected",
      entityType: "PaymentIntegration",
      entityId: row.id,
      meta: { reason },
    });
  });
}
