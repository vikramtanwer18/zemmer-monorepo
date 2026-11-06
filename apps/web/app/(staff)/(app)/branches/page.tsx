import { GST_STATES } from "@gym/core/gst";
import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listBranches } from "@gym/core/tenancy";
import { Badge, DataTable, EmptyState, LinkButton, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";

export const metadata: Metadata = { title: "Branches" };

export default async function BranchesPage({
  searchParams,
}: PageProps<"/branches">) {
  const { ctx } = await requireReady("/branches");
  const branches = await listBranches(services().deps, ctx);
  const canManage =
    hasPermission(ctx, "branches.manage") && isTenantWritable(ctx);

  return (
    <>
      <PageHeader
        title="Branches"
        description="Each location of your gym."
        actions={
          canManage && <LinkButton href="/branches/new">Add branch</LinkButton>
        }
      />
      <Flash params={await searchParams} />
      <DataTable
        caption="Branches"
        rows={branches}
        rowKey={(b) => b.id}
        empty={<EmptyState title="No branches yet" />}
        columns={[
          {
            key: "name",
            header: "Branch",
            cell: (b) => (
              <a
                className="font-medium text-primary underline"
                href={`/branches/${b.id}`}
              >
                {b.name}
              </a>
            ),
          },
          { key: "code", header: "Code", cell: (b) => b.code },
          {
            key: "place",
            header: "Location",
            hideOnMobile: true,
            cell: (b) =>
              [b.city, GST_STATES[b.stateCode]].filter(Boolean).join(", "),
          },
          {
            key: "gstin",
            header: "GSTIN",
            hideOnMobile: true,
            cell: (b) => b.gstin ?? "Gym's GSTIN",
          },
          {
            key: "status",
            header: "Status",
            cell: (b) =>
              b.status === "ACTIVE" ? (
                <Badge tone="success">Active</Badge>
              ) : (
                <Badge tone="neutral">Archived</Badge>
              ),
          },
        ]}
      />
    </>
  );
}
