import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { getRewardSettings } from "@gym/core/engagement";
import {
  ActionForm,
  Button,
  Card,
  CardTitle,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  achievementAction,
  perkAction,
  rewardSettingsAction,
} from "../actions";
import { EngagementTabs } from "../engagement-tabs";

export const metadata: Metadata = { title: "Rewards & streaks" };

export default async function RewardsSettingsPage({
  searchParams,
}: PageProps<"/engagement/rewards">) {
  const { ctx } = await requireReady("/engagement/rewards");
  if (!hasPermission(ctx, "engagement.manage")) return <NoAccess />;
  const sp = await searchParams;
  const data = await orUpgrade(getRewardSettings(services().deps, ctx));
  if (!data)
    return (
      <UpgradeNotice title="Rewards" feature="Streaks, rewards and referrals" />
    );
  const canEdit = isTenantWritable(ctx);
  return (
    <>
      <PageHeader
        title="Engagement"
        description="Points reward showing up, not overdoing it: visits count once a day and stop earning after the weekly cap, so rest days cost nothing."
      />
      <EngagementTabs current="/engagement/rewards" rewards />
      <Flash params={sp} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <CardTitle>Points and streaks</CardTitle>
          <ActionForm
            action={rewardSettingsAction}
            className="flex flex-col gap-3"
          >
            <fieldset disabled={!canEdit} className="flex flex-col gap-3">
              {data.rules.map((r) => (
                <div
                  key={r.trigger}
                  className="grid grid-cols-[auto_6rem_1fr] items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    name={`enabled_${r.trigger}`}
                    defaultChecked={r.enabled}
                    aria-label={`${r.label} on`}
                  />
                  <input
                    type="number"
                    min={0}
                    name={`points_${r.trigger}`}
                    defaultValue={r.points}
                    aria-label={`${r.label} points`}
                    className="h-9 rounded-md border border-border bg-surface px-2"
                    disabled={
                      r.trigger === "CHALLENGE_COMPLETED" ||
                      r.trigger === "ACHIEVEMENT"
                    }
                  />
                  <span>{r.label}</span>
                </div>
              ))}
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label="Rewarded visit days per week"
                  name="rewardVisitWeeklyCap"
                  type="number"
                  min={0}
                  max={7}
                  defaultValue={data.settings.rewardVisitWeeklyCap}
                />
                <FormField
                  label="1 point is worth (₹, as credit)"
                  name="pointValueRupees"
                  inputMode="decimal"
                  defaultValue={String(
                    data.settings.rewardPointValueMinor / 100,
                  )}
                  hint="0 = points can't become credit"
                />
                <FormField
                  label="Minimum points to redeem"
                  name="rewardMinRedeemPoints"
                  type="number"
                  min={1}
                  defaultValue={data.settings.rewardMinRedeemPoints}
                />
                <FormField
                  label="Streak: visit days needed per week"
                  name="streakVisitsPerWeek"
                  type="number"
                  min={1}
                  max={7}
                  defaultValue={data.settings.streakVisitsPerWeek}
                />
                <FormField
                  label="Streak survives this many days after expiry"
                  name="streakGraceDays"
                  type="number"
                  min={0}
                  max={90}
                  defaultValue={data.settings.streakGraceDays}
                />
              </div>
              {canEdit && (
                <div>
                  <SubmitButton>Save</SubmitButton>
                </div>
              )}
            </fieldset>
          </ActionForm>
          <p className="text-xs text-muted">
            Frozen memberships pause the streak (a week with 4+ frozen days is
            skipped). Rules are in the KPI definitions document.
          </p>
        </Card>
        <Card className="flex flex-col gap-3">
          <CardTitle>Perks members can redeem</CardTitle>
          <ul className="flex flex-col gap-2 text-sm">
            {data.perks.map((p) => (
              <li key={p.id}>
                <ActionForm
                  action={perkAction}
                  className="grid grid-cols-[1fr_5rem_auto] items-end gap-2"
                >
                  <input type="hidden" name="perkId" value={p.id} />
                  <FormField label="Perk" name="name" defaultValue={p.name} />
                  <FormField
                    label="Points"
                    name="pointsCost"
                    defaultValue={String(p.pointsCost)}
                    inputMode="numeric"
                  />
                  <SubmitButton size="sm" variant="outline">
                    Save
                  </SubmitButton>
                  <input
                    type="hidden"
                    name="active"
                    value={p.active ? "on" : "off"}
                  />
                </ActionForm>
              </li>
            ))}
          </ul>
          {canEdit && (
            <ActionForm
              action={perkAction}
              resetOnSuccess
              className="grid grid-cols-[1fr_5rem_auto] items-end gap-2"
            >
              <FormField
                label="New perk"
                name="name"
                placeholder="Shaker bottle"
                required
              />
              <FormField
                label="Points"
                name="pointsCost"
                inputMode="numeric"
                required
              />
              <SubmitButton size="sm">Add</SubmitButton>
            </ActionForm>
          )}
        </Card>
      </div>
      <section className="mt-8">
        <h2 className="mb-2 text-base font-semibold">Milestones</h2>
        <DataTable
          caption="Milestones"
          rows={data.achievements}
          rowKey={(a) => a.id}
          empty={<EmptyState title="No milestones" />}
          columns={[
            {
              key: "n",
              header: "Milestone",
              cell: (a) => (
                <span className="flex flex-col">
                  <span className="font-medium">{a.name}</span>
                  <span className="text-xs text-muted">{a.description}</span>
                </span>
              ),
            },
            {
              key: "e",
              header: "Points / on",
              cell: (a) =>
                canEdit ? (
                  <form
                    action={achievementAction}
                    className="flex items-center gap-2"
                  >
                    <input type="hidden" name="id" value={a.id} />
                    <input
                      type="number"
                      min={0}
                      name="points"
                      defaultValue={a.points}
                      aria-label={`${a.name} points`}
                      className="h-9 w-20 rounded-md border border-border bg-surface px-2"
                    />
                    <input
                      type="checkbox"
                      name="enabled"
                      defaultChecked={a.enabled}
                      aria-label={`${a.name} on`}
                    />
                    <Button type="submit" size="sm" variant="ghost">
                      Save
                    </Button>
                  </form>
                ) : (
                  `${a.points}${a.enabled ? "" : " (off)"}`
                ),
            },
          ]}
        />
      </section>
    </>
  );
}
