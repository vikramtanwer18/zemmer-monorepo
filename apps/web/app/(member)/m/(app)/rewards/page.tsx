import {
  myChallenges,
  myEngagement,
  myReferrals,
  myRewards,
} from "@gym/core/engagement";
import {
  ActionForm,
  Badge,
  Button,
  Card,
  CardTitle,
  CheckboxField,
  EmptyState,
  FormField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { TrainNav } from "@/components/member-fitness";
import { day } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";
import {
  joinChallengeAction,
  leaveChallengeAction,
  redeemCreditAction,
  requestPerkAction,
} from "../workouts/actions";

export const metadata: Metadata = { title: "Rewards" };

export default async function MemberRewardsPage({
  searchParams,
}: PageProps<"/m/rewards">) {
  const { mctx } = await requireMember("/m/rewards");
  const sp = await searchParams;
  const { deps, appUrl } = services();
  const eng = await myEngagement(deps, mctx);
  if (!eng.rewards)
    return (
      <>
        <h1 className="text-2xl font-semibold">Rewards</h1>
        <TrainNav
          current="/m/rewards"
          nutrition={eng.nutrition}
          rewards={false}
        />
        <EmptyState title="Rewards aren't available at this gym" />
      </>
    );
  const [rewards, challenges, referrals] = [
    await myRewards(deps, mctx),
    await myChallenges(deps, mctx),
    await myReferrals(deps, mctx),
  ];
  const value = rewards.settings.rewardPointValueMinor;
  const link = `${appUrl}${referrals.path}`;
  return (
    <>
      <h1 className="text-2xl font-semibold">Rewards</h1>
      <TrainNav current="/m/rewards" nutrition={eng.nutrition} rewards />
      <Flash params={sp} />
      <Card className="flex items-center justify-between" data-testid="points">
        <div>
          <p className="text-sm text-muted">Your points</p>
          <p className="text-3xl font-semibold">{rewards.balance}</p>
        </div>
        <div className="text-right text-sm text-muted">
          <p>
            Streak {eng.streak.currentWeeks} wk (best {eng.streak.longestWeeks})
          </p>
          {value > 0 && <p>1 point = ₹{(value / 100).toFixed(2)}</p>}
        </div>
      </Card>
      {value > 0 && (
        <Card className="flex flex-col gap-2">
          <CardTitle>Use points as credit</CardTitle>
          <p className="text-sm text-muted">
            Credit pays towards your next invoice. Minimum{" "}
            {rewards.settings.rewardMinRedeemPoints} points.
          </p>
          <ActionForm
            action={redeemCreditAction}
            className="flex items-end gap-2"
          >
            <FormField
              label="Points"
              name="points"
              inputMode="numeric"
              defaultValue={String(
                Math.max(
                  rewards.settings.rewardMinRedeemPoints,
                  Math.floor(rewards.balance / 10) * 10,
                ),
              )}
            />
            <SubmitButton
              disabled={
                rewards.balance < rewards.settings.rewardMinRedeemPoints
              }
            >
              Redeem
            </SubmitButton>
          </ActionForm>
        </Card>
      )}
      {rewards.perks.length > 0 && (
        <Card className="flex flex-col gap-2">
          <CardTitle>Rewards at the desk</CardTitle>
          <ul className="flex flex-col gap-2 text-sm">
            {rewards.perks.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2"
              >
                <span>
                  {p.name}{" "}
                  <span className="text-muted">· {p.pointsCost} pts</span>
                </span>
                <form action={requestPerkAction}>
                  <input type="hidden" name="perkId" value={p.id} />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={rewards.balance < p.pointsCost}
                  >
                    Get it
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card className="flex flex-col gap-2" data-testid="referral">
        <CardTitle>Invite a friend</CardTitle>
        <p className="text-sm">
          Share your link.{" "}
          {referrals.points > 0
            ? `When they join and pay, you get ${referrals.points} points.`
            : ""}
        </p>
        <p className="break-all rounded-md bg-background p-2 font-mono text-xs">
          {link}
        </p>
        <a
          className="text-sm text-primary underline"
          href={`https://wa.me/?text=${encodeURIComponent(`Join me at ${mctx.tenantName}: ${link}`)}`}
          target="_blank"
          rel="noreferrer"
        >
          Share on WhatsApp
        </a>
        {referrals.referrals.length > 0 && (
          <ul className="text-sm">
            {referrals.referrals.map((r) => (
              <li key={r.id}>
                {r.name}:{" "}
                <Badge tone={r.status === "REWARDED" ? "success" : "neutral"}>
                  {r.status === "REWARDED"
                    ? `joined, +${r.rewardPoints ?? 0}`
                    : r.status.toLowerCase()}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="flex flex-col gap-3">
        <CardTitle>Challenges</CardTitle>
        {challenges.length === 0 && (
          <p className="text-sm text-muted">No open challenges right now.</p>
        )}
        {challenges.map((c) => (
          <div
            key={c.id}
            className="flex flex-col gap-2 rounded-md border border-border p-3"
            data-testid="challenge"
          >
            <p className="font-medium">{c.name}</p>
            <p className="text-xs text-muted">
              {c.target} {c.metric === "VISITS" ? "visit days" : "workout days"}{" "}
              between {day(c.startsOn)} and {day(c.endsOn)} (each day counts
              once).{c.points ? ` ${c.points} points.` : ""}
            </p>
            {c.entry ? (
              <>
                <p className="text-sm">
                  {c.entry.progress}/{c.target}{" "}
                  {c.entry.completedAt && <Badge tone="success">done</Badge>}
                </p>
                <form action={leaveChallengeAction}>
                  <input type="hidden" name="challengeId" value={c.id} />
                  <Button type="submit" size="sm" variant="ghost">
                    Leave
                  </Button>
                </form>
              </>
            ) : (
              <ActionForm
                action={joinChallengeAction}
                className="flex flex-col gap-2"
              >
                <input type="hidden" name="challengeId" value={c.id} />
                <FormField
                  label="Name on the board"
                  name="displayName"
                  required
                  placeholder="e.g. Iron Lady"
                />
                <CheckboxField
                  name="showOnBoard"
                  label="Show me on the leaderboard"
                  defaultChecked
                />
                <SubmitButton size="sm">Join</SubmitButton>
              </ActionForm>
            )}
            {c.leaderboard && c.leaderboard.length > 0 && (
              <ol className="text-sm">
                {c.leaderboard.map((r) => (
                  <li
                    key={`${r.rank}${r.displayName}`}
                    className={r.me ? "font-semibold" : ""}
                  >
                    {r.rank}. {r.displayName} · {r.progress}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </Card>
      <Card className="flex flex-col gap-2">
        <CardTitle>Milestones</CardTitle>
        <ul className="grid grid-cols-2 gap-2 text-sm">
          {rewards.achievements.map((a) => {
            const got = rewards.earned.find((e) => e.achievementId === a.id);
            return (
              <li key={a.id} className={got ? "" : "text-muted"}>
                {got ? "★" : "☆"} {a.name}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted">
          Visits count once a day, and weeks count rather than days in a row:
          rest days never cost you anything.
        </p>
      </Card>
      <Card>
        <CardTitle>History</CardTitle>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {rewards.history.map((h) => (
            <li key={h.id} className="flex justify-between gap-2">
              <span>{h.reason}</span>
              <span className={h.points < 0 ? "text-danger" : "text-success"}>
                {h.points > 0 ? `+${h.points}` : h.points}
              </span>
            </li>
          ))}
          {rewards.history.length === 0 && (
            <li className="text-muted">
              No points yet. Check in to start earning.
            </li>
          )}
        </ul>
      </Card>
    </>
  );
}
