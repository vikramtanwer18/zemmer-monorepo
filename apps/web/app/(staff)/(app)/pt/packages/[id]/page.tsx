import { hasPermission } from "@gym/core/authz";
import { getPtPackage } from "@gym/core/staff";
import { PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { updatePackageAction } from "../../actions";
import { PackageForm } from "../../package-form";

export const metadata: Metadata = { title: "Edit PT package" };

export default async function EditPackagePage({
  params,
}: PageProps<"/pt/packages/[id]">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/pt/packages/${id}`);
  if (!hasPermission(ctx, "plans.manage")) return <NoAccess />;
  const pkg = await getPtPackage(services().deps, ctx, id);
  return (
    <>
      <PageHeader
        title={`Edit ${pkg.name}`}
        description="Changes apply to future sales. Packages already sold keep the sessions, price and validity they were sold with."
      />
      <PackageForm
        action={updatePackageAction}
        values={pkg}
        submitLabel="Save package"
      />
    </>
  );
}
