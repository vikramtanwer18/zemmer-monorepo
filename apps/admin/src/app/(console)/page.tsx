import { getPlatformDashboard } from "@gym/core/platform";
import { DataTable, EmptyState, PageHeader, StatCard } from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Platform overview" };

export default async function OverviewPage() {
  const { ctx } = await requireAdmin("/");
  const data = await getPlatformDashboard(services().deps, ctx);
  const t = data.tenantsByStatus;
  const s = data.subscriptionsByStatus;

  return (
    <>
      <PageHeader
        title="Platform Admin"
        description="Tenants and subscriptions at a glance."
      />
      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Active tenants" value={t.ACTIVE ?? 0} />
        <StatCard
          label="Awaiting approval"
          value={t.PENDING_APPROVAL ?? 0}
          tone={(t.PENDING_APPROVAL ?? 0) > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Suspended"
          value={t.SUSPENDED ?? 0}
          tone={(t.SUSPENDED ?? 0) > 0 ? "danger" : "default"}
        />
        <StatCard
          label="On trial"
          value={s.TRIALING ?? 0}
          hint={`${s.ACTIVE ?? 0} paying · ${s.SUSPENDED ?? 0} lapsed`}
        />
      </div>
      <section aria-labelledby="trials-heading" className="mb-8">
        <h2 id="trials-heading" className="mb-3 text-lg font-semibold">
          Trials ending in the next 7 days
        </h2>
        <DataTable
          caption="Trials ending soon"
          rows={data.trialsEndingSoon}
          rowKey={(r) => r.tenantId}
          empty={<EmptyState title="No trials ending this week" />}
          columns={[
            {
              key: "tenant",
              header: "Tenant",
              cell: (r) => (
                <a
                  className="font-medium text-primary underline"
                  href={`/tenants/${r.tenantId}`}
                >
                  {r.displayName}
                </a>
              ),
            },
            {
              key: "ends",
              header: "Trial ends",
              cell: (r) =>
                r.trialEndsAt?.toLocaleString("en-IN", {
                  timeZone: "Asia/Kolkata",
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
            },
          ]}
        />
      </section>
      <section aria-labelledby="recent-heading">
        <h2 id="recent-heading" className="mb-3 text-lg font-semibold">
          Newest tenants
        </h2>
        <DataTable
          caption="Newest tenants"
          rows={data.recentTenants}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No tenants yet" />}
          columns={[
            {
              key: "name",
              header: "Tenant",
              cell: (r) => (
                <a
                  className="font-medium text-primary underline"
                  href={`/tenants/${r.id}`}
                >
                  {r.displayName}
                </a>
              ),
            },
            {
              key: "status",
              header: "Status",
              cell: (r) => r.status.replace("_", " ").toLowerCase(),
            },
            {
              key: "created",
              header: "Created",
              hideOnMobile: true,
              cell: (r) =>
                r.createdAt.toLocaleDateString("en-IN", {
                  timeZone: "Asia/Kolkata",
                  dateStyle: "medium",
                }),
            },
          ]}
        />
      </section>
    </>
  );
}
