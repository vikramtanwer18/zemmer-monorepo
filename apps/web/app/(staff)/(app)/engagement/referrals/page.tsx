import { hasPermission } from "@gym/core/authz";
import { listReferrals } from "@gym/core/engagement";
import { Badge, DataTable, EmptyState, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { EngagementTabs } from "../engagement-tabs";

export const metadata: Metadata = { title: "Referrals" };

const TONE = {
  PENDING: "neutral",
  JOINED: "info",
  REWARDED: "success",
  REJECTED: "warning",
} as const;

export default async function ReferralsPage() {
  const { ctx } = await requireReady("/engagement/referrals");
  if (!hasPermission(ctx, "leads.view")) return <NoAccess />;
  const rows = await orUpgrade(listReferrals(services().deps, ctx));
  if (!rows)
    return (
      <UpgradeNotice
        title="Referrals"
        feature="Streaks, rewards and referrals"
      />
    );
  return (
    <>
      <PageHeader
        title="Engagement"
        description="Friends who came through a member's invite link. The member gets their points when the friend's membership is paid."
      />
      {hasPermission(ctx, "engagement.manage") && (
        <EngagementTabs current="/engagement/referrals" rewards />
      )}
      <DataTable
        caption="Referrals"
        rows={rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="No referrals yet"
            description="Members share their link from the app (Rewards)."
          />
        }
        columns={[
          {
            key: "who",
            header: "Referred by",
            cell: (r) => (
              <a
                className="text-primary underline"
                href={`/members/${r.referrer.id}`}
              >
                {[r.referrer.firstName, r.referrer.lastName]
                  .filter(Boolean)
                  .join(" ")}
              </a>
            ),
          },
          {
            key: "lead",
            header: "Friend",
            cell: (r) =>
              r.lead ? (
                <a
                  className="text-primary underline"
                  href={`/leads/${r.lead.id}`}
                >
                  {[r.lead.firstName, r.lead.lastName]
                    .filter(Boolean)
                    .join(" ")}
                </a>
              ) : (
                "—"
              ),
          },
          {
            key: "s",
            header: "Status",
            cell: (r) => (
              <Badge tone={TONE[r.status]}>
                {r.status.toLowerCase()}
                {r.rewardPoints ? ` +${r.rewardPoints}` : ""}
              </Badge>
            ),
          },
          {
            key: "w",
            header: "Since",
            hideOnMobile: true,
            cell: (r) => when(r.createdAt, ctx.timezone),
          },
        ]}
      />
    </>
  );
}
