import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listRedemptions } from "@gym/core/engagement";
import { Button, DataTable, EmptyState, PageHeader, Tabs } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { decidePerkAction } from "../actions";
import { EngagementTabs } from "../engagement-tabs";

export const metadata: Metadata = { title: "Reward pickups" };

export default async function RedemptionsPage({
  searchParams,
}: PageProps<"/engagement/redemptions">) {
  const { ctx } = await requireReady("/engagement/redemptions");
  if (!hasPermission(ctx, "rewards.fulfil")) return <NoAccess />;
  const sp = await searchParams;
  const status =
    sp.status === "FULFILLED" || sp.status === "REJECTED"
      ? sp.status
      : "REQUESTED";
  const rows = await orUpgrade(listRedemptions(services().deps, ctx, status));
  if (!rows)
    return (
      <UpgradeNotice
        title="Reward pickups"
        feature="Streaks, rewards and referrals"
      />
    );
  return (
    <>
      <PageHeader
        title={
          hasPermission(ctx, "engagement.manage")
            ? "Engagement"
            : "Reward pickups"
        }
        description="Perks members redeemed with points. Hand them over, or refuse (the points go back)."
      />
      {hasPermission(ctx, "engagement.manage") && (
        <EngagementTabs current="/engagement/redemptions" rewards />
      )}
      <Tabs
        label="Status"
        current={`/engagement/redemptions${status === "REQUESTED" ? "" : `?status=${status}`}`}
        items={[
          { href: "/engagement/redemptions", label: "Waiting" },
          {
            href: "/engagement/redemptions?status=FULFILLED",
            label: "Handed over",
          },
          { href: "/engagement/redemptions?status=REJECTED", label: "Refused" },
        ]}
      />
      <Flash params={sp} />
      <DataTable
        caption="Reward pickups"
        rows={rows}
        rowKey={(r) => r.id}
        empty={<EmptyState title="Nothing waiting" />}
        columns={[
          {
            key: "m",
            header: "Member",
            cell: (r) => (
              <a
                className="text-primary underline"
                href={`/members/${r.member.id}`}
              >
                {[r.member.firstName, r.member.lastName]
                  .filter(Boolean)
                  .join(" ")}{" "}
                ({r.member.memberCode})
              </a>
            ),
          },
          {
            key: "p",
            header: "Perk",
            cell: (r) => `${r.perk?.name ?? "—"} · ${r.points} pts`,
          },
          {
            key: "w",
            header: "Asked",
            hideOnMobile: true,
            cell: (r) => when(r.createdAt, ctx.timezone),
          },
          {
            key: "x",
            header: "",
            cell: (r) =>
              status === "REQUESTED" && isTenantWritable(ctx) ? (
                <form
                  action={decidePerkAction}
                  className="flex flex-wrap gap-2"
                >
                  <input type="hidden" name="id" value={r.id} />
                  <input
                    name="note"
                    placeholder="Note"
                    aria-label="Note"
                    className="h-9 w-32 rounded-md border border-border bg-surface px-2 text-sm"
                  />
                  <Button
                    type="submit"
                    name="decision"
                    value="fulfil"
                    size="sm"
                  >
                    Handed over
                  </Button>
                  <Button
                    type="submit"
                    name="decision"
                    value="refuse"
                    size="sm"
                    variant="ghost"
                  >
                    Refuse
                  </Button>
                </form>
              ) : (
                r.note
              ),
          },
        ]}
      />
    </>
  );
}
