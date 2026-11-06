import { usageAnalytics } from "@gym/core/saas-billing";
import { Badge, DataTable, EmptyState, PageHeader, StatCard } from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Usage" };

const LABEL: Record<string, string> = {
  "members.active": "Active members",
  "staff.active": "Staff accounts",
  "branches.active": "Branches",
};

/** Platform usage from quota counters only: no tenant business records are read here. */
export default async function UsagePage() {
  const { ctx } = await requireAdmin("/usage");
  if (!ctx.permissions.has("platform.billing.view"))
    return (
      <EmptyState
        title="No access"
        description="Ask a Super Admin for billing access."
      />
    );
  const u = await usageAnalytics(services().billing, ctx);
  const keys = [
    ...new Set([...Object.keys(u.totals), ...Object.keys(LABEL)]),
  ].sort();
  return (
    <>
      <PageHeader
        title="Usage"
        description="How much each gym uses, from the quota counters."
      />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Active gyms" value={u.activeTenants} />
        {keys.map((k) => (
          <StatCard
            key={k}
            label={`${LABEL[k] ?? k} (all gyms)`}
            value={u.totals[k] ?? 0}
          />
        ))}
      </div>
      <DataTable
        caption="Usage by gym"
        rows={u.tenants}
        rowKey={(t) => t.id}
        empty={<EmptyState title="No gyms yet" />}
        columns={[
          {
            key: "name",
            header: "Gym",
            cell: (t) => (
              <a
                className="font-medium text-primary underline"
                href={`/tenants/${t.id}`}
              >
                {t.name}
              </a>
            ),
          },
          {
            key: "plan",
            header: "Plan",
            cell: (t) => (
              <span className="flex flex-wrap items-center gap-1">
                {t.plan ?? "—"}
                {t.subscription && (
                  <Badge tone="neutral">
                    {t.subscription.replace("_", " ").toLowerCase()}
                  </Badge>
                )}
              </span>
            ),
          },
          ...keys.map((k) => ({
            key: k,
            header: LABEL[k] ?? k,
            cell: (t: (typeof u.tenants)[number]) => t.usage[k] ?? 0,
          })),
        ]}
      />
    </>
  );
}
