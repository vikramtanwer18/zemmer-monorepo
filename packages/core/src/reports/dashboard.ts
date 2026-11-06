import type { TenantTransaction } from "@gym/db";
import {
  allowedBranchIds,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "../authz";
import {
  computeKpisTx,
  DASHBOARD_AUDIENCE,
  kpiSettingsTx,
  type KpiReport,
} from "../metrics";
import type { KpiKey } from "../metrics/kpis";
import {
  branchFilter,
  resolveScope,
  scopeInputSchema,
  type KpiScope,
} from "../metrics/scope";
import {
  entitlementsFor,
  inTenant,
  nowOf,
  type CoreDeps,
} from "../tenancy/deps";
import { parseInput } from "../validation";
import { dailySeries, type TrendPoint } from "./index";
import { branchComparison, type ReportTable } from "./tables";

/**
 * The full dashboard (Module 1): registry KPIs vs the previous period, daily trends, branch
 * comparison for owners, and recent activity. Money needs billing.view; CRM/class/trainer cards
 * need their own view permission and plan module, so nobody sees more than their screens show.
 */

/** Audit actions shown in "Recent activity" (no details, just what happened and when). */
export const ACTIVITY_LABELS: Record<string, string> = {
  "member.created": "New member added",
  "member.self_signup": "Member signed up in the app",
  "membership.sold": "Membership sold",
  "membership.activated": "Membership started",
  "membership.renewed": "Membership renewed",
  "membership.renewed_online": "Membership renewed online",
  "membership.bought_online": "Membership bought online",
  "membership.cancelled": "Membership cancelled",
  "membership.frozen": "Membership paused",
  "invoice.issued": "Invoice issued",
  "payment.recorded": "Payment recorded",
  "payment.received_online": "Online payment received",
  "refund.recorded": "Refund recorded",
  "lead.created": "New lead",
  "lead.converted": "Lead joined",
  "class_session.cancelled": "Class cancelled",
  "pt_package.sold": "PT package sold",
  "referral.rewarded": "Referral rewarded",
};

export type ActivityItem = {
  id: string;
  label: string;
  at: Date;
  href: string | null;
  actor: string | null;
};

function activityHref(
  entityType: string,
  entityId: string | null,
): string | null {
  if (!entityId) return null;
  if (entityType === "MemberProfile") return `/members/${entityId}`;
  if (entityType === "Lead") return `/leads/${entityId}`;
  if (entityType === "GymInvoice") return `/invoices/${entityId}`;
  if (entityType === "ClassSession") return `/classes/${entityId}`;
  return null;
}

export async function recentActivityTx(
  tx: TenantTransaction,
  scope: KpiScope,
  limit = 12,
): Promise<ActivityItem[]> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      created_at: Date;
      actor: string | null;
    }[]
  >`
    SELECT a.id::text, a.action, a.entity_type, a.entity_id, a.created_at,
           CASE WHEN a.actor_type = 'USER' THEN coalesce(tp.display_name, 'Staff') WHEN a.actor_type = 'SYSTEM' THEN 'Automatic' ELSE NULL END AS actor
      FROM app.audit_log a
      LEFT JOIN app.trainer_profile tp ON tp.user_id = a.actor_user_id AND tp.tenant_id = a.tenant_id
     WHERE a.action = ANY(${Object.keys(ACTIVITY_LABELS)}::text[]) ${branchFilter("a.branch_id", scope)}
     ORDER BY a.created_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    label: ACTIVITY_LABELS[r.action] ?? r.action,
    at: r.created_at,
    href: activityHref(r.entity_type, r.entity_id),
    actor: r.actor,
  }));
}

/** Demo/seed gyms are marked by a plan override whose reason starts "Demo data". */
async function isDemoTx(tx: TenantTransaction) {
  const n = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM platform.subscription_override WHERE reason LIKE 'Demo data%'`;
  return Number(n[0]?.n ?? 0) > 0;
}

export type Dashboard = {
  kpis: KpiReport;
  trend: TrendPoint[];
  showMoney: boolean;
  branches: ReportTable | null;
  activity: ActivityItem[];
  demo: boolean;
};

export async function getDashboard(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
): Promise<Dashboard> {
  requirePermission(ctx, "dashboard.view");
  const input = parseInput(scopeInputSchema, raw ?? {});
  const scope = resolveScope(deps, ctx, input, "dashboard.view", "this_month");
  const ent = await entitlementsFor(deps, ctx.tenantId);
  const can = (k: Parameters<typeof hasPermission>[1]) => hasPermission(ctx, k);
  const keys: KpiKey[] = [
    "members.total",
    "members.active",
    "members.new",
    "memberships.expiring",
    "memberships.renewal_rate",
    "members.at_risk",
    "attendance.unique_visits",
    "revenue.invoiced",
    "revenue.collected",
    "revenue.refunds",
    "dues.outstanding",
    ...(can("leads.view")
      ? ([
          "leads.open",
          "leads.new",
          "trials.booked",
          "leads.conversion_rate",
        ] as KpiKey[])
      : []),
    ...(can("classes.view") ? (["classes.occupancy"] as KpiKey[]) : []),
    ...(can("reports.view") ? (["trainers.utilization"] as KpiKey[]) : []),
  ];
  const now = nowOf(deps);
  const moneyEverywhere = allowedBranchIds(ctx, "billing.view") === "ALL";
  return inTenant(deps, ctx, async (tx) => {
    const kpis = await computeKpisTx(tx, ctx, ent, scope, keys, {
      audience: DASHBOARD_AUDIENCE,
      compare: true,
      now,
    });
    const trend = await dailySeries(tx, scope);
    let branches: ReportTable | null = null;
    if (scope.branchIds === null && can("reports.view")) {
      const count = await tx.branch.count({ where: { status: "ACTIVE" } });
      if (count > 1) {
        const settings = await kpiSettingsTx(tx, ctx.tenantId);
        branches = await branchComparison({
          tx,
          scope,
          settings,
          now,
          showMoney: moneyEverywhere,
          limit: 20,
          offset: 0,
        });
      }
    }
    return {
      kpis,
      trend,
      showMoney: kpis.figures.some((f) => f.key === "revenue.collected"),
      branches,
      activity: await recentActivityTx(tx, scope),
      demo: await isDemoTx(tx),
    };
  });
}
