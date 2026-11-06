import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listPlans } from "@gym/core/plans";
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
  Tabs,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { inr } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { archivePlanAction } from "./actions";

export const metadata: Metadata = { title: "Plans" };

export default async function PlansPage({ searchParams }: PageProps<"/plans">) {
  const { ctx } = await requireReady("/plans");
  if (!hasPermission(ctx, "memberships.view")) return <NoAccess />;
  const plans = await listPlans(services().deps, ctx, {
    includeArchived: true,
  });
  const canManage = isTenantWritable(ctx) && hasPermission(ctx, "plans.manage");
  return (
    <>
      <PageHeader
        title="Membership plans"
        actions={
          canManage && <LinkButton href="/plans/new">New plan</LinkButton>
        }
      />
      <Tabs
        label="Plans sections"
        current="/plans"
        items={[
          { href: "/plans", label: "Plans" },
          { href: "/plans/coupons", label: "Coupons" },
        ]}
      />
      <Flash params={await searchParams} />
      <DataTable
        caption="Plans"
        rows={plans}
        rowKey={(p) => p.id}
        empty={
          <EmptyState
            title="No plans yet"
            description="Create the plans you sell, e.g. Monthly, Quarterly, Annual."
            action={
              canManage ? (
                <LinkButton href="/plans/new">New plan</LinkButton>
              ) : undefined
            }
          />
        }
        columns={[
          {
            key: "name",
            header: "Plan",
            cell: (p) => (
              <div className="flex flex-col">
                {canManage && p.status === "ACTIVE" ? (
                  <a
                    className="font-medium text-primary underline"
                    href={`/plans/${p.id}`}
                  >
                    {p.name}
                  </a>
                ) : (
                  <span className="font-medium">{p.name}</span>
                )}
                <span className="text-xs text-muted">
                  v{p.version}
                  {p.isTrial ? " · trial" : ""}
                  {p.allowAddOn ? " · add-on" : ""}
                </span>
              </div>
            ),
          },
          {
            key: "price",
            header: "Price",
            cell: (p) =>
              `${inr(p.priceMinor)}${p.joiningFeeMinor > 0n ? ` + ${inr(p.joiningFeeMinor)} joining` : ""}`,
          },
          {
            key: "duration",
            header: "Duration",
            cell: (p) =>
              `${p.durationCount} ${p.durationUnit.toLowerCase()}${p.durationCount === 1 ? "" : "s"}`,
          },
          {
            key: "sold",
            header: "Sold",
            hideOnMobile: true,
            cell: (p) => p._count.memberships,
          },
          {
            key: "where",
            header: "Branches",
            hideOnMobile: true,
            cell: (p) =>
              p.branches.length
                ? p.branches.map((b) => b.branch.name).join(", ")
                : "All",
          },
          {
            key: "status",
            header: "Status",
            cell: (p) =>
              p.status === "ACTIVE" ? (
                <Badge tone="success">On sale</Badge>
              ) : (
                <Badge>Archived</Badge>
              ),
          },
          {
            key: "actions",
            header: "",
            cell: (p) =>
              canManage ? (
                <ConfirmDialog
                  trigger={p.status === "ACTIVE" ? "Archive" : "Restore"}
                  title={
                    p.status === "ACTIVE"
                      ? `Stop selling ${p.name}?`
                      : `Put ${p.name} back on sale?`
                  }
                  description={
                    p.status === "ACTIVE"
                      ? "Existing memberships are not affected."
                      : undefined
                  }
                  confirmLabel={p.status === "ACTIVE" ? "Archive" : "Restore"}
                  confirmVariant={p.status === "ACTIVE" ? "danger" : "primary"}
                  formAction={archivePlanAction}
                  fields={{
                    planId: p.id,
                    archived: p.status === "ACTIVE" ? "true" : "false",
                  }}
                />
              ) : null,
          },
        ]}
      />
    </>
  );
}
