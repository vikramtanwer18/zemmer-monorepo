import { hasPermission } from "@gym/core/authz";
import { isAppError } from "@gym/core/errors";
import { getDashboard, type Dashboard } from "@gym/core/reports";
import { getTenantOverview } from "@gym/core/tenancy";
import { addDays } from "@gym/core/time/dates";
import {
  Alert,
  Card,
  CardDescription,
  CardTitle,
  EmptyState,
  LinkButton,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { formatKpi, KpiCard, TrendBars } from "@/components/kpi";
import { ScopeFilters, scopeFromParams } from "@/components/scope-filters";
import { day, when } from "@/lib/format";
import { kpiHref } from "@/lib/kpi-links";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };

const STATUS_LABELS: Record<string, string> = {
  TRIALING: "Free trial",
  ACTIVE: "Active",
  PAST_DUE: "Payment overdue",
  GRACE: "Grace period",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
};

const SECTIONS: { title: string; keys: string[] }[] = [
  {
    title: "Members",
    keys: [
      "members.total",
      "members.active",
      "members.new",
      "memberships.expiring",
      "memberships.renewal_rate",
      "members.at_risk",
    ],
  },
  {
    title: "Money",
    keys: [
      "revenue.invoiced",
      "revenue.collected",
      "revenue.refunds",
      "dues.outstanding",
    ],
  },
  {
    title: "Activity",
    keys: [
      "attendance.unique_visits",
      "classes.occupancy",
      "trainers.utilization",
    ],
  },
  {
    title: "Sales",
    keys: ["leads.open", "leads.new", "trials.booked", "leads.conversion_rate"],
  },
];

export default async function DashboardPage({ searchParams }: PageProps<"/">) {
  const { ctx, user, access } = await requireReady("/");
  if (!hasPermission(ctx, "dashboard.view")) {
    return (
      <>
        <PageHeader
          title={`Welcome, ${user.name}`}
          description={access.tenant.displayName}
        />
        <p className="text-sm text-muted">Use the menu to get to your work.</p>
      </>
    );
  }
  const sp = await searchParams;
  const input = scopeFromParams(sp);
  const { deps } = services();
  let dash: Dashboard;
  try {
    dash = await getDashboard(deps, ctx, input);
  } catch (err) {
    if (
      isAppError(err) &&
      (err.code === "VALIDATION_FAILED" || err.code === "FORBIDDEN")
    )
      return (
        <>
          <PageHeader
            title={`Welcome, ${user.name}`}
            description={access.tenant.displayName}
          />
          <Alert tone="danger">{err.message}</Alert>
          <p className="mt-4 text-sm">
            <a href="/" className="text-primary hover:underline">
              Reset the filters
            </a>
          </p>
        </>
      );
    throw err;
  }
  const overview = await getTenantOverview(deps, ctx);
  const { period, previousPeriod, branchIds } = dash.kpis;
  const currency = access.tenant.currency;
  const allowAll = access.roles.some((r) => r.branchId === null);
  const branchName =
    branchIds === null
      ? "All branches"
      : branchIds
          .map(
            (id) => access.branches.find((b) => b.id === id)?.name ?? "Branch",
          )
          .join(", ");
  const usage = overview.usage.filter((u) => u.key !== "members.max");
  const byKey = new Map(dash.kpis.figures.map((f) => [f.key as string, f]));

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name}`}
        description={`${access.tenant.displayName} · ${branchName} · ${day(period.from)} – ${day(addDays(period.to, -1))}`}
      />
      {dash.demo && (
        <Alert tone="info" title="Demo data" className="mb-4">
          This gym was created with sample members, payments and activity for
          demonstrations. The figures are real calculations on that sample data.
        </Alert>
      )}
      <ScopeFilters
        preset={input.preset}
        from={period.from}
        to={period.to}
        branchId={input.branchId}
        branches={access.branches}
        allowAll={allowAll}
      />

      {SECTIONS.map((s) => {
        const figures = s.keys
          .map((k) => byKey.get(k))
          .filter((f) => f !== undefined);
        if (!figures.length) return null;
        return (
          <section
            key={s.title}
            aria-labelledby={`dash-${s.title}`}
            className="mb-8"
          >
            <h2
              id={`dash-${s.title}`}
              className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted"
            >
              {s.title}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {figures.map((f) => (
                <KpiCard
                  key={f.key}
                  figure={f}
                  currency={currency}
                  href={kpiHref(f.key, { ...period, branchIds })}
                />
              ))}
            </div>
          </section>
        );
      })}

      <section
        aria-label="Trends"
        className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-2"
      >
        <TrendBars
          title="Unique visits per day"
          unit="count"
          points={dash.trend.map((p) => ({
            day: p.day,
            value: p.uniqueVisits,
          }))}
        />
        {dash.showMoney ? (
          <TrendBars
            title="Collected per day"
            unit="money"
            currency={currency}
            points={dash.trend.map((p) => ({
              day: p.day,
              value: p.collectedMinor,
            }))}
          />
        ) : (
          <TrendBars
            title="New members per day"
            unit="count"
            points={dash.trend.map((p) => ({
              day: p.day,
              value: p.newMembers,
            }))}
          />
        )}
      </section>

      {dash.branches && (
        <section aria-labelledby="branches-h" className="mb-8">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h2
              id="branches-h"
              className="text-sm font-semibold uppercase tracking-wide text-muted"
            >
              Branch comparison
            </h2>
            <a
              href={`/reports/branches?from=${period.from}&to=${period.to}`}
              className="text-sm text-primary hover:underline"
            >
              Full report
            </a>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  {dash.branches.columns.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      className={`px-3 py-2 font-medium ${c.type === "text" ? "" : "text-right"}`}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dash.branches.rows.map((r) => (
                  <tr
                    key={String(r.branch)}
                    className="border-b border-border last:border-0"
                  >
                    {dash.branches!.columns.map((c, i) => (
                      <td
                        key={c.key}
                        className={`px-3 py-2 ${c.type === "text" ? "" : "text-right tabular-nums"}`}
                      >
                        {i === 0 ? (
                          <a
                            href={`/?branchId=${String(r.branchId)}&from=${period.from}&to=${period.to}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {String(r[c.key])}
                          </a>
                        ) : (
                          formatKpi(
                            r[c.key] as number | null,
                            c.type === "money"
                              ? "money"
                              : c.type === "ratio"
                                ? "ratio"
                                : c.type === "number"
                                  ? "number"
                                  : "count",
                            currency,
                          )
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section
          aria-labelledby="activity-h"
          className="rounded-lg border border-border bg-surface p-4 lg:col-span-2"
        >
          <h2 id="activity-h" className="mb-3 text-base font-semibold">
            Recent activity
          </h2>
          {dash.activity.length === 0 ? (
            <EmptyState
              title="Nothing yet"
              description="New members, sales, payments and leads appear here."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border text-sm">
              {dash.activity.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                >
                  {a.href ? (
                    <a href={a.href} className="text-primary hover:underline">
                      {a.label}
                    </a>
                  ) : (
                    <span>{a.label}</span>
                  )}
                  <span className="text-xs text-muted">
                    {a.actor ? `${a.actor} · ` : ""}
                    {when(a.at, ctx.timezone)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="flex flex-col gap-4">
          <Card>
            <CardTitle>{overview.plan?.name ?? "No plan"}</CardTitle>
            <CardDescription>
              {overview.status ? STATUS_LABELS[overview.status] : ""}
              {usage
                .map(
                  (u) =>
                    ` · ${u.key === "branches.max" ? "Branches" : "Staff"} ${u.used}${u.limit === null ? "" : `/${u.limit}`}`,
                )
                .join("")}
            </CardDescription>
          </Card>
          {hasPermission(ctx, "members.create") && (
            <Card>
              <CardTitle>Front desk</CardTitle>
              <CardDescription>
                Add a member, sell a plan, take a payment.
              </CardDescription>
              <div className="mt-4 flex flex-wrap gap-2">
                <LinkButton href="/members/new" size="sm">
                  Add member
                </LinkButton>
                <LinkButton href="/members" size="sm" variant="outline">
                  Find member
                </LinkButton>
              </div>
            </Card>
          )}
          {hasPermission(ctx, "reports.view") && (
            <Card>
              <CardTitle>Reports</CardTitle>
              <CardDescription>
                Renewals, revenue, dues, leads, classes, trainers and branches,
                with exports.
              </CardDescription>
              <LinkButton
                href="/reports"
                variant="outline"
                size="sm"
                className="mt-4"
              >
                Open reports
              </LinkButton>
            </Card>
          )}
        </div>
      </div>

      <p className="text-xs text-muted">
        KPI definitions v{dash.kpis.version}
        {previousPeriod
          ? ` · arrows compare with ${day(previousPeriod.from)} – ${day(addDays(previousPeriod.to, -1))}`
          : ""}
        . Periods use the gym&apos;s time zone ({ctx.timezone}).
      </p>
    </>
  );
}
