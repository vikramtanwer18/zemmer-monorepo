import { hasPermission } from "@gym/core/authz";
import { KPI_VERSION } from "@gym/core/metrics";
import { listReports } from "@gym/core/reports";
import { PageHeader } from "@gym/ui";
import { Lock } from "lucide-react";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";

export const metadata: Metadata = { title: "Reports" };

const GROUPS = ["Members", "Money", "Activity", "Growth", "Branches"] as const;

export default async function ReportsPage() {
  const { ctx } = await requireReady("/reports");
  if (!hasPermission(ctx, "reports.view"))
    return (
      <>
        <PageHeader title="Reports" />
        <NoAccess />
      </>
    );
  const reports = await listReports(services().deps, ctx);
  return (
    <>
      <PageHeader
        title="Reports"
        description="Every figure uses the same definitions as the dashboard and the Copilot. Pick a report to filter by period and branch, compare with the previous period, open the records, or export."
      />
      <div className="flex flex-col gap-8">
        {GROUPS.map((g) => {
          const items = reports.filter((r) => r.group === g);
          if (!items.length) return null;
          return (
            <section key={g} aria-labelledby={`g-${g}`}>
              <h2
                id={`g-${g}`}
                className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted"
              >
                {g}
              </h2>
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((r) => (
                  <li key={r.key}>
                    {r.lock ? (
                      <div className="flex h-full flex-col gap-1 rounded-lg border border-dashed border-border bg-surface p-4 opacity-80">
                        <span className="flex items-center gap-2 font-medium">
                          <Lock
                            aria-hidden="true"
                            className="size-4 text-muted"
                          />
                          {r.title}
                        </span>
                        <span className="text-sm text-muted">
                          {r.description}
                        </span>
                        <span className="mt-auto pt-2 text-xs text-muted">
                          {r.lock === "PLAN" ? (
                            <a
                              href="/settings/plan"
                              className="text-primary hover:underline"
                            >
                              Not on your plan: see plans
                            </a>
                          ) : (
                            "Needs access to financial reports"
                          )}
                        </span>
                      </div>
                    ) : (
                      <a
                        href={`/reports/${r.key}`}
                        className="flex h-full flex-col gap-1 rounded-lg border border-border bg-surface p-4 hover:border-primary"
                      >
                        <span className="font-medium">{r.title}</span>
                        <span className="text-sm text-muted">
                          {r.description}
                        </span>
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <p className="mt-8 text-xs text-muted">
        KPI definitions v{KPI_VERSION}. Periods use the gym&apos;s time zone (
        {ctx.timezone}).
      </p>
    </>
  );
}
