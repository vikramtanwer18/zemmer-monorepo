import { hasPermission } from "@gym/core/authz";
import { attributionReport, trialToMemberRate } from "@gym/core/crm";
import { Alert, DataTable, EmptyState, PageHeader, StatCard } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { day, inr, str } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { LeadsTabs } from "../leads-tabs";

export const metadata: Metadata = { title: "Lead reports" };

const pct = (n: number, d: number) =>
  d ? `${Math.round((n / d) * 100)}%` : "—";

export default async function LeadReportsPage({
  searchParams,
}: PageProps<"/leads/reports">) {
  const { ctx, access } = await requireReady("/leads/reports");
  if (!hasPermission(ctx, "leads.view")) return <NoAccess />;
  const sp = await searchParams;
  const filters = {
    from: str(sp.from),
    to: str(sp.to),
    model: str(sp.model) === "FIRST" ? "FIRST" : "LAST",
    groupBy: str(sp.groupBy) === "SOURCE" ? "SOURCE" : "CAMPAIGN",
    branchId: str(sp.branchId),
  };
  const deps = services().deps;
  const report = await orUpgrade(attributionReport(deps, ctx, filters));
  if (!report)
    return <UpgradeNotice title="Lead reports" feature="Leads and CRM" />;
  const trials = await trialToMemberRate(deps, ctx, filters);
  const t = report.total;
  const select = "h-10 rounded-md border border-border bg-surface px-2 text-sm";
  return (
    <>
      <PageHeader
        title="Leads"
        description={`Leads that arrived ${day(report.filters.from)} – ${day(report.filters.to)} (to not included), and what they did next.`}
      />
      <LeadsTabs current="/leads/reports" />
      <form
        method="get"
        className="mb-4 flex flex-wrap items-end gap-2 text-sm"
      >
        <label className="flex flex-col gap-1.5 font-medium">
          From
          <input
            type="date"
            name="from"
            defaultValue={report.filters.from}
            className={select}
          />
        </label>
        <label className="flex flex-col gap-1.5 font-medium">
          To
          <input
            type="date"
            name="to"
            defaultValue={report.filters.to}
            className={select}
          />
        </label>
        <label className="flex flex-col gap-1.5 font-medium">
          Group by
          <select
            name="groupBy"
            defaultValue={filters.groupBy}
            className={select}
          >
            <option value="CAMPAIGN">Campaign</option>
            <option value="SOURCE">Source</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 font-medium">
          Credit
          <select name="model" defaultValue={filters.model} className={select}>
            <option value="LAST">Latest enquiry (last touch)</option>
            <option value="FIRST">First enquiry (first touch)</option>
          </select>
        </label>
        {access.branches.length > 1 && (
          <label className="flex flex-col gap-1.5 font-medium">
            Branch
            <select
              name="branchId"
              defaultValue={filters.branchId ?? ""}
              className={select}
            >
              <option value="">All</option>
              {access.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="submit"
          className="h-10 rounded-md border border-border bg-surface px-4 font-medium"
        >
          Show
        </button>
      </form>
      {report.inProgress && (
        <Alert tone="info" className="mb-4">
          In progress: leads from this period can still join (conversion is
          final 60 days after the period ends).
        </Alert>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Leads" value={t.leads} hint={`${report.lost} lost`} />
        <StatCard
          label="Contacted"
          value={t.contacted}
          hint={pct(t.contacted, t.leads)}
        />
        <StatCard
          label="Came for a trial"
          value={t.trialsAttended}
          hint={`${t.trialsBooked} booked`}
        />
        <StatCard
          label="Joined (paid)"
          value={t.won}
          hint={`${pct(t.won, t.leads)} of leads`}
          tone={t.won ? "success" : "default"}
        />
        <StatCard
          label="Trial → member"
          value={
            trials.rate === null ? "—" : `${Math.round(trials.rate * 100)}%`
          }
          hint={`${trials.converted} of ${trials.attended} trials (within 30 days)`}
        />
      </div>
      <DataTable
        caption={`Leads by ${filters.groupBy === "CAMPAIGN" ? "campaign" : "source"}`}
        rows={report.rows}
        rowKey={(r) => r.key}
        empty={<EmptyState title="No leads in this period" />}
        columns={[
          {
            key: "name",
            header: filters.groupBy === "CAMPAIGN" ? "Campaign" : "Source",
            cell: (r) => <span className="font-medium">{r.name}</span>,
          },
          { key: "leads", header: "Leads", cell: (r) => r.leads },
          {
            key: "contacted",
            header: "Contacted",
            hideOnMobile: true,
            cell: (r) => `${r.contacted} (${pct(r.contacted, r.leads)})`,
          },
          {
            key: "trials",
            header: "Trials",
            hideOnMobile: true,
            cell: (r) => `${r.trialsAttended} of ${r.trialsBooked}`,
          },
          {
            key: "won",
            header: "Joined",
            cell: (r) => `${r.won} (${pct(r.won, r.leads)})`,
          },
          ...(report.showMoney
            ? [
                {
                  key: "revenue",
                  header: "Revenue",
                  cell: (r: (typeof report.rows)[number]) =>
                    inr(r.revenueMinor ?? 0),
                },
                {
                  key: "cost",
                  header: "Cost per member",
                  hideOnMobile: true,
                  cell: (r: (typeof report.rows)[number]) =>
                    r.budgetMinor !== null && r.won
                      ? inr(Math.round(r.budgetMinor / r.won))
                      : "—",
                },
              ]
            : []),
        ]}
      />
      <p className="mt-3 text-xs text-muted">
        Definitions: docs/KPI_DEFINITIONS.md (CRM). Joined = a paid membership
        sold from the lead. Revenue = that membership&apos;s invoices less
        credit notes
        {report.showMoney
          ? ""
          : " (shown to people with financial reports access)"}
        .
      </p>
    </>
  );
}
