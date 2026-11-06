import { hasPermission } from "@gym/core/authz";
import { isAppError } from "@gym/core/errors";
import { getPlan } from "@gym/core/plans";
import { Breadcrumbs, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { updatePlanAction } from "../actions";
import { PlanForm } from "../plan-form";

export const metadata: Metadata = { title: "Edit plan" };

export default async function EditPlanPage({
  params,
}: PageProps<"/plans/[id]">) {
  const { id } = await params;
  const { ctx, access } = await requireReady(`/plans/${id}`);
  if (!hasPermission(ctx, "plans.manage")) return <NoAccess />;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { plan, sold, versions } = await getPlan(
    services().deps,
    ctx,
    id,
  ).catch((err) => {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  });
  return (
    <>
      <Breadcrumbs
        items={[{ label: "Plans", href: "/plans" }, { label: plan.name }]}
      />
      <PageHeader
        title={`Edit ${plan.name}`}
        description={`Version ${plan.version} of ${versions.length}`}
      />
      <PlanForm
        action={updatePlanAction}
        branches={access.branches}
        submitLabel="Save plan"
        sold={sold}
        values={{ ...plan, branchIds: plan.branches.map((b) => b.branchId) }}
      />
    </>
  );
}
