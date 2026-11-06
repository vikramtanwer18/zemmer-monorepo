/**
 * M4 demo: online payments with the TEST provider (no real money, no Razorpay account needed).
 * Only runs when PAYMENTS_FAKE_ENABLED=true (refused in production by the env checks).
 */
import { createSecretBox } from "@gym/core/crypto";
import { noEntitlementCache } from "@gym/core/entitlements";
import {
  connectPaymentIntegration,
  getPaymentIntegration,
} from "@gym/core/payments";
import {
  getPlatformPaymentAccount,
  setPlatformPaymentAccount,
} from "@gym/core/saas-billing";
import type { AuthContext } from "@gym/core/authz";
import { withTenant, type PrismaClient } from "@gym/db";
import {
  memoryFakeStore,
  paymentProviderFactory,
  subscriptionProviderFactory,
} from "@gym/integrations/payments";
import { platformPermissionsFor } from "../src/permissions";

function box() {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (!key)
    throw new Error(
      "DATA_ENCRYPTION_KEY must be set to seed payment demo data.",
    );
  return createSecretBox({
    key,
    previousKey: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,
  });
}

/** The gym connects the test provider; its main plan can be bought in the member app. */
export async function seedGymPayments(
  db: PrismaClient,
  ctx: AuthContext,
  planName: string,
) {
  // Credential checks only: the fake accepts anything but "wrong-secret", so no Redis is needed.
  const deps = {
    db,
    entitlements: noEntitlementCache,
    secrets: box(),
    payments: paymentProviderFactory({
      fakeEnabled: true,
      store: memoryFakeStore(),
    }),
  };
  const current = await getPaymentIntegration(deps, ctx);
  if (!current) {
    await connectPaymentIntegration(
      deps,
      ctx,
      {
        provider: "FAKE",
        mode: "TEST",
        keyId: "fake_demo_iron",
        keySecret: "demo-key-secret",
        webhookSecret: "demo-webhook-secret",
      },
      { allowFake: true },
    );
  }
  await withTenant(db, ctx.tenantId, (tx) =>
    tx.membershipPlan.updateMany({
      where: { name: planName },
      data: { onlinePurchase: true },
    }),
  );
  return !current;
}

/** The platform's own test account, so gym owners can try subscribing (needs a Super Admin). */
export async function seedPlatformPayments(
  platformDb: PrismaClient,
  adminId: string,
) {
  const billing = {
    db: platformDb,
    entitlements: noEntitlementCache,
    secrets: box(),
    allowFake: true,
    subscriptions: subscriptionProviderFactory({
      fakeEnabled: true,
      store: memoryFakeStore(),
    }),
  };
  const ctx = {
    platformUserId: adminId,
    role: "SUPER_ADMIN" as const,
    permissions: platformPermissionsFor("SUPER_ADMIN"),
  };
  if (await getPlatformPaymentAccount(billing, ctx)) return false;
  await setPlatformPaymentAccount(billing, ctx, {
    provider: "FAKE",
    mode: "TEST",
    keyId: "fake_demo_platform",
    keySecret: "demo-platform-secret",
    webhookSecret: "demo-platform-webhook",
  });
  return true;
}
