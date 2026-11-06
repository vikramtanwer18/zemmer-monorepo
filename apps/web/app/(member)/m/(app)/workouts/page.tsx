import { myEngagement } from "@gym/core/engagement";
import {
  myWorkoutHistory,
  myWorkoutToday,
  NON_MEDICAL_DISCLAIMER,
} from "@gym/core/fitness";
import {
  Badge,
  Card,
  CardTitle,
  EmptyState,
  LinkButton,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { HealthConsentGate, TrainNav } from "@/components/member-fitness";
import { orUpgrade } from "@/components/upgrade-notice";
import { day } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";
import { startWorkoutAction } from "./actions";

export const metadata: Metadata = { title: "Workouts" };

const KIND: Record<string, string> = {
  MAX_WEIGHT: "heaviest",
  EST_1RM: "est. 1-rep max",
  MAX_REPS: "most reps",
  MAX_DURATION: "longest",
  MAX_DISTANCE: "farthest",
};
const unit = (kind: string) =>
  kind === "MAX_REPS"
    ? "reps"
    : kind === "MAX_DURATION"
      ? "s"
      : kind === "MAX_DISTANCE"
        ? "m"
        : "kg";

export default async function MemberWorkoutsPage({
  searchParams,
}: PageProps<"/m/workouts">) {
  const { mctx } = await requireMember("/m/workouts");
  const sp = await searchParams;
  const { deps } = services();
  const eng = await myEngagement(deps, mctx);
  const nav = (
    <TrainNav
      current="/m/workouts"
      nutrition={eng.nutrition}
      rewards={eng.rewards}
    />
  );
  if (!eng.workouts)
    return (
      <>
        <h1 className="text-2xl font-semibold">Train</h1>
        {nav}
        <EmptyState
          title="Workout plans aren't available at this gym"
          description="Ask the front desk about personal training."
        />
      </>
    );
  const [today, history] = [
    await orUpgrade(myWorkoutToday(deps, mctx)),
    await orUpgrade(myWorkoutHistory(deps, mctx, 10)),
  ];
  return (
    <>
      <h1 className="text-2xl font-semibold">Train</h1>
      {nav}
      <Flash params={sp} />
      <Card className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Weekly streak</p>
          <p className="text-2xl font-semibold">{eng.streak.currentWeeks} wk</p>
        </div>
        <p className="text-right text-sm text-muted">
          This week: {eng.streak.thisWeek.visits}/{eng.streak.thisWeek.needed}{" "}
          visit days
          {eng.streak.status === "FROZEN" && (
            <span className="block">
              Paused while your membership is frozen
            </span>
          )}
        </p>
      </Card>
      <HealthConsentGate mctx={mctx} back="/m/workouts">
        {today?.open && (
          <Card className="flex flex-col gap-2">
            <CardTitle>In progress: {today.open.title}</CardTitle>
            <p className="text-sm text-muted">
              {today.open.sets.length} sets logged
            </p>
            <LinkButton href={`/m/workouts/log/${today.open.id}`}>
              Continue
            </LinkButton>
          </Card>
        )}
        {today?.plan ? (
          <Card className="flex flex-col gap-3" data-testid="todays-workout">
            <div className="flex items-start justify-between gap-2">
              <CardTitle>{today.plan.plan.name}</CardTitle>
              <Badge>v{today.plan.version}</Badge>
            </div>
            {today.next && !today.next.weekDone ? (
              <>
                <p className="text-sm">
                  Today: <span className="font-medium">{today.next.title}</span>{" "}
                  (week {today.next.week}, day {today.next.day})
                </p>
                <ul className="text-sm text-muted">
                  {today.plan.structure.weeks[today.next.week - 1]!.days[
                    today.next.day - 1
                  ]!.items.map((it) => (
                    <li key={it.id}>
                      {today.plan!.exercises[it.exerciseId]?.name ?? "Exercise"}{" "}
                      · {it.sets} ×{" "}
                      {it.durationSec
                        ? `${it.durationSec}s`
                        : it.distanceM
                          ? `${it.distanceM} m`
                          : it.repsMin
                            ? `${it.repsMin}${it.repsMax && it.repsMax !== it.repsMin ? `–${it.repsMax}` : ""}`
                            : "?"}
                    </li>
                  ))}
                </ul>
                {!today.open && (
                  <form action={startWorkoutAction}>
                    <input type="hidden" name="dayKey" value={today.next.key} />
                    <SubmitButton>Start workout</SubmitButton>
                  </form>
                )}
              </>
            ) : (
              <p className="text-sm">
                All of this week&apos;s sessions are done. Rest well!
              </p>
            )}
            <p className="text-xs text-muted">{NON_MEDICAL_DISCLAIMER}</p>
          </Card>
        ) : (
          <EmptyState
            title="No plan yet"
            description="Your trainer sets one up for you. You can still log a free workout."
          />
        )}
        {!today?.open && (
          <form action={startWorkoutAction}>
            <input type="hidden" name="dayKey" value="" />
            <SubmitButton variant="outline">Log a free workout</SubmitButton>
          </form>
        )}
        {history && history.records.length > 0 && (
          <Card>
            <CardTitle>Personal records</CardTitle>
            <ul
              className="mt-2 flex flex-col gap-1 text-sm"
              data-testid="records"
            >
              {history.records.slice(0, 12).map((r) => (
                <li key={r.id} className="flex justify-between gap-2">
                  <span>
                    {r.exercise.name}{" "}
                    <span className="text-muted">({KIND[r.kind]})</span>
                  </span>
                  <span className="font-medium">
                    {Number(r.value)} {unit(r.kind)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {history && history.logs.length > 0 && (
          <Card>
            <CardTitle>Recent workouts</CardTitle>
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {history.logs.map((l) => (
                <li key={l.id}>
                  <a
                    className="flex justify-between text-primary underline"
                    href={`/m/workouts/log/${l.id}`}
                  >
                    <span>
                      {l.title} · {day(l.performedOn)}
                    </span>
                    <span className="text-muted">
                      {l._count.sets} sets
                      {l._count.records ? ` · ${l._count.records} PR` : ""}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </HealthConsentGate>
    </>
  );
}
