import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listSendableCampaigns } from "@gym/core/growth";
import { Badge, Button, DataTable, EmptyState, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { createCampaignAction } from "./actions";
import { CampaignsTabs, SEND_STATUS } from "./campaigns-tabs";

export const metadata: Metadata = { title: "Campaigns" };

export default async function CampaignsPage({
  searchParams,
}: PageProps<"/campaigns">) {
  const { ctx } = await requireReady("/campaigns");
  if (!hasPermission(ctx, "marketing.send")) return <NoAccess />;
  const sp = await searchParams;
  const rows = await orUpgrade(listSendableCampaigns(services().deps, ctx));
  if (!rows)
    return <UpgradeNotice title="Campaigns" feature="WhatsApp campaigns" />;
  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Send an approved WhatsApp template to a saved audience. Consent and opt-outs are checked for every message when it's sent."
      />
      <CampaignsTabs current="/campaigns" />
      <Flash params={sp} />
      <DataTable
        caption="Campaigns"
        rows={rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="No campaigns yet"
            description="Create one below."
          />
        }
        columns={[
          {
            key: "name",
            header: "Campaign",
            cell: (r) => (
              <a href={`/campaigns/${r.id}`} className="flex flex-col">
                <span className="font-medium text-primary underline">
                  {r.name}
                </span>
                <code className="text-xs text-muted">{r.code}</code>
              </a>
            ),
          },
          {
            key: "status",
            header: "Status",
            cell: (r) => (
              <Badge tone={SEND_STATUS[r.sendStatus].tone}>
                {SEND_STATUS[r.sendStatus].label}
              </Badge>
            ),
          },
          {
            key: "audience",
            header: "Audience",
            hideOnMobile: true,
            cell: (r) => r.segment ?? "—",
          },
          {
            key: "recipients",
            header: "Recipients",
            cell: (r) => r.recipients || r.estimatedRecipients || "—",
          },
          {
            key: "when",
            header: "When",
            hideOnMobile: true,
            cell: (r) => when(r.completedAt ?? r.scheduledAt, ctx.timezone),
          },
        ]}
      />
      {isTenantWritable(ctx) && hasPermission(ctx, "crm.configure") && (
        <form
          action={createCampaignAction}
          className="mt-6 flex max-w-2xl flex-col gap-3 sm:flex-row sm:items-end"
        >
          <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium">
            Name
            <input
              name="name"
              required
              minLength={2}
              placeholder="Diwali offer on WhatsApp"
              className="h-10 rounded-md border border-border bg-surface px-3"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium">
            Tracking code
            <input
              name="code"
              required
              pattern="[A-Za-z0-9_.\-]+"
              placeholder="diwali-wa"
              className="h-10 rounded-md border border-border bg-surface px-3"
            />
          </label>
          <Button type="submit">New campaign</Button>
        </form>
      )}
    </>
  );
}
