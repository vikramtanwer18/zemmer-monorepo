import { hasPermission } from "@gym/core/authz";
import { listApiKeys } from "@gym/core/crm";
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { SettingsTabs } from "../../settings-tabs";
import { revokeApiKeyAction } from "../actions";
import { CrmSettingsTabs } from "../crm-tabs";
import { NewKeyForm } from "./new-key-form";

export const metadata: Metadata = { title: "Website API" };

export default async function ApiKeysPage({
  searchParams,
}: PageProps<"/settings/crm/api">) {
  const { ctx, access } = await requireReady("/settings/crm/api");
  if (!hasPermission(ctx, "crm.configure")) return <NoAccess />;
  const sp = await searchParams;
  const keys = await orUpgrade(listApiKeys(services().deps, ctx));
  if (!keys) return <UpgradeNotice title="Settings" feature="Leads and CRM" />;
  const base = services().deps.appUrl ?? "";
  return (
    <>
      <PageHeader
        title="Settings"
        description="For your web developer: send enquiries from your own website forms straight into Leads."
      />
      <SettingsTabs current="/settings/crm" />
      <CrmSettingsTabs current="/settings/crm/api" />
      <Flash params={sp} />
      <p className="mb-4 text-sm">
        <code className="text-xs">POST {base}/api/public/v1/leads</code> with{" "}
        <code className="text-xs">Authorization: Bearer &lt;key&gt;</code>. Full
        reference:{" "}
        <a
          className="text-primary underline"
          href="/api/public/v1/openapi.json"
        >
          OpenAPI document
        </a>
        . Keep keys on your server; never put them in a web page.
      </p>
      <DataTable
        caption="API keys"
        rows={keys}
        rowKey={(k) => k.id}
        empty={<EmptyState title="No keys yet" />}
        columns={[
          {
            key: "name",
            header: "Key",
            cell: (k) => (
              <span className="flex flex-col">
                <span className="font-medium">{k.name}</span>
                <code className="text-xs text-muted">gk_{k.prefix}_…</code>
              </span>
            ),
          },
          { key: "branch", header: "Leads go to", cell: (k) => k.branch.name },
          {
            key: "used",
            header: "Last used",
            hideOnMobile: true,
            cell: (k) =>
              k.lastUsedAt ? when(k.lastUsedAt, ctx.timezone) : "Never",
          },
          {
            key: "status",
            header: "Status",
            cell: (k) =>
              k.revokedAt ? (
                <Badge tone="neutral">revoked</Badge>
              ) : (
                <Badge tone="success">active</Badge>
              ),
          },
          {
            key: "actions",
            header: "",
            cell: (k) =>
              k.revokedAt ? null : (
                <ConfirmDialog
                  trigger="Revoke"
                  title={`Revoke "${k.name}"?`}
                  description="Requests using it fail straight away. This can't be undone; create a new key instead."
                  confirmLabel="Revoke key"
                  formAction={revokeApiKeyAction}
                  fields={{ keyId: k.id }}
                />
              ),
          },
        ]}
      />
      <h2 className="mb-3 mt-8 text-base font-semibold">New key</h2>
      <NewKeyForm
        branches={access.branches.map((b) => ({ value: b.id, label: b.name }))}
      />
    </>
  );
}
