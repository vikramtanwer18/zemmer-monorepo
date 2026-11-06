/**
 * M8 demo for Iron Temple: the AI Copilot switched on (plan overrides marked "Demo data", so the
 * dashboard shows the demo banner) and the KPI rollup filled for the last 120 days, so report
 * trends have history from the first visit. Idempotent.
 */
import { rebuildMetricsTx } from "@gym/core/metrics";
import { addDays, todayIn } from "@gym/core/time/dates";
import { withTenant, type PrismaClient } from "@gym/db";

export async function seedIntelligenceDemo(
  db: PrismaClient,
  platformDb: PrismaClient,
  tenantId: string,
) {
  const overrides: [string, unknown, string][] = [
    ["ai.copilot", true, "Demo data: AI Copilot"],
    ["ai.monthly_queries", 500, "Demo data: AI Copilot questions"],
  ];
  let added = 0;
  for (const [featureKey, value, reason] of overrides) {
    const has = await platformDb.subscriptionOverride.findFirst({
      where: { tenantId, featureKey },
    });
    if (has) continue;
    await platformDb.subscriptionOverride.create({
      data: { tenantId, featureKey, value: value as never, reason },
    });
    added++;
  }
  const tenant = await platformDb.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { timezone: true },
  });
  const now = new Date();
  const today = todayIn(tenant.timezone, now);
  let days = 0;
  for (let d = addDays(today, -120); d < today; d = addDays(d, 1))
    days += (
      await withTenant(db, tenantId, (tx) =>
        rebuildMetricsTx(tx, tenantId, tenant.timezone, d, addDays(d, 1), now),
      )
    ).days;
  return { overridesAdded: added, rollupDays: days };
}
