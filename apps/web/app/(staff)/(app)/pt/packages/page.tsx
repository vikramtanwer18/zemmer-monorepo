import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listPtPackages } from "@gym/core/staff";
import {
  Alert,
  Badge,
  Card,
  CardTitle,
  ConfirmDialog,
  DataTable,
  EmptyState,
  PageHeader,
  Tabs,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { inr } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { archivePackageAction, createPackageAction } from "../actions";
import { PackageForm } from "../package-form";

export const metadata: Metadata = { title: "PT packages" };

export default async function PtPackagesPage({
  searchParams,
}: PageProps<"/pt/packages">) {
  const { ctx } = await requireReady("/pt/packages");
  if (!hasPermission(ctx, "memberships.view")) return <NoAccess />;
  const packages = await listPtPackages(services().deps, ctx, {
    includeArchived: true,
  });
  const canManage = isTenantWritable(ctx) && hasPermission(ctx, "plans.manage");
  return (
    <>
      <PageHeader
        title="PT packages"
        description="Sold from a member's page like a plan: an invoice is issued and the sessions become available when it's paid."
      />
      <Tabs
        label="Personal training sections"
        current="/pt/packages"
        items={[
          ...(hasPermission(ctx, "pt.manage")
            ? [{ href: "/pt", label: "Sessions" }]
            : []),
          { href: "/pt/packages", label: "Packages" },
        ]}
      />
      <Flash params={await searchParams} />
      <DataTable
        caption="PT packages"
        rows={packages}
        rowKey={(p) => p.id}
        empty={
          <EmptyState
            title="No PT packages yet"
            description="For example: 10 sessions, valid 60 days."
          />
        }
        columns={[
          {
            key: "name",
            header: "Package",
            cell: (p) =>
              canManage && p.status === "ACTIVE" ? (
                <a
                  className="font-medium text-primary underline"
                  href={`/pt/packages/${p.id}`}
                >
                  {p.name}
                </a>
              ) : (
                <span className="font-medium">{p.name}</span>
              ),
          },
          {
            key: "sessions",
            header: "Sessions",
            cell: (p) => `${p.sessionCount} × ${p.sessionMinutes} min`,
          },
          {
            key: "valid",
            header: "Valid",
            cell: (p) => `${p.validityDays} days`,
          },
          { key: "price", header: "Price", cell: (p) => inr(p.priceMinor) },
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
          ...(canManage
            ? [
                {
                  key: "archive",
                  header: "",
                  cell: (p: (typeof packages)[number]) => (
                    <ConfirmDialog
                      trigger={p.status === "ACTIVE" ? "Archive" : "Restore"}
                      title={
                        p.status === "ACTIVE"
                          ? `Stop selling ${p.name}?`
                          : `Sell ${p.name} again?`
                      }
                      description="Packages already sold aren't affected."
                      confirmLabel={
                        p.status === "ACTIVE" ? "Archive" : "Restore"
                      }
                      confirmVariant={
                        p.status === "ACTIVE" ? "danger" : "primary"
                      }
                      formAction={archivePackageAction}
                      fields={{
                        packageId: p.id,
                        archived: String(p.status === "ACTIVE"),
                      }}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
      {canManage && (
        <Card className="mt-6 flex flex-col gap-4">
          <CardTitle>New package</CardTitle>
          <PackageForm
            action={createPackageAction}
            submitLabel="Create package"
          />
        </Card>
      )}
      {!canManage && packages.length === 0 && (
        <Alert tone="info" className="mt-4">
          Ask an owner or administrator to set up PT packages.
        </Alert>
      )}
    </>
  );
}
