import { hasPermission } from "@gym/core/authz";
import { getClassTemplate } from "@gym/core/classes";
import { PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { updateTemplateAction } from "../../actions";
import { classFormOptions } from "../../options";
import { TemplateForm } from "../../template-form";

export const metadata: Metadata = { title: "Edit recurring class" };

export default async function EditTemplatePage({
  params,
}: PageProps<"/classes/templates/[id]">) {
  const { id } = await params;
  const { ctx, access } = await requireReady(`/classes/templates/${id}`);
  if (!hasPermission(ctx, "classes.manage")) return <NoAccess />;
  const template = await getClassTemplate(services().deps, ctx, id);
  const options = await classFormOptions(ctx, access);
  return (
    <>
      <PageHeader
        title={`Edit ${template.name}`}
        description={`Schedule rule: ${template.rrule}. Saving updates the sessions in the next 8 weeks that nobody has booked.`}
      />
      <TemplateForm
        action={updateTemplateAction}
        options={options}
        submitLabel="Save changes"
        values={template}
      />
    </>
  );
}
