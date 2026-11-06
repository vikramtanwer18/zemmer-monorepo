import type { PrismaClient, TenantTransaction } from "@gym/db";
import { withTenant } from "@gym/db";
import {
  requirePermission,
  requireWritableTenant,
  type AuthContext,
  type PermissionKey,
} from "../authz";
import type { PaymentProvider } from "@gym/integrations/payments";
import type { WhatsAppClientFactory } from "@gym/integrations/whatsapp";
import type { SecretBox } from "../crypto/secret-box";
import {
  checkEntitlement,
  getEntitlements,
  loadEntitlements,
  type BooleanFeature,
  type EntitlementCache,
  type Entitlements,
} from "../entitlements";

/** One-time keys (Redis SET NX in production): true only for the first caller of a key. */
export type OneTimeClaims = {
  claim(key: string, ttlSeconds: number): Promise<boolean>;
};

/** What tenant services need from the outside world. Apps build this once per process. */
export type CoreDeps = {
  /** Runtime client (gym_app). */
  db: PrismaClient;
  entitlements: EntitlementCache;
  now?: () => Date;
  /** Seals secrets stored in the database (member pass secrets). Needed by attendance. */
  secrets?: SecretBox;
  /** Fast replay guard for QR codes (the DB unique index is the durable one). */
  claims?: OneTimeClaims;
  /** M4: builds the payment provider for a gym's connected account (Razorpay or the fake). */
  payments?: PaymentProviderFactory;
  /** M4: public base URL of the gym app (payment return pages, links in emails). */
  appUrl?: string;
  /** M6: builds the WhatsApp client for an account's connection method (Meta or the fake). */
  whatsapp?: WhatsAppClientFactory;
};

export function whatsappOf(
  deps: Pick<CoreDeps, "whatsapp">,
): WhatsAppClientFactory {
  if (!deps.whatsapp)
    throw new Error(
      "CoreDeps.whatsapp is not configured (WhatsApp client factory)",
    );
  return deps.whatsapp;
}

export type PaymentProviderFactory = (account: {
  provider: "RAZORPAY" | "FAKE";
  keyId: string;
  keySecret: string;
}) => PaymentProvider;

export function paymentsOf(
  deps: Pick<CoreDeps, "payments">,
): PaymentProviderFactory {
  if (!deps.payments)
    throw new Error(
      "CoreDeps.payments is not configured (payment provider factory)",
    );
  return deps.payments;
}

export function secretsOf(deps: Pick<CoreDeps, "secrets">): SecretBox {
  if (!deps.secrets)
    throw new Error("CoreDeps.secrets is not configured (DATA_ENCRYPTION_KEY)");
  return deps.secrets;
}

/** Redis-backed claims. Keys are namespaced; values carry no data. */
export function redisClaims(redis: {
  set(
    key: string,
    value: string,
    mode: "EX",
    seconds: number,
    flag: "NX",
  ): Promise<string | null>;
}): OneTimeClaims {
  return {
    async claim(key, ttlSeconds) {
      return (
        (await redis.set(`gym:once:${key}`, "1", "EX", ttlSeconds, "NX")) ===
        "OK"
      );
    },
  };
}

/** For tests and single-process tools: an in-memory claim set. */
export function memoryClaims(): OneTimeClaims {
  const seen = new Set<string>();
  return {
    async claim(key) {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}

export const nowOf = (deps: Pick<CoreDeps, "now">) =>
  deps.now ? deps.now() : new Date();

export async function entitlementsFor(
  deps: CoreDeps,
  tenantId: string,
): Promise<Entitlements> {
  return getEntitlements(deps.entitlements, tenantId, () =>
    withTenant(deps.db, tenantId, (tx) =>
      loadEntitlements(tx, tenantId, nowOf(deps)),
    ),
  );
}

export type GuardOptions = {
  permission: PermissionKey;
  branchId?: string | null;
  /** Writes are refused for suspended/cancelled/pending tenants. */
  write?: boolean;
  entitlement?: BooleanFeature;
};

/**
 * The documented check order (CLAUDE.md): subscription status → entitlement (402) →
 * permission (403). Quotas are checked afterwards, inside the write transaction.
 * Returns the entitlements so callers can run quota checks without a second lookup.
 */
export async function guard(
  deps: CoreDeps,
  ctx: AuthContext,
  options: GuardOptions,
): Promise<Entitlements> {
  if (options.write) {
    requireWritableTenant(ctx);
  }
  const ent = await entitlementsFor(deps, ctx.tenantId);
  if (options.entitlement) {
    checkEntitlement(ent, options.entitlement);
  }
  requirePermission(ctx, options.permission, { branchId: options.branchId });
  return ent;
}

/** withTenant for this context; also sets the user so audit triggers and policies can see it. */
export function inTenant<T>(
  deps: Pick<CoreDeps, "db">,
  ctx: Pick<AuthContext, "tenantId" | "userId">,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return withTenant(deps.db, ctx.tenantId, fn, { userId: ctx.userId });
}
