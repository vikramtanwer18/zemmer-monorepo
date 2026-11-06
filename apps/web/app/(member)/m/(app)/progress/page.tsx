import { myEngagement } from "@gym/core/engagement";
import {
  METRIC_LABELS,
  myProgress,
  NON_MEDICAL_DISCLAIMER,
} from "@gym/core/fitness";
import {
  ActionForm,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  FormField,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import {
  HealthConsentGate,
  LineChart,
  TrainNav,
} from "@/components/member-fitness";
import { orUpgrade } from "@/components/upgrade-notice";
import { day } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";
import {
  addGoalAction,
  goalStatusAction,
  measurementAction,
} from "../workouts/actions";

export const metadata: Metadata = { title: "Progress" };

const SELF_METRICS = [
  "weightKg",
  "waistCm",
  "hipCm",
  "chestCm",
  "armCm",
  "thighCm",
] as const;

export default async function MemberProgressPage({
  searchParams,
}: PageProps<"/m/progress">) {
  const { mctx } = await requireMember("/m/progress");
  const sp = await searchParams;
  const { deps } = services();
  const eng = await myEngagement(deps, mctx);
  const data = eng.workouts ? await orUpgrade(myProgress(deps, mctx)) : null;
  return (
    <>
      <h1 className="text-2xl font-semibold">Progress</h1>
      <TrainNav
        current="/m/progress"
        nutrition={eng.nutrition}
        rewards={eng.rewards}
      />
      <Flash params={sp} />
      {!data ? (
        <EmptyState title="Progress tracking isn't available at this gym" />
      ) : (
        <HealthConsentGate mctx={mctx} back="/m/progress">
          {data.series.length === 0 && data.records.length === 0 && (
            <EmptyState
              title="Nothing yet"
              description="Your trainer's assessments and your own measurements show up here as charts."
            />
          )}
          {data.series.map((s) => (
            <Card key={s.key}>
              <LineChart title={s.label} unit={s.unit} points={s.points} />
            </Card>
          ))}
          {data.records.slice(0, 6).map((r) => (
            <Card key={`${r.exercise}${r.kind}`}>
              <LineChart
                title={`${r.exercise} (${r.kind === "EST_1RM" ? "est. 1-rep max" : r.kind.replace("MAX_", "max ").toLowerCase()})`}
                unit={
                  r.kind === "MAX_REPS"
                    ? "reps"
                    : r.kind === "MAX_DURATION"
                      ? "s"
                      : "kg"
                }
                points={r.points}
              />
            </Card>
          ))}
          <Card className="flex flex-col gap-3">
            <CardTitle>Goals</CardTitle>
            {data.goals.length === 0 && (
              <p className="text-sm text-muted">No goals yet.</p>
            )}
            <ul className="flex flex-col gap-2">
              {data.goals.map((g) => (
                <li key={g.id} className="flex flex-col gap-1 text-sm">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{g.title}</span>
                    <Badge
                      tone={
                        g.status === "ACHIEVED"
                          ? "success"
                          : g.status === "ABANDONED"
                            ? "neutral"
                            : "info"
                      }
                    >
                      {g.status.toLowerCase()}
                    </Badge>
                  </span>
                  {g.progress !== null && (
                    <span
                      className="h-2 overflow-hidden rounded bg-border"
                      role="progressbar"
                      aria-valuenow={g.progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${g.title} progress`}
                    >
                      <span
                        className="block h-full bg-primary"
                        style={{ width: `${g.progress}%` }}
                      />
                    </span>
                  )}
                  <span className="text-xs text-muted">
                    {g.startValue !== null && g.targetValue !== null
                      ? `${g.startValue} → ${g.targetValue} ${g.unit ?? ""}`
                      : ""}
                    {g.deadline ? ` · by ${day(g.deadline)}` : ""}
                  </span>
                  {g.status === "ACTIVE" && (
                    <form action={goalStatusAction} className="flex gap-2">
                      <input type="hidden" name="goalId" value={g.id} />
                      <Button
                        type="submit"
                        name="status"
                        value="ACHIEVED"
                        size="sm"
                        variant="outline"
                      >
                        Done
                      </Button>
                      <Button
                        type="submit"
                        name="status"
                        value="ABANDONED"
                        size="sm"
                        variant="ghost"
                      >
                        Drop
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            <details>
              <summary className="cursor-pointer text-sm text-primary">
                Add a goal
              </summary>
              <ActionForm
                action={addGoalAction}
                resetOnSuccess
                className="mt-2 flex flex-col gap-2"
              >
                <SelectField
                  label="Kind"
                  name="type"
                  options={[
                    { value: "WEIGHT", label: "Body weight" },
                    { value: "MEASUREMENT", label: "A measurement" },
                    { value: "BODY_FAT", label: "Body fat %" },
                    { value: "ATTENDANCE", label: "Visits" },
                    { value: "CUSTOM", label: "Something else" },
                  ]}
                />
                <FormField
                  label="Goal"
                  name="title"
                  required
                  placeholder="Fit into my old jeans"
                />
                <SelectField
                  label="Measurement (for “a measurement”)"
                  name="metric"
                  options={[
                    { value: "", label: "—" },
                    ...SELF_METRICS.map((m) => ({
                      value: m,
                      label: METRIC_LABELS[m].label,
                    })),
                  ]}
                />
                <div className="grid grid-cols-2 gap-2">
                  <FormField
                    label="From"
                    name="startValue"
                    inputMode="decimal"
                  />
                  <FormField
                    label="To"
                    name="targetValue"
                    inputMode="decimal"
                  />
                </div>
                <FormField label="By (optional)" name="deadline" type="date" />
                <SubmitButton>Add goal</SubmitButton>
              </ActionForm>
            </details>
          </Card>
          <Card>
            <details>
              <summary className="cursor-pointer text-sm font-medium text-primary">
                Record my measurements
              </summary>
              <ActionForm
                action={measurementAction}
                resetOnSuccess
                className="mt-2 grid grid-cols-2 gap-2"
              >
                {SELF_METRICS.map((m) => (
                  <FormField
                    key={m}
                    label={`${METRIC_LABELS[m].label} (${METRIC_LABELS[m].unit})`}
                    name={`m_${m}`}
                    inputMode="decimal"
                  />
                ))}
                <div className="col-span-2">
                  <SubmitButton>Save</SubmitButton>
                </div>
              </ActionForm>
            </details>
          </Card>
          <p className="text-xs text-muted">{NON_MEDICAL_DISCLAIMER}</p>
        </HealthConsentGate>
      )}
    </>
  );
}
