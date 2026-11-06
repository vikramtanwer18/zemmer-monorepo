import { isTenantWritable } from "@gym/core/authz";
import { isFeatureEnabled } from "@gym/core/entitlements";
import {
  fitnessAccessSummary,
  listExercises,
  listWorkoutTemplates,
  memberProgress,
  memberWorkouts,
  METRIC_LABELS,
  NON_MEDICAL_DISCLAIMER,
} from "@gym/core/fitness";
import { memberNutrition } from "@gym/core/nutrition";
import { entitlementsFor } from "@gym/core/tenancy";
import {
  ActionForm,
  Alert,
  Badge,
  Card,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  FormField,
  LinkButton,
  PageHeader,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { LineChart } from "@/components/member-fitness";
import { NoAccess } from "@/components/no-access";
import { day, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  assessmentAction,
  assignPlanAction,
  endPlanAction,
  feedbackAction,
  goalForMemberAction,
  nutritionPlanAction,
  updatePlanAction,
} from "../../actions";
import { TemplateBuilder } from "../../templates/template-builder";

export const metadata: Metadata = { title: "Member fitness" };

const ASSESS = [
  "weightKg",
  "heightCm",
  "bodyFatPct",
  "waistCm",
  "hipCm",
  "chestCm",
  "armCm",
  "thighCm",
  "restingHeartRate",
  "pushUps",
  "plankSec",
  "sitAndReachCm",
] as const;

export default async function MemberFitnessPage({
  params,
  searchParams,
}: PageProps<"/fitness/members/[id]">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/fitness/members/${id}`);
  const sp = await searchParams;
  const { deps } = services();
  const access = await fitnessAccessSummary(deps, ctx, id);
  if (!access.allowed) return <NoAccess />;
  if (!access.consent)
    return (
      <>
        <PageHeader title={access.name ?? "Member"} />
        <EmptyState
          title="No fitness tracking consent"
          description="This member hasn't agreed to store fitness and health data (or withdrew it). They can agree in the member app under Privacy."
        />
      </>
    );
  const ent = await entitlementsFor(deps, ctx.tenantId);
  const nutritionOn = isFeatureEnabled(ent, "nutrition.enabled");
  const [w, p, n] = [
    await memberWorkouts(deps, ctx, id),
    await memberProgress(deps, ctx, id),
    nutritionOn ? await memberNutrition(deps, ctx, id) : null,
  ];
  const canWrite = access.canWrite && isTenantWritable(ctx);
  const [templates, exercises] = canWrite
    ? [await listWorkoutTemplates(deps, ctx), await listExercises(deps, ctx)]
    : [[], []];
  const editPlan = sp.edit === "1" && w.plan && canWrite;
  return (
    <>
      <PageHeader
        title={access.name ?? "Member"}
        description={`${access.memberCode} · ${w.access.via === "TRAINER" ? "your client" : "owner/admin view"}`}
        actions={
          access.canExport ? (
            <LinkButton
              href={`/fitness/members/${id}/export`}
              variant="outline"
              size="sm"
            >
              Download data
            </LinkButton>
          ) : null
        }
      />
      <Flash params={sp} />
      <Alert tone="info">
        Health data: viewing is logged. {NON_MEDICAL_DISCLAIMER}
      </Alert>
      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-3" data-testid="plan">
          <CardTitle>Workout plan</CardTitle>
          {w.plan ? (
            <>
              <p className="text-sm">
                <span className="font-medium">{w.plan.plan.name}</span> · v
                {w.plan.version} · since {day(w.plan.plan.startDate)}
              </p>
              {w.plan.structure.weeks.map((wk, wi) => (
                <div key={wi} className="text-sm">
                  {w.plan!.structure.weeks.length > 1 && (
                    <p className="font-medium">Week {wi + 1}</p>
                  )}
                  {wk.days.map((d, di) => (
                    <p key={di}>
                      <span className="text-muted">
                        Day {di + 1} {d.title}:
                      </span>{" "}
                      {d.items
                        .map(
                          (i) =>
                            `${w.plan!.exercises[i.exerciseId]?.name ?? "?"} ${i.sets}×${i.durationSec ? `${i.durationSec}s` : i.distanceM ? `${i.distanceM}m` : `${i.repsMin ?? ""}${i.repsMax && i.repsMax !== i.repsMin ? `–${i.repsMax}` : ""}`}`,
                        )
                        .join(", ")}
                    </p>
                  ))}
                </div>
              ))}
              <p className="text-xs text-muted">
                Versions:{" "}
                {w.plan.plan.versions
                  .map(
                    (v) =>
                      `v${v.version} (${when(v.createdAt, ctx.timezone)}${v.note ? `, ${v.note}` : ""})`,
                  )
                  .join(" · ")}
              </p>
              {canWrite && (
                <div className="flex flex-wrap gap-2">
                  <LinkButton
                    href={`/fitness/members/${id}?edit=1`}
                    size="sm"
                    variant="outline"
                  >
                    Edit plan
                  </LinkButton>
                  <ConfirmDialog
                    trigger="End plan"
                    title="End this plan?"
                    description="The member keeps the history."
                    confirmLabel="End plan"
                    formAction={endPlanAction}
                    fields={{ planId: w.plan.plan.id, memberId: id }}
                  />
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">No active plan.</p>
          )}
          {canWrite && templates.length > 0 && (
            <form
              action={assignPlanAction}
              className="flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="memberId" value={id} />
              <label className="flex flex-col gap-1 text-sm font-medium">
                {w.plan ? "Replace with a template" : "Assign a template"}
                <select
                  name="templateId"
                  required
                  className="h-10 rounded-md border border-border bg-surface px-2"
                  aria-label="Template"
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                Starts
                <input
                  type="date"
                  name="startDate"
                  className="h-10 rounded-md border border-border bg-surface px-2"
                />
              </label>
              <SubmitButton>Assign</SubmitButton>
            </form>
          )}
          {canWrite && templates.length === 0 && (
            <p className="text-sm">
              <a
                className="text-primary underline"
                href="/fitness/templates/edit"
              >
                Build a template
              </a>{" "}
              first.
            </p>
          )}
        </Card>
        <Card className="flex flex-col gap-2" data-testid="records">
          <CardTitle>Personal records</CardTitle>
          {w.records.length === 0 && (
            <p className="text-sm text-muted">None yet.</p>
          )}
          <ul className="text-sm">
            {w.records.slice(0, 12).map((r) => (
              <li key={r.id}>
                {r.exercise.name}: {Number(r.value)}{" "}
                <span className="text-muted">
                  ({r.kind.toLowerCase().replace("_", " ")},{" "}
                  {day(r.achievedAt.toISOString().slice(0, 10))})
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {editPlan && (
        <section className="mt-6">
          <h2 className="mb-2 text-base font-semibold">
            Edit plan (saves version {w.plan!.version + 1})
          </h2>
          <TemplateBuilder
            action={updatePlanAction}
            exercises={exercises.map((e) => ({
              id: e.id,
              name: e.name,
              measure: e.measure,
              primaryMuscle: e.primaryMuscle,
            }))}
            initial={w.plan!.structure}
            extraHidden={{ planId: w.plan!.plan.id }}
            hideMeta
            submitLabel="Save new version"
          />
        </section>
      )}
      <section className="mt-6">
        <h2 className="mb-2 text-base font-semibold">Recent workouts</h2>
        {w.logs.length === 0 && (
          <p className="text-sm text-muted">None logged yet.</p>
        )}
        <div className="flex flex-col gap-3">
          {w.logs.map((l) => (
            <Card
              key={l.id}
              className="flex flex-col gap-2"
              data-testid="workout"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {l.title} · {day(l.performedOn)}
                </span>
                <span className="flex gap-1">
                  {l.records.length > 0 && (
                    <Badge tone="success">{l.records.length} PR</Badge>
                  )}
                  <Badge tone={l.status === "COMPLETED" ? "neutral" : "info"}>
                    {l.status === "COMPLETED" ? "done" : "in progress"}
                  </Badge>
                </span>
              </div>
              <p className="text-xs text-muted">
                {l.sets
                  .map(
                    (s) =>
                      `${s.exercise.name} #${s.setNumber}: ${s.reps ?? ""}${s.weightKg !== null ? `×${Number(s.weightKg)}kg` : ""}${s.durationSec ? `${s.durationSec}s` : ""}${s.distanceM ? `${s.distanceM}m` : ""}`,
                  )
                  .join(" · ")}
                {l.effort ? ` · effort ${l.effort}/10` : ""}
              </p>
              {canWrite && (
                <ActionForm
                  action={feedbackAction}
                  resetOnSuccess
                  className="flex flex-col gap-2 sm:flex-row sm:items-end"
                >
                  <input type="hidden" name="memberId" value={id} />
                  <input type="hidden" name="target" value="WORKOUT_LOG" />
                  <input type="hidden" name="targetId" value={l.id} />
                  <FormField
                    label="Feedback"
                    name="body"
                    required
                    placeholder="Nice work on…"
                  />
                  <SubmitButton size="sm">Send</SubmitButton>
                </ActionForm>
              )}
            </Card>
          ))}
        </div>
      </section>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <CardTitle>Measurements</CardTitle>
          {p.series.map((s) => (
            <LineChart
              key={s.key}
              title={s.label}
              unit={s.unit}
              points={s.points}
            />
          ))}
          {p.series.length === 0 && (
            <p className="text-sm text-muted">No assessments yet.</p>
          )}
          {canWrite && (
            <details>
              <summary className="cursor-pointer text-sm text-primary">
                Record an assessment
              </summary>
              <ActionForm
                action={assessmentAction}
                resetOnSuccess
                className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3"
              >
                <input type="hidden" name="memberId" value={id} />
                <FormField label="Date" name="assessedOn" type="date" />
                {ASSESS.map((m) => (
                  <FormField
                    key={m}
                    label={`${METRIC_LABELS[m].label} (${METRIC_LABELS[m].unit})`}
                    name={`m_${m}`}
                    inputMode="decimal"
                  />
                ))}
                <div className="col-span-2 sm:col-span-3">
                  <TextareaField
                    label="Notes (no diagnoses)"
                    name="notes"
                    rows={2}
                  />
                </div>
                <SubmitButton>Save</SubmitButton>
              </ActionForm>
            </details>
          )}
        </Card>
        <Card className="flex flex-col gap-3">
          <CardTitle>Goals</CardTitle>
          {p.goals.length === 0 && (
            <p className="text-sm text-muted">No goals yet.</p>
          )}
          <ul className="text-sm">
            {p.goals.map((g) => (
              <li key={g.id}>
                {g.title}{" "}
                <Badge tone={g.status === "ACHIEVED" ? "success" : "neutral"}>
                  {g.status.toLowerCase()}
                </Badge>{" "}
                {g.progress !== null && (
                  <span className="text-muted">{g.progress}%</span>
                )}
              </li>
            ))}
          </ul>
          {canWrite && (
            <ActionForm
              action={goalForMemberAction}
              resetOnSuccess
              className="grid grid-cols-2 gap-2"
            >
              <input type="hidden" name="memberId" value={id} />
              <SelectField
                label="Kind"
                name="type"
                options={[
                  { value: "WEIGHT", label: "Body weight" },
                  { value: "BODY_FAT", label: "Body fat %" },
                  { value: "STRENGTH", label: "Strength" },
                  { value: "ATTENDANCE", label: "Visits" },
                  { value: "CUSTOM", label: "Other" },
                ]}
              />
              <FormField label="Goal" name="title" required />
              <FormField label="From" name="startValue" inputMode="decimal" />
              <FormField label="To" name="targetValue" inputMode="decimal" />
              <SubmitButton size="sm">Add goal</SubmitButton>
            </ActionForm>
          )}
          {canWrite && (
            <ActionForm
              action={feedbackAction}
              resetOnSuccess
              className="flex flex-col gap-2"
            >
              <input type="hidden" name="memberId" value={id} />
              <input type="hidden" name="target" value="GENERAL" />
              <TextareaField
                label="A note to the member"
                name="body"
                rows={2}
                required
              />
              <SubmitButton size="sm" variant="outline">
                Send note
              </SubmitButton>
            </ActionForm>
          )}
        </Card>
      </div>
      {n && (
        <Card className="mt-6 flex flex-col gap-3" data-testid="nutrition">
          <CardTitle>Nutrition (estimates)</CardTitle>
          {n.plan ? (
            <p className="text-sm">
              <span className="font-medium">{n.plan.name}</span>:{" "}
              {n.plan.kcalTarget ?? "—"} kcal, protein{" "}
              {n.plan.proteinTarget ?? "—"} g, water{" "}
              {n.plan.waterTargetMl ?? "—"} ml
            </p>
          ) : (
            <p className="text-sm text-muted">No diet plan.</p>
          )}
          <p className="text-sm">
            This week: {n.week.summary.daysLogged} day(s) logged, average{" "}
            {Math.round(n.week.summary.average.kcal)} kcal, protein{" "}
            {Math.round(n.week.summary.average.proteinG)} g.
          </p>
          <p className="text-xs text-muted">{n.note}</p>
          {canWrite && (
            <details>
              <summary className="cursor-pointer text-sm text-primary">
                {n.plan ? "Replace the diet plan" : "Set a diet plan"}
              </summary>
              <ActionForm
                action={nutritionPlanAction}
                className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3"
              >
                <input type="hidden" name="memberId" value={id} />
                <div className="col-span-2 sm:col-span-3">
                  <FormField
                    label="Name"
                    name="name"
                    required
                    defaultValue="Diet plan"
                  />
                </div>
                <FormField
                  label="kcal / day"
                  name="kcalTarget"
                  inputMode="numeric"
                />
                <FormField
                  label="Protein g"
                  name="proteinTarget"
                  inputMode="numeric"
                />
                <FormField
                  label="Carbs g"
                  name="carbsTarget"
                  inputMode="numeric"
                />
                <FormField label="Fat g" name="fatTarget" inputMode="numeric" />
                <FormField
                  label="Water ml"
                  name="waterTargetMl"
                  inputMode="numeric"
                />
                <div className="col-span-2 sm:col-span-3">
                  <TextareaField
                    label="Meals, one per line: slot | time | what"
                    name="mealsText"
                    rows={4}
                    hint="e.g. breakfast | 08:00 | 2 idli + sambar"
                  />
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <TextareaField label="Notes" name="notes" rows={2} />
                </div>
                <SubmitButton size="sm">Save diet plan</SubmitButton>
              </ActionForm>
            </details>
          )}
        </Card>
      )}
    </>
  );
}
