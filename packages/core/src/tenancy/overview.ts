import { requirePermission, type AuthContext } from "../authz";
import {
  FEATURES,
  isFeatureEnabled,
  quotaLimit,
  type BooleanFeature,
  type QuotaFeature,
} from "../entitlements";
import { entitlementsFor, inTenant, type CoreDeps } from "./deps";

const USAGE_KEYS: QuotaFeature[] = ["branches.max", "staff.max", "members.max"];

/** Plan, trial and usage against limits, for the dashboard and the plan settings page. */
export async function getTenantOverview(deps: CoreDeps, ctx: AuthContext) {
  requirePermission(ctx, "dashboard.view");
  const ent = await entitlementsFor(deps, ctx.tenantId);
  const { subscription, counters } = await inTenant(deps, ctx, async (tx) => ({
    subscription: await tx.tenantSubscription.findUnique({
      where: { tenantId: ctx.tenantId },
      include: { plan: { select: { name: true, code: true, version: true } } },
    }),
    counters: await tx.usageCounter.findMany({
      where: { tenantId: ctx.tenantId },
    }),
  }));
  const used = new Map(counters.map((c) => [c.key, c.value]));
  const booleanFeatures = (
    Object.keys(FEATURES) as (keyof typeof FEATURES)[]
  ).filter((key): key is BooleanFeature => FEATURES[key] === "BOOLEAN");
  return {
    plan: subscription?.plan ?? null,
    status: subscription?.status ?? null,
    trialEndsAt: subscription?.trialEndsAt ?? null,
    usage: USAGE_KEYS.map((key) => ({
      key,
      used: used.get(key) ?? 0,
      limit: quotaLimit(ent, key),
    })),
    features: booleanFeatures.map((key) => ({
      key,
      enabled: isFeatureEnabled(ent, key),
    })),
  };
}
