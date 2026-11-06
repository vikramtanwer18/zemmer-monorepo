import { hasPermission, isTenantWritable } from "@gym/core/authz";
import {
  challengeDetail,
  engagementOptions,
  listChallenges,
} from "@gym/core/engagement";
import {
  ActionForm,
  Badge,
  Button,
  Card,
  CardTitle,
  CheckboxField,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { day } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { challengeStatusAction, saveChallengeAction } from "../actions";
import { EngagementTabs } from "../engagement-tabs";

export const metadata: Metadata = { title: "Challenges" };

const TONE = {
  DRAFT: "neutral",
  ACTIVE: "success",
  ENDED: "info",
  CANCELLED: "warning",
} as const;

export default async function ChallengesPage({
  searchParams,
}: PageProps<"/engagement/challenges">) {
  const { ctx } = await requireReady("/engagement/challenges");
  if (!hasPermission(ctx, "engagement.manage")) return <NoAccess />;
  const sp = await searchParams;
  const { deps } = services();
  const rows = await orUpgrade(listChallenges(deps, ctx));
  if (!rows)
    return (
      <UpgradeNotice
        title="Challenges"
        feature="Streaks, rewards and referrals"
      />
    );
  const { branches } = await engagementOptions(deps, ctx);
  const open =
    typeof sp.id === "string" ? await challengeDetail(deps, ctx, sp.id) : null;
  const canEdit = isTenantWritable(ctx);
  return (
    <>
      <PageHeader
        title="Engagement"
        description="Attendance or workout challenges (never body weight). Each day counts once, so nobody is pushed to train twice a day."
      />
      <EngagementTabs current="/engagement/challenges" rewards />
      <Flash params={sp} />
      <DataTable
        caption="Challenges"
        rows={rows}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No challenges yet" />}
        columns={[
          {
            key: "n",
            header: "Challenge",
            cell: (r) => (
              <a
                className="font-medium text-primary underline"
                href={`/engagement/challenges?id=${r.id}`}
              >
                {r.name}
              </a>
            ),
          },
          {
            key: "m",
            header: "Goal",
            cell: (r) =>
              `${r.target} ${r.metric === "VISITS" ? "visit" : "workout"} days`,
          },
          {
            key: "d",
            header: "Dates",
            hideOnMobile: true,
            cell: (r) => `${day(r.startsOn)} – ${day(r.endsOn)}`,
          },
          {
            key: "p",
            header: "Joined / done",
            cell: (r) => `${r.participants} / ${r.completed}`,
          },
          {
            key: "s",
            header: "Status",
            cell: (r) => (
              <Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge>
            ),
          },
          {
            key: "x",
            header: "",
            cell: (r) =>
              canEdit && (r.status === "DRAFT" || r.status === "ACTIVE") ? (
                <form action={challengeStatusAction} className="flex gap-1">
                  <input type="hidden" name="id" value={r.id} />
                  {r.status === "DRAFT" && (
                    <Button
                      type="submit"
                      name="status"
                      value="ACTIVE"
                      size="sm"
                    >
                      Start
                    </Button>
                  )}
                  {r.status === "ACTIVE" && (
                    <Button
                      type="submit"
                      name="status"
                      value="ENDED"
                      size="sm"
                      variant="outline"
                    >
                      End
                    </Button>
                  )}
                  <Button
                    type="submit"
                    name="status"
                    value="CANCELLED"
                    size="sm"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </form>
              ) : null,
          },
        ]}
      />
      {open && (
        <Card className="mt-6">
          <CardTitle>{open.challenge.name}: leaderboard</CardTitle>
          {!open.challenge.leaderboard && (
            <p className="text-sm text-muted">
              Leaderboard is off for members; staff see progress here.
            </p>
          )}
          <ol className="mt-2 text-sm">
            {open.leaderboard.map((r) => (
              <li key={r.id}>
                {r.rank}. {r.displayName} · {r.progress}{" "}
                {r.completedAt && <Badge tone="success">done</Badge>}
              </li>
            ))}
            {open.leaderboard.length === 0 && (
              <li className="text-muted">Nobody on the board yet.</li>
            )}
          </ol>
        </Card>
      )}
      {canEdit && (
        <section className="mt-8 max-w-2xl">
          <h2 className="mb-3 text-base font-semibold">New challenge</h2>
          <ActionForm
            action={saveChallengeAction}
            resetOnSuccess
            className="grid gap-3 sm:grid-cols-2"
          >
            <div className="sm:col-span-2">
              <FormField
                label="Name"
                name="name"
                required
                placeholder="12 visits in November"
              />
            </div>
            <div className="sm:col-span-2">
              <TextareaField label="Description" name="description" rows={2} />
            </div>
            <SelectField
              label="Counts"
              name="metric"
              options={[
                { value: "VISITS", label: "Visit days" },
                { value: "WORKOUTS", label: "Days with a logged workout" },
              ]}
            />
            <FormField
              label="Days needed"
              name="target"
              type="number"
              min={1}
              required
            />
            <FormField label="Starts" name="startsOn" type="date" required />
            <FormField label="Ends" name="endsOn" type="date" required />
            <SelectField
              label="Branch"
              name="branchId"
              options={[
                { value: "", label: "All branches" },
                ...branches.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />
            <FormField
              label="Points for finishing"
              name="points"
              type="number"
              min={0}
              defaultValue="100"
            />
            <CheckboxField
              name="leaderboard"
              label="Show a leaderboard (members choose their display name and can stay off it)"
            />
            <div className="sm:col-span-2">
              <SubmitButton>Save draft</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
    </>
  );
}
