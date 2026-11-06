import { myWorkoutLog, NON_MEDICAL_DISCLAIMER } from "@gym/core/fitness";
import {
  ActionForm,
  Badge,
  Button,
  Card,
  CardTitle,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { RestTimer } from "@/components/rest-timer";
import { when } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";
import {
  completeWorkoutAction,
  deleteSetAction,
  logSetAction,
} from "../../actions";

export const metadata: Metadata = { title: "Workout" };

const input =
  "h-11 w-full rounded-md border border-border bg-surface px-2 text-base";

type Ex = {
  id: string;
  name: string;
  measure: "REPS" | "TIME" | "DISTANCE";
  planItemId?: string;
  sets: number;
  target: string;
  restSec: number;
  guidance?: string;
  instructions?: string;
  mediaUrl?: string | null;
};

export default async function WorkoutLogPage({
  params,
  searchParams,
}: PageProps<"/m/workouts/log/[id]">) {
  const { id } = await params;
  const { mctx } = await requireMember(`/m/workouts/log/${id}`);
  const sp = await searchParams;
  const { log, day, exercises, feedback } = await myWorkoutLog(
    services().deps,
    mctx,
    id,
  );
  const open = log.status === "IN_PROGRESS";
  // Planned exercises first (in plan order), then anything else logged.
  const planned: Ex[] = (day?.items ?? []).map((it) => ({
    id: it.exerciseId,
    name: exercises[it.exerciseId]?.name ?? "Exercise",
    measure: (exercises[it.exerciseId]?.measure ?? "REPS") as Ex["measure"],
    planItemId: it.id,
    sets: it.sets,
    target: it.durationSec
      ? `${it.durationSec}s`
      : it.distanceM
        ? `${it.distanceM} m`
        : it.repsMin
          ? `${it.repsMin}${it.repsMax && it.repsMax !== it.repsMin ? `–${it.repsMax}` : ""} reps`
          : "",
    restSec: it.restSec,
    guidance: it.weightGuidance,
    instructions: exercises[it.exerciseId]?.instructions,
    mediaUrl: exercises[it.exerciseId]?.mediaUrl,
  }));
  const extra = [
    ...new Map(
      log.sets
        .filter((s) => !planned.some((p) => p.id === s.exerciseId))
        .map((s) => [s.exerciseId, s]),
    ).values(),
  ].map((s): Ex => ({
    id: s.exerciseId,
    name: s.exercise.name,
    measure: s.exercise.measure,
    sets: 0,
    target: "",
    restSec: 60,
  }));
  const prSets = new Set(log.records.map((r) => r.setLogId));
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <h1 className="text-2xl font-semibold">{log.title}</h1>
        <Badge tone={open ? "info" : "success"}>
          {open ? "In progress" : "Done"}
        </Badge>
      </div>
      <Flash params={sp} />
      {[...planned, ...extra].map((e) => {
        const done = log.sets.filter((s) => s.exerciseId === e.id);
        const rows = Math.max(e.sets, done.length + (open ? 1 : 0));
        return (
          <Card
            key={e.planItemId ?? e.id}
            className="flex flex-col gap-2"
            data-testid="exercise"
          >
            <div className="flex items-start justify-between gap-2">
              <CardTitle>{e.name}</CardTitle>
              {open && e.restSec > 0 && <RestTimer seconds={e.restSec} />}
            </div>
            <p className="text-sm text-muted">
              {e.sets ? `${e.sets} sets` : "Extra"}
              {e.target ? ` · ${e.target}` : ""}
              {e.guidance ? ` · ${e.guidance}` : ""}
            </p>
            {e.instructions && (
              <details className="text-sm">
                <summary className="cursor-pointer text-primary">
                  How to
                </summary>
                <p className="mt-1">{e.instructions}</p>
                {e.mediaUrl && (
                  <a
                    className="text-primary underline"
                    href={e.mediaUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Video / picture
                  </a>
                )}
              </details>
            )}
            <ol className="flex flex-col gap-2">
              {Array.from({ length: rows }, (_, i) => {
                const set = done.find((s) => s.setNumber === i + 1);
                if (!open)
                  return set ? (
                    <li key={i} className="text-sm">
                      Set {i + 1}: {set.reps ?? ""}
                      {set.weightKg !== null
                        ? ` × ${Number(set.weightKg)} kg`
                        : ""}
                      {set.durationSec ? `${set.durationSec}s` : ""}
                      {set.distanceM ? `${set.distanceM} m` : ""}
                      {prSets.has(set.id) && (
                        <Badge tone="success" className="ml-2">
                          PR
                        </Badge>
                      )}
                    </li>
                  ) : null;
                return (
                  <li key={i}>
                    <ActionForm
                      action={logSetAction}
                      className="grid grid-cols-[3rem_1fr_1fr_auto] items-end gap-2"
                    >
                      <input type="hidden" name="logId" value={log.id} />
                      <input type="hidden" name="exerciseId" value={e.id} />
                      <input
                        type="hidden"
                        name="planItemId"
                        value={e.planItemId ?? ""}
                      />
                      <input type="hidden" name="setNumber" value={i + 1} />
                      <span className="pb-3 text-sm text-muted">#{i + 1}</span>
                      {e.measure === "REPS" ? (
                        <>
                          <label className="text-xs">
                            Reps
                            <input
                              name="reps"
                              inputMode="numeric"
                              defaultValue={set?.reps ?? ""}
                              className={input}
                              aria-label={`${e.name} set ${i + 1} reps`}
                            />
                          </label>
                          <label className="text-xs">
                            kg
                            <input
                              name="weightKg"
                              inputMode="decimal"
                              defaultValue={
                                set?.weightKg !== undefined &&
                                set?.weightKg !== null
                                  ? Number(set.weightKg)
                                  : ""
                              }
                              className={input}
                              aria-label={`${e.name} set ${i + 1} weight`}
                            />
                          </label>
                        </>
                      ) : e.measure === "TIME" ? (
                        <label className="col-span-2 text-xs">
                          Seconds
                          <input
                            name="durationSec"
                            inputMode="numeric"
                            defaultValue={set?.durationSec ?? ""}
                            className={input}
                            aria-label={`${e.name} set ${i + 1} seconds`}
                          />
                        </label>
                      ) : (
                        <label className="col-span-2 text-xs">
                          Metres
                          <input
                            name="distanceM"
                            inputMode="numeric"
                            defaultValue={set?.distanceM ?? ""}
                            className={input}
                            aria-label={`${e.name} set ${i + 1} metres`}
                          />
                        </label>
                      )}
                      <SubmitButton
                        size="sm"
                        variant={set ? "outline" : "primary"}
                      >
                        {set ? "Update" : "Save"}
                      </SubmitButton>
                    </ActionForm>
                    {set && (
                      <form action={deleteSetAction} className="mt-1">
                        <input type="hidden" name="logId" value={log.id} />
                        <input type="hidden" name="setId" value={set.id} />
                        <Button type="submit" size="sm" variant="ghost">
                          Remove set {i + 1}
                        </Button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ol>
          </Card>
        );
      })}
      {open ? (
        <Card>
          <form action={completeWorkoutAction} className="flex flex-col gap-3">
            <input type="hidden" name="logId" value={log.id} />
            <label className="flex flex-col gap-1 text-sm font-medium">
              How hard was it? (1 easy – 10 maximum)
              <input
                name="effort"
                type="number"
                min={1}
                max={10}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Notes
              <textarea
                name="notes"
                rows={2}
                className="rounded-md border border-border bg-surface p-2"
              />
            </label>
            <SubmitButton>Finish workout</SubmitButton>
          </form>
        </Card>
      ) : (
        <p className="text-sm text-muted">
          Finished {when(log.completedAt, mctx.timezone)}
          {log.effort ? ` · effort ${log.effort}/10` : ""}
        </p>
      )}
      {log.records.length > 0 && (
        <Card data-testid="new-records">
          <CardTitle>New personal records</CardTitle>
          <ul className="mt-2 text-sm">
            {log.records.map((r) => (
              <li key={r.id}>
                {r.exercise.name}: {Number(r.value)}{" "}
                {r.kind === "MAX_REPS"
                  ? "reps"
                  : r.kind === "MAX_DURATION"
                    ? "s"
                    : r.kind === "MAX_DISTANCE"
                      ? "m"
                      : "kg"}{" "}
                (
                {r.kind === "EST_1RM"
                  ? "estimated 1-rep max"
                  : r.kind.replace("MAX_", "max ").toLowerCase()}
                )
              </li>
            ))}
          </ul>
        </Card>
      )}
      {feedback.length > 0 && (
        <Card data-testid="feedback">
          <CardTitle>Trainer feedback</CardTitle>
          {feedback.map((f) => (
            <p key={f.id} className="mt-2 text-sm">
              {f.body}
            </p>
          ))}
        </Card>
      )}
      <p className="text-xs text-muted">
        {NON_MEDICAL_DISCLAIMER} Stop if something hurts.
      </p>
      <a href="/m/workouts" className="text-sm text-primary underline">
        Back to Train
      </a>
    </>
  );
}
