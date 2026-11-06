import type { TenantTransaction } from "@gym/db";
import { z } from "zod";
import {
  hasPermission,
  requirePermission,
  type AuthContext,
  type PermissionKey,
} from "../authz";
import { isFeatureEnabled, type Entitlements } from "../entitlements";
import {
  entitlementsFor,
  inTenant,
  nowOf,
  type CoreDeps,
} from "../tenancy/deps";
import { parseInput } from "../validation";
import { comparison, previousPeriod, type Period } from "./calc";
import {
  DEFAULT_KPI_SETTINGS,
  KPI_KEYS,
  KPI_VERSION,
  KPIS,
  explainKpi,
  type KpiDefinition,
  type KpiKey,
  type KpiSettings,
  type KpiValue,
} from "./kpis";
import * as load from "./loaders";
import {
  narrowScope,
  resolveScope,
  scopeInputSchema,
  withPeriod,
  type KpiScope,
  type PeriodPreset,
} from "./scope";

export * from "./calc";
export * from "./kpis";
export * from "./rollup";
export * from "./scope";
export { load as loaders };

/**
 * Metrics service: resolves who may see what (tenant from the context, branches narrowed to the
 * caller's grants, money only with the money permission, module KPIs only on plans that have the
 * module) and computes registry KPIs, optionally against the previous period.
 */

export type MetricsAudience = {
  /** Gate for the screen: dashboard.view (dashboard) or reports.view (reports, Copilot). */
  permission: PermissionKey;
  /** Gate for money figures: billing.view (dashboard) or reports.financial (reports, Copilot). */
  moneyPermission: PermissionKey;
};

export const DASHBOARD_AUDIENCE: MetricsAudience = {
  permission: "dashboard.view",
  moneyPermission: "billing.view",
};
export const REPORTS_AUDIENCE: MetricsAudience = {
  permission: "reports.view",
  moneyPermission: "reports.financial",
};

export async function kpiSettingsTx(
  tx: TenantTransaction,
  tenantId: string,
): Promise<KpiSettings> {
  const s = await tx.tenantSettings.findUnique({
    where: { tenantId },
    select: { kpiGraceDays: true },
  });
  return {
    ...DEFAULT_KPI_SETTINGS,
    graceDays: s?.kpiGraceDays ?? DEFAULT_KPI_SETTINGS.graceDays,
  };
}

/** Why a KPI isn't shown to this caller, or null when it is. */
export function kpiVisibility(
  ctx: AuthContext,
  ent: Entitlements,
  def: KpiDefinition,
  scope: KpiScope,
  audience: MetricsAudience,
): "MONEY_PERMISSION" | "PLAN" | null {
  if (def.module === "classes" && !isFeatureEnabled(ent, "classes.enabled"))
    return "PLAN";
  if (def.module === "crm" && !isFeatureEnabled(ent, "crm.enabled"))
    return "PLAN";
  if (def.module === "pt" && !isFeatureEnabled(ent, "pt.enabled"))
    return "PLAN";
  if (def.financial && !narrowScope(ctx, scope, audience.moneyPermission))
    return "MONEY_PERMISSION";
  return null;
}

export type KpiFigure = KpiValue & {
  key: KpiKey;
  label: string;
  unit: KpiDefinition["unit"];
  kind: KpiDefinition["kind"];
  definition: string;
  higherIsBetter: boolean | null;
  previous: number | null;
  delta: number | null;
  pct: number | null;
};

export type KpiReport = {
  version: string;
  period: Period;
  previousPeriod: Period | null;
  today: string;
  branchIds: string[] | null;
  figures: KpiFigure[];
  /** KPIs left out, and why (no money permission, not on the plan). */
  hidden: { key: KpiKey; reason: "MONEY_PERMISSION" | "PLAN" }[];
};

/** Computes KPIs in an existing tenant transaction for an already-resolved scope. */
export async function computeKpisTx(
  tx: TenantTransaction,
  ctx: AuthContext,
  ent: Entitlements,
  scope: KpiScope,
  keys: readonly KpiKey[],
  options: { audience: MetricsAudience; compare: boolean; now: Date },
): Promise<KpiReport> {
  const settings = await kpiSettingsTx(tx, ctx.tenantId);
  const prev = options.compare ? previousPeriod(scope.period) : null;
  const figures: KpiFigure[] = [];
  const hidden: KpiReport["hidden"] = [];
  for (const key of keys) {
    const def: KpiDefinition = KPIS[key];
    const why = kpiVisibility(ctx, ent, def, scope, options.audience);
    if (why) {
      hidden.push({ key, reason: why });
      continue;
    }
    // Money is shown only for branches where the caller has the money permission.
    const s = def.financial
      ? narrowScope(ctx, scope, options.audience.moneyPermission)!
      : scope;
    const env = { tx, scope: s, settings, now: options.now };
    const current = await def.compute(env);
    let previous: number | null = null;
    if (prev && (def.kind === "period" || key === "members.active")) {
      previous = (await def.compute({ ...env, scope: withPeriod(s, prev) }))
        .value;
    }
    const c = comparison(current.value, previous);
    figures.push({
      ...current,
      key,
      label: def.label,
      unit: def.unit,
      kind: def.kind,
      definition: def.definition,
      higherIsBetter: def.higherIsBetter,
      previous,
      delta: c.delta,
      pct: c.pct,
    });
  }
  return {
    version: KPI_VERSION,
    period: scope.period,
    previousPeriod: prev,
    today: scope.today,
    branchIds: scope.branchIds,
    figures,
    hidden,
  };
}

const kpiRequestSchema = scopeInputSchema.extend({
  keys: z
    .array(z.enum(KPI_KEYS as [KpiKey, ...KpiKey[]]))
    .max(40)
    .optional(),
  compare: z
    .preprocess((v) => v === "1" || v === "true" || v === true, z.boolean())
    .optional(),
});

/** Screens and the Copilot: KPIs for a period/branch scope the caller is allowed to see. */
export async function getKpis(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
  options: {
    audience?: MetricsAudience;
    defaultKeys?: readonly KpiKey[];
    defaultPreset?: PeriodPreset;
  } = {},
): Promise<KpiReport> {
  const audience = options.audience ?? REPORTS_AUDIENCE;
  requirePermission(ctx, audience.permission);
  const input = parseInput(kpiRequestSchema, raw ?? {});
  const scope = resolveScope(
    deps,
    ctx,
    input,
    audience.permission,
    options.defaultPreset,
  );
  const ent = await entitlementsFor(deps, ctx.tenantId);
  return inTenant(deps, ctx, (tx) =>
    computeKpisTx(
      tx,
      ctx,
      ent,
      scope,
      input.keys ?? options.defaultKeys ?? KPI_KEYS,
      {
        audience,
        compare: input.compare ?? false,
        now: nowOf(deps),
      },
    ),
  );
}

/** One KPI's definition plus the numerator/denominator behind its current value. */
export async function explainMetric(
  deps: CoreDeps,
  ctx: AuthContext,
  key: KpiKey,
  raw: unknown = {},
) {
  const report = await getKpis(deps, ctx, { ...(raw as object), keys: [key] });
  const fig = report.figures[0];
  return {
    ...explainKpi(key, fig),
    value: fig?.value ?? null,
    hidden: report.hidden[0]?.reason ?? null,
    period: report.period,
  };
}

// --- thin dashboard (M2 contract, now on the registry) -------------------------------------------

export type DashboardMetrics = {
  period: { from: string; to: string; today: string };
  branchId: string | null;
  activeMembers: number;
  newMembers: number;
  expiring7Days: number;
  outstandingMinor: number;
  collectedMinor: number;
  invoicedMinor: number;
  kpiVersion: string;
};

const dashboardSchema = scopeInputSchema.pick({
  from: true,
  to: true,
  branchId: true,
});

/** The M2 summary (default: this month so far). Money stays 0 without billing.view for the branch. */
export async function getDashboardMetrics(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
): Promise<DashboardMetrics> {
  requirePermission(ctx, "dashboard.view");
  const input = parseInput(dashboardSchema, raw ?? {});
  const scope = resolveScope(deps, ctx, input, "dashboard.view", "this_month");
  const ent = await entitlementsFor(deps, ctx.tenantId);
  return inTenant(deps, ctx, async (tx) => {
    const r = await computeKpisTx(
      tx,
      ctx,
      ent,
      scope,
      [
        "members.new",
        "memberships.expiring",
        "dues.outstanding",
        "revenue.collected",
        "revenue.invoiced",
      ],
      { audience: DASHBOARD_AUDIENCE, compare: false, now: nowOf(deps) },
    );
    const v = (k: KpiKey) => r.figures.find((f) => f.key === k)?.value ?? 0;
    return {
      period: { ...scope.period, today: scope.today },
      branchId: scope.branchIds?.length === 1 ? scope.branchIds[0]! : null,
      activeMembers: await load.activeMembersNow(tx, scope),
      newMembers: v("members.new"),
      expiring7Days: v("memberships.expiring"),
      outstandingMinor: v("dues.outstanding"),
      collectedMinor: v("revenue.collected"),
      invoicedMinor: v("revenue.invoiced"),
      kpiVersion: KPI_VERSION,
    };
  });
}

export const canSeeMoney = (
  ctx: AuthContext,
  audience: MetricsAudience = REPORTS_AUDIENCE,
) => hasPermission(ctx, audience.moneyPermission);
