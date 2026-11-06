import { hasPermission } from "@gym/core/authz";
import { getCrmSetup, listCaptureForms } from "@gym/core/crm";
import { DataTable, EmptyState, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { SettingsTabs } from "../../settings-tabs";
import { CrmSettingsTabs } from "../crm-tabs";
import { FormEditor } from "./form-editor";

export const metadata: Metadata = { title: "Capture forms" };

export default async function FormsPage({
  searchParams,
}: PageProps<"/settings/crm/forms">) {
  const { ctx, access } = await requireReady("/settings/crm/forms");
  if (!hasPermission(ctx, "crm.configure")) return <NoAccess />;
  const sp = await searchParams;
  const data = await orUpgrade(listCaptureForms(services().deps, ctx));
  if (!data) return <UpgradeNotice title="Settings" feature="Leads and CRM" />;
  const setup = await getCrmSetup(services().deps, ctx);
  return (
    <>
      <PageHeader
        title="Settings"
        description="Forms on your website, Instagram link, or QR posters. Every enquiry becomes a lead with its source and campaign."
      />
      <SettingsTabs current="/settings/crm" />
      <CrmSettingsTabs current="/settings/crm/forms" />
      <Flash params={sp} />
      <DataTable
        caption="Capture forms"
        rows={data.forms}
        rowKey={(f) => f.id}
        empty={
          <EmptyState title="No forms yet" description="Create one below." />
        }
        columns={[
          {
            key: "name",
            header: "Form",
            cell: (f) => (
              <a
                className="font-medium text-primary underline"
                href={`/settings/crm/forms/${f.id}`}
              >
                {f.name}
              </a>
            ),
          },
          { key: "branch", header: "Branch", cell: (f) => f.branch.name },
          { key: "leads", header: "Leads", cell: (f) => f._count.leads },
          {
            key: "created",
            header: "Created",
            hideOnMobile: true,
            cell: (f) => when(f.createdAt, ctx.timezone),
          },
        ]}
      />
      <h2 className="mb-3 mt-8 text-base font-semibold">New form</h2>
      <FormEditor
        values={{}}
        branches={access.branches}
        sources={setup.sources}
        campaigns={setup.campaigns}
      />
    </>
  );
}
