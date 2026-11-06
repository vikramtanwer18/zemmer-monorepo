import { hasPermission } from "@gym/core/authz";
import { getCaptureForm, getCrmSetup } from "@gym/core/crm";
import { isAppError } from "@gym/core/errors";
import {
  Breadcrumbs,
  Card,
  CardTitle,
  ConfirmDialog,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { CopyButton } from "../../../../invoices/[id]/copy-button";
import { archiveFormAction } from "../../actions";
import { FormEditor } from "../form-editor";

export const metadata: Metadata = { title: "Capture form" };

export default async function FormPage({
  params,
  searchParams,
}: PageProps<"/settings/crm/forms/[id]">) {
  const { id } = await params;
  const { ctx, access } = await requireReady(`/settings/crm/forms/${id}`);
  if (!hasPermission(ctx, "crm.configure")) return <NoAccess />;
  const sp = await searchParams;
  let data;
  try {
    data = await orUpgrade(getCaptureForm(services().deps, ctx, id));
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (!data) return <UpgradeNotice title="Settings" feature="Leads and CRM" />;
  const { form, tenantSlug } = data;
  if (form.archivedAt) notFound();
  const setup = await getCrmSetup(services().deps, ctx);
  const base = services().deps.appUrl ?? "";
  const url = `${base}/l/${tenantSlug}/${form.key}`;
  const snippet = `<div data-gym-lead-form="${url}"></div>\n<script src="${base}/embed/lead-form.js" async></script>`;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Settings", href: "/settings/crm" },
          { label: "Capture forms", href: "/settings/crm/forms" },
          { label: form.name },
        ]}
      />
      <PageHeader
        title={form.name}
        actions={
          <ConfirmDialog
            trigger="Switch off"
            title="Switch this form off?"
            description="Its link and embeds stop working. Leads it brought in stay."
            confirmLabel="Switch off"
            formAction={archiveFormAction}
            fields={{ formId: form.id }}
          />
        }
      />
      <Flash params={sp} />
      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <FormEditor
          values={form}
          branches={access.branches}
          sources={setup.sources}
          campaigns={setup.campaigns}
        />
        <aside className="flex flex-col gap-4">
          <Card>
            <CardTitle>Share the link</CardTitle>
            <p className="mt-2 break-all text-sm">
              <a
                className="text-primary underline"
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                {url}
              </a>
            </p>
            <div className="mt-2">
              <CopyButton text={url} />
            </div>
            <p className="mt-3 text-xs text-muted">
              Add <code>?utm_source=instagram&amp;utm_campaign=your-code</code>{" "}
              to track where enquiries come from.
            </p>
          </Card>
          <Card>
            <CardTitle>Put it on your website</CardTitle>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-background p-2 text-xs">
              {snippet}
            </pre>
            <div className="mt-2">
              <CopyButton text={snippet} />
            </div>
            <p className="mt-3 text-xs text-muted">
              The page&apos;s own UTM tags are passed on. Add your site under
              &quot;Websites allowed to embed it&quot; first.
            </p>
          </Card>
        </aside>
      </div>
    </>
  );
}
