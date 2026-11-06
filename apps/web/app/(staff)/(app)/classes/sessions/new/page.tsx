import { hasPermission } from "@gym/core/authz";
import { PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { requireReady } from "@/lib/session";
import { createSessionAction } from "../../actions";
import { classFormOptions } from "../../options";
import { TemplateForm } from "../../template-form";

export const metadata: Metadata = { title: "One-off class" };

export default async function NewSessionPage() {
  const { ctx, access, session } = await requireReady("/classes/sessions/new");
  if (!hasPermission(ctx, "classes.manage")) return <NoAccess />;
  const options = await classFormOptions(ctx, access);
  return (
    <>
      <PageHeader
        title="One-off class"
        description="A single class, such as a weekend workshop. You'll be warned if the trainer or room is busy."
      />
      <TemplateForm
        action={createSessionAction}
        options={options}
        oneOff
        submitLabel="Create class"
        values={{
          branchId: session.activeBranchId ?? options.branches[0]?.id,
          waitlistEnabled: true,
        }}
      />
    </>
  );
}
