import { isAppError } from "@gym/core/errors";
import {
  listReportExports,
  runReport,
  type ReportResult,
  type Row,
} from "@gym/core/reports";
import type { Column as ReportColumn } from "@gym/core/reports";
import { addDays } from "@gym/core/time/dates";
import {
  Alert,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
  type Column,
} from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Flash } from "@/components/flash";
import { formatKpi, KpiCard, TrendBars } from "@/components/kpi";
import { NoAccess } from "@/components/no-access";
import { ScopeFilters, scopeFromParams } from "@/components/scope-filters";
import { UpgradeNotice } from "@/components/upgrade-notice";
import { day } from "@/lib/format";
import { kpiHref } from "@/lib/kpi-links";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { exportReportAction } from "../actions";

export const metadata: Metadata = { title: "Report" };

function cellText(
  value: Row[string] | undefined,
  type: ReportColumn["type"],
  currency: string,
) {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "money") return formatKpi(Number(value), "money", currency);
  if (type === "ratio") return formatKpi(Number(value), "ratio");
  if (type === "count") return formatKpi(Number(value), "count");
  if (type === "number") return formatKpi(Number(value), "number");
  if (type === "date") return day(String(value));
  if (type === "datetime")
    return `${day(String(value).slice(0, 10))}, ${String(value).slice(11, 16)}`;
  return String(value);
}

function Trends({
  report,
  currency,
}: {
  report: ReportResult;
  currency: string;
}) {
  const t = report.trend;
  if (!t?.length) return null;
  const charts =
    report.trendKind === "members"
      ? [
          {
            title: "Active members (nightly snapshot)",
            unit: "count" as const,
            points: t.map((p) => ({ day: p.day, value: p.activeMembers })),
          },
          {
            title: "New members",
            unit: "count" as const,
            points: t.map((p) => ({ day: p.day, value: p.newMembers })),
          },
        ]
      : report.trendKind === "visits"
        ? [
            {
              title: "Unique visits",
              unit: "count" as const,
              points: t.map((p) => ({ day: p.day, value: p.uniqueVisits })),
            },
            {
              title: "Check-ins",
              unit: "count" as const,
              points: t.map((p) => ({ day: p.day, value: p.checkIns })),
            },
          ]
        : [
            {
              title: "Invoiced",
              unit: "money" as const,
              points: t.map((p) => ({ day: p.day, value: p.invoicedMinor })),
            },
            {
              title: "Collected",
              unit: "money" as const,
              points: t.map((p) => ({ day: p.day, value: p.collectedMinor })),
            },
          ];
  return (
    <section
      aria-label="Trend"
      className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-2"
    >
      {charts.map((c) => (
        <TrendBars
          key={c.title}
          title={c.title}
          points={c.points}
          unit={c.unit}
          currency={currency}
        />
      ))}
    </section>
  );
}

export default async function ReportPage({
  params,
  searchParams,
}: PageProps<"/reports/[key]">) {
  const { key } = await params;
  const { ctx, access } = await requireReady(`/reports/${key}`);
  const sp = await searchParams;
  const input = scopeFromParams(sp);
  const page = Number(typeof sp.page === "string" ? sp.page : 1) || 1;
  const { deps } = services();
  let report: ReportResult;
  try {
    report = await runReport(deps, ctx, key, { ...input, page });
  } catch (err) {
    if (isAppError(err)) {
      if (err.code === "NOT_FOUND") notFound();
      if (err.code === "ENTITLEMENT_REQUIRED")
        return <UpgradeNotice title="Reports" feature="This report" />;
      if (err.code === "FORBIDDEN")
        return (
          <>
            <PageHeader title="Reports" />
            <NoAccess />
          </>
        );
      if (err.code === "VALIDATION_FAILED")
        return (
          <>
            <PageHeader title="Reports" />
            <Alert tone="danger">{err.message}</Alert>
            <p className="mt-4 text-sm">
              <a
                className="text-primary hover:underline"
                href={`/reports/${key}`}
              >
                Reset the filters
              </a>
            </p>
          </>
        );
    }
    throw err;
  }
  const currency = access.tenant.currency;
  const { period, branchIds } = report.kpis;
  const exports = report.canExport ? await listReportExports(deps, ctx) : [];
  const mine = exports.filter(
    (j) => (j.params as { report?: string } | null)?.report === report.key,
  );
  const allowAll = access.roles.some((r) => r.branchId === null);
  const branchName =
    branchIds === null
      ? "All branches"
      : branchIds
          .map(
            (id) => access.branches.find((b) => b.id === id)?.name ?? "Branch",
          )
          .join(", ");
  const qs = (extra: Record<string, string>) =>
    `?${new URLSearchParams({ ...Object.fromEntries(Object.entries(input).filter(([, v]) => v) as [string, string][]), ...extra })}`;
  const columns: Column<Row>[] = report.table.columns.map((c, i) => ({
    key: c.key,
    header: c.label,
    className: ["money", "count", "ratio", "number"].includes(c.type)
      ? "text-right tabular-nums"
      : undefined,
    hideOnMobile: i > 2 && c.type !== "money",
    cell: (r) =>
      i === 0 && r._href ? (
        <a href={r._href} className="font-medium text-primary hover:underline">
          {cellText(r[c.key], c.type, currency)}
        </a>
      ) : (
        cellText(r[c.key], c.type, currency)
      ),
  }));

  return (
    <>
      <PageHeader
        title={report.title}
        description={`${report.description} ${branchName} · ${day(period.from)} – ${day(addDays(period.to, -1))}${report.kpis.previousPeriod ? ` · compared with ${day(report.kpis.previousPeriod.from)} – ${day(addDays(report.kpis.previousPeriod.to, -1))}` : ""}`}
      />
      <p className="-mt-4 mb-4 text-sm">
        <a href="/reports" className="text-primary hover:underline">
          All reports
        </a>
      </p>
      <Flash params={sp} />
      <ScopeFilters
        preset={input.preset}
        from={period.from}
        to={period.to}
        branchId={input.branchId}
        branches={access.branches}
        allowAll={allowAll}
      />

      {report.kpis.figures.length > 0 && (
        <section
          aria-label="Key figures"
          className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {report.kpis.figures.map((f) => (
            <KpiCard
              key={f.key}
              figure={f}
              currency={currency}
              href={kpiHref(f.key, { ...period, branchIds })}
            />
          ))}
        </section>
      )}
      {report.kpis.hidden.some((h) => h.reason === "MONEY_PERMISSION") && (
        <p className="-mt-6 mb-6 text-xs text-muted">
          Money figures are hidden: you don&apos;t have access to financial
          reports for these branches.
        </p>
      )}

      <Trends report={report} currency={currency} />

      <section aria-labelledby="records">
        <h2 id="records" className="mb-1 text-base font-semibold">
          {report.table.title}
        </h2>
        {report.table.note && (
          <p className="mb-3 text-sm text-muted">{report.table.note}</p>
        )}
        <DataTable
          columns={columns}
          rows={report.table.rows}
          rowKey={(r) => JSON.stringify(r)}
          caption={report.table.title}
          empty={
            <EmptyState
              title="Nothing in this period"
              description="Try a longer period or another branch."
            />
          }
        />
        <Pagination
          page={report.page}
          pageSize={report.pageSize}
          total={report.table.total}
          hrefFor={(p) => qs({ page: String(p) })}
        />
      </section>

      {report.canExport && (
        <section
          id="exports"
          aria-labelledby="exports-h"
          className="mt-10 rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="exports-h" className="text-base font-semibold">
            Exports
          </h2>
          <p className="mb-3 text-sm text-muted">
            The whole table for these filters (up to 50,000 rows). Files are
            private and the link expires after 24 hours. Exports are recorded in
            the audit log.
          </p>
          <form action={exportReportAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="report" value={report.key} />
            {Object.entries(input).map(([k, v]) =>
              v ? <input key={k} type="hidden" name={k} value={v} /> : null,
            )}
            <button
              name="format"
              value="csv"
              className="h-9 rounded-md border border-border bg-surface px-3 text-sm font-medium hover:bg-background"
            >
              Export CSV
            </button>
            <button
              name="format"
              value="xlsx"
              className="h-9 rounded-md border border-border bg-surface px-3 text-sm font-medium hover:bg-background"
            >
              Export Excel (.xlsx)
            </button>
          </form>
          {mine.length > 0 && (
            <ul
              className="mt-4 flex flex-col gap-2 text-sm"
              aria-label="Recent exports"
            >
              {mine.map((j) => {
                const p = j.params as {
                  format?: string;
                  from?: string;
                  to?: string;
                };
                const s = j.summary as {
                  count?: number;
                  error?: string;
                  truncated?: boolean;
                } | null;
                return (
                  <li
                    key={j.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2"
                    data-export-status={j.status}
                  >
                    <span>
                      {(p.format ?? "csv").toUpperCase()} · {p.from} –{" "}
                      {p.to ? addDays(p.to, -1) : ""}
                      <span className="text-muted">
                        {" "}
                        ·{" "}
                        {j.createdAt.toLocaleString("en-IN", {
                          timeZone: ctx.timezone,
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </span>
                    </span>
                    {j.status === "SUCCEEDED" ? (
                      <a
                        href={`/api/exports/${j.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        Download ({s?.count ?? 0} rows
                        {s?.truncated ? ", cut at 50,000" : ""})
                      </a>
                    ) : j.status === "FAILED" ? (
                      <span className="text-danger">
                        Failed: {s?.error ?? "try again"}
                      </span>
                    ) : (
                      <span className="text-muted" role="status">
                        {j.status === "RUNNING"
                          ? `Working… ${j.progress}%`
                          : "Queued…"}{" "}
                        <a
                          href={qs({})}
                          className="text-primary hover:underline"
                        >
                          Refresh
                        </a>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <p className="mt-8 text-xs text-muted">
        KPI definitions v{report.version}. Periods are half-open and use the
        gym&apos;s time zone ({ctx.timezone}). History comes from the nightly
        rollup; today is live.
      </p>
    </>
  );
}
