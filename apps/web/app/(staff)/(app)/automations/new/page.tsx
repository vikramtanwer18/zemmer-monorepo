import { automationEditorOptions } from "@gym/core/automation";
import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { WorkflowEditor } from "../workflow-editor";

export const metadata: Metadata = { title: "New workflow" };

export default async function NewWorkflowPage() {
  const { ctx } = await requireReady("/automations/new");
  if (!hasPermission(ctx, "automations.manage") || !isTenantWritable(ctx))
    return <NoAccess />;
  const options = await orUpgrade(
    automationEditorOptions(services().deps, ctx),
  );
  if (!options)
    return <UpgradeNotice title="Automations" feature="Automations" />;
  return (
    <>
      <PageHeader
        title="New workflow"
        description="Easier: install a ready-made one from the Automations page and adjust it. New workflows start switched off."
      />
      <WorkflowEditor
        workflowId={null}
        name=""
        definition={null}
        {...options}
      />
    </>
  );
}
