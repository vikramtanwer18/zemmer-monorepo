import { hasPermission } from "@gym/core/authz";
import { todayIn } from "@gym/core/time/dates";
import { PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { requireReady } from "@/lib/session";
import { createTemplateAction } from "../../actions";
import { classFormOptions } from "../../options";
import { TemplateForm } from "../../template-form";

export const metadata: Metadata = { title: "New recurring class" };

export default async function NewTemplatePage() {
  const { ctx, access, session } = await requireReady("/classes/templates/new");
  if (!hasPermission(ctx, "classes.manage")) return <NoAccess />;
  const options = await classFormOptions(ctx, access);
  return (
    <>
      <PageHeader title="New recurring class" />
      <TemplateForm
        action={createTemplateAction}
        options={options}
        submitLabel="Create class and schedule"
        values={{
          branchId: session.activeBranchId ?? options.branches[0]?.id,
          startDate: todayIn(ctx.timezone),
          byDays: [1, 3, 5],
          waitlistEnabled: true,
        }}
      />
    </>
  );
}
