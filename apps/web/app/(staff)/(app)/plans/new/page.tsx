import { hasPermission } from "@gym/core/authz";
import { Breadcrumbs, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { requireReady } from "@/lib/session";
import { createPlanAction } from "../actions";
import { PlanForm } from "../plan-form";

export const metadata: Metadata = { title: "New plan" };

export default async function NewPlanPage() {
  const { ctx, access } = await requireReady("/plans/new");
  if (!hasPermission(ctx, "plans.manage")) return <NoAccess />;
  return (
    <>
      <Breadcrumbs
        items={[{ label: "Plans", href: "/plans" }, { label: "New plan" }]}
      />
      <PageHeader title="New membership plan" />
      <PlanForm
        action={createPlanAction}
        branches={access.branches}
        submitLabel="Create plan"
      />
    </>
  );
}
