import { inOrder, type TenantTransaction } from "@gym/db";
import type { Redis } from "ioredis";
import { AppError } from "../errors";

/**
 * Feature keys and their types. The default migration inserts the same keys into
 * platform.feature (an integration test compares them).
 */
export const FEATURES = {
  "branches.max": "QUOTA",
  "staff.max": "QUOTA",
  "members.max": "QUOTA",
  "classes.enabled": "BOOLEAN",
  "pt.enabled": "BOOLEAN",
  "crm.enabled": "BOOLEAN",
  "online_payments.enabled": "BOOLEAN",
  "whatsapp.enabled": "BOOLEAN",
  "whatsapp.monthly_messages": "QUOTA",
  "automation.enabled": "BOOLEAN",
  "workouts.enabled": "BOOLEAN",
  "nutrition.enabled": "BOOLEAN",
  "rewards.enabled": "BOOLEAN",
  "reports.advanced": "BOOLEAN",
  "ai.copilot": "BOOLEAN",
  "ai.monthly_queries": "QUOTA",
  "expenses.enabled": "BOOLEAN",
  "pos.enabled": "BOOLEAN",
  "inventory.enabled": "BOOLEAN",
  "audit.retention_days": "CONFIG",
} as const;

export type FeatureKey = keyof typeof FEATURES;
export type FeatureType = (typeof FEATURES)[FeatureKey];
export type BooleanFeature = {
  [K in FeatureKey]: (typeof FEATURES)[K] extends "BOOLEAN" ? K : never;
}[FeatureKey];
export type QuotaFeature = {
  [K in FeatureKey]: (typeof FEATURES)[K] extends "QUOTA" ? K : never;
}[FeatureKey];

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** What a tenant may use right now: plan values with unexpired overrides applied. */
export type Entitlements = {
  planCode: string | null;
  planVersion: number | null;
  values: Record<string, JsonValue>;
  /** Earliest override expiry, so caches can expire with it. ISO string or null. */
  nextChangeAt: string | null;
};

export type EntitlementInputs = {
  features: { key: string; defaultValue: unknown }[];
  plan: {
    code: string;
    version: number;
    values: { featureKey: string; value: unknown }[];
  } | null;
  overrides: {
    featureKey: string;
    value: unknown;
    expiresAt: Date | null;
    createdAt: Date;
  }[];
  now: Date;
};

/** Pure: catalog defaults ← plan values ← newest unexpired override. */
export function evaluateEntitlements(input: EntitlementInputs): Entitlements {
  const values: Record<string, JsonValue> = {};
  for (const feature of input.features) {
    values[feature.key] = (feature.defaultValue ?? null) as JsonValue;
  }
  for (const pv of input.plan?.values ?? []) {
    values[pv.featureKey] = (pv.value ?? null) as JsonValue;
  }
  let nextChangeAt: Date | null = null;
  const active = input.overrides
    .filter((o) => o.expiresAt === null || o.expiresAt > input.now)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const override of active) {
    values[override.featureKey] = (override.value ?? null) as JsonValue;
    if (
      override.expiresAt &&
      (!nextChangeAt || override.expiresAt < nextChangeAt)
    ) {
      nextChangeAt = override.expiresAt;
    }
  }
  return {
    planCode: input.plan?.code ?? null,
    planVersion: input.plan?.version ?? null,
    values,
    nextChangeAt: nextChangeAt?.toISOString() ?? null,
  };
}

export function isFeatureEnabled(
  ent: Entitlements,
  key: BooleanFeature,
): boolean {
  return ent.values[key] === true;
}

/** null = unlimited. A missing or malformed value counts as 0 (fail closed). */
export function quotaLimit(
  ent: Entitlements,
  key: QuotaFeature,
): number | null {
  const value = ent.values[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export type QuotaCheck = {
  allowed: boolean;
  limit: number | null;
  used: number;
};

export function evaluateQuota(
  limit: number | null,
  used: number,
  delta: number,
): QuotaCheck {
  return { allowed: limit === null || used + delta <= limit, limit, used };
}

export function checkEntitlement(ent: Entitlements, key: BooleanFeature): void {
  if (!isFeatureEnabled(ent, key)) {
    throw new AppError(
      "ENTITLEMENT_REQUIRED",
      "Your plan doesn't include this feature. Upgrade to use it.",
      { details: { feature: key } },
    );
  }
}

const QUOTA_LABELS: Partial<Record<QuotaFeature, string>> = {
  "branches.max": "branches",
  "staff.max": "staff accounts",
  "members.max": "active members",
};

/**
 * Throws QUOTA_EXCEEDED when adding `delta` would pass the plan limit. Call inside the same
 * transaction that changes the usage, then call bumpUsage().
 */
export async function checkQuota(
  tx: TenantTransaction,
  ent: Entitlements,
  tenantId: string,
  key: QuotaFeature,
  delta = 1,
): Promise<QuotaCheck> {
  const counter = await tx.usageCounter.findUnique({
    where: { tenantId_key: { tenantId, key } },
  });
  const result = evaluateQuota(
    quotaLimit(ent, key),
    counter?.value ?? 0,
    delta,
  );
  if (!result.allowed) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      `Your plan allows ${result.limit} ${QUOTA_LABELS[key] ?? key}. Upgrade to add more.`,
      { details: { feature: key, limit: result.limit, used: result.used } },
    );
  }
  return result;
}

/** Adjusts a usage counter in the caller's transaction. Never goes below zero. */
export async function bumpUsage(
  tx: TenantTransaction,
  tenantId: string,
  key: QuotaFeature,
  delta: number,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO platform.usage_counter (tenant_id, key, value, updated_at)
    VALUES (${tenantId}::uuid, ${key}, GREATEST(${delta}, 0), now())
    ON CONFLICT (tenant_id, key)
    DO UPDATE SET value = GREATEST(platform.usage_counter.value + ${delta}, 0), updated_at = now()`;
}

/** Reads plan + overrides for one tenant. `tx` must be scoped to that tenant (RLS). */
export async function loadEntitlements(
  tx: TenantTransaction,
  tenantId: string,
  now: Date = new Date(),
): Promise<Entitlements> {
  const [features, subscription, overrides] = await inOrder([
    tx.feature.findMany({ select: { key: true, defaultValue: true } }),
    tx.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: { include: { features: true } } },
    }),
    tx.subscriptionOverride.findMany({ where: { tenantId } }),
  ]);
  return evaluateEntitlements({
    features,
    plan: subscription
      ? {
          code: subscription.plan.code,
          version: subscription.plan.version,
          values: subscription.plan.features,
        }
      : null,
    overrides,
    now,
  });
}

// --- cache -------------------------------------------------------------------------

const CACHE_TTL_SECONDS = 300;
const cacheKey = (tenantId: string) => `gym:ent:v1:${tenantId}`;

export type EntitlementCache = {
  get(tenantId: string): Promise<Entitlements | null>;
  set(tenantId: string, ent: Entitlements): Promise<void>;
  invalidate(tenantId: string): Promise<void>;
};

export function redisEntitlementCache(redis: Redis): EntitlementCache {
  return {
    async get(tenantId) {
      const raw = await redis.get(cacheKey(tenantId));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Entitlements;
      } catch {
        return null;
      }
    },
    async set(tenantId, ent) {
      let ttl = CACHE_TTL_SECONDS;
      if (ent.nextChangeAt) {
        const untilChange = Math.ceil(
          (Date.parse(ent.nextChangeAt) - Date.now()) / 1000,
        );
        ttl = Math.max(1, Math.min(ttl, untilChange));
      }
      await redis.set(cacheKey(tenantId), JSON.stringify(ent), "EX", ttl);
    },
    async invalidate(tenantId) {
      await redis.del(cacheKey(tenantId));
    },
  };
}

/** No caching; for tests and scripts. */
export const noEntitlementCache: EntitlementCache = {
  get: async () => null,
  set: async () => {},
  invalidate: async () => {},
};

/** Cached plan resolution. `load` runs only on a cache miss. */
export async function getEntitlements(
  cache: EntitlementCache,
  tenantId: string,
  load: () => Promise<Entitlements>,
): Promise<Entitlements> {
  const cached = await cache.get(tenantId).catch(() => null);
  if (cached) return cached;
  const ent = await load();
  await cache.set(tenantId, ent).catch(() => {});
  return ent;
}
