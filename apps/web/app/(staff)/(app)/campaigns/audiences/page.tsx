import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listSegments } from "@gym/core/growth";
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { archiveSegmentAction } from "../actions";
import { CampaignsTabs } from "../campaigns-tabs";

export const metadata: Metadata = { title: "Audiences" };

export default async function AudiencesPage({
  searchParams,
}: PageProps<"/campaigns/audiences">) {
  const { ctx } = await requireReady("/campaigns/audiences");
  if (!hasPermission(ctx, "marketing.send")) return <NoAccess />;
  const sp = await searchParams;
  const rows = await orUpgrade(listSegments(services().deps, ctx));
  if (!rows)
    return <UpgradeNotice title="Audiences" feature="WhatsApp campaigns" />;
  const canEdit = isTenantWritable(ctx);
  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Audiences are saved filters. Who's in one is worked out again when a campaign starts."
        actions={
          canEdit ? (
            <LinkButton href="/campaigns/audiences/edit">
              New audience
            </LinkButton>
          ) : null
        }
      />
      <CampaignsTabs current="/campaigns/audiences" />
      <Flash params={sp} />
      <DataTable
        caption="Audiences"
        rows={rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="No audiences yet"
            description="Build one from member or lead filters."
          />
        }
        columns={[
          {
            key: "name",
            header: "Audience",
            cell: (r) => (
              <a
                href={`/campaigns/audiences/edit?segmentId=${r.id}`}
                className="flex flex-col"
              >
                <span className="font-medium text-primary underline">
                  {r.name}
                </span>
                <span className="text-xs text-muted">{r.summary}</span>
              </a>
            ),
          },
          {
            key: "entity",
            header: "Of",
            cell: (r) => (
              <Badge>{r.entity === "MEMBER" ? "Members" : "Leads"}</Badge>
            ),
          },
          {
            key: "updated",
            header: "Updated",
            hideOnMobile: true,
            cell: (r) => when(r.updatedAt, ctx.timezone),
          },
          {
            key: "archive",
            header: "",
            cell: (r) =>
              canEdit ? (
                <ConfirmDialog
                  trigger="Archive"
                  title={`Archive ${r.name}?`}
                  description="Campaigns already sent keep their numbers."
                  confirmLabel="Archive"
                  formAction={archiveSegmentAction}
                  fields={{ segmentId: r.id }}
                />
              ) : null,
          },
        ]}
      />
    </>
  );
}
