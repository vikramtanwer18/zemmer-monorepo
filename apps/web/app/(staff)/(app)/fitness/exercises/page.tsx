import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { isFeatureEnabled } from "@gym/core/entitlements";
import { EQUIPMENT, listExercises, MUSCLES } from "@gym/core/fitness";
import { entitlementsFor } from "@gym/core/tenancy";
import {
  ActionForm,
  Badge,
  Button,
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
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { archiveExerciseAction, saveExerciseAction } from "../actions";
import { FitnessTabs } from "../fitness-tabs";

export const metadata: Metadata = { title: "Exercises" };
const label = (s: string) =>
  s.charAt(0).toUpperCase() + s.slice(1).replace("_", " ");

export default async function ExercisesPage({
  searchParams,
}: PageProps<"/fitness/exercises">) {
  const { ctx } = await requireReady("/fitness/exercises");
  if (!hasPermission(ctx, "fitness.manage")) return <NoAccess />;
  const sp = await searchParams;
  const { deps } = services();
  const f = {
    q: typeof sp.q === "string" ? sp.q : "",
    muscle: typeof sp.muscle === "string" ? sp.muscle : "",
    equipment: typeof sp.equipment === "string" ? sp.equipment : "",
    includeArchived: sp.archived === "1",
  };
  const rows = await orUpgrade(listExercises(deps, ctx, f));
  if (!rows)
    return <UpgradeNotice title="Exercises" feature="Workout programs" />;
  const ent = await entitlementsFor(deps, ctx.tenantId);
  const canEdit = isTenantWritable(ctx);
  return (
    <>
      <PageHeader
        title="Fitness"
        description={`${rows.length} exercises. The built-in ones have original instructions; add your own with a video link.`}
      />
      <FitnessTabs
        current="/fitness/exercises"
        nutrition={isFeatureEnabled(ent, "nutrition.enabled")}
      />
      <Flash params={sp} />
      <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
        <input
          name="q"
          defaultValue={f.q}
          placeholder="Search"
          aria-label="Search exercises"
          className="h-10 rounded-md border border-border bg-surface px-3"
        />
        <select
          name="muscle"
          defaultValue={f.muscle}
          aria-label="Muscle"
          className="h-10 rounded-md border border-border bg-surface px-2"
        >
          <option value="">Any muscle</option>
          {MUSCLES.map((m) => (
            <option key={m} value={m}>
              {label(m)}
            </option>
          ))}
        </select>
        <select
          name="equipment"
          defaultValue={f.equipment}
          aria-label="Equipment"
          className="h-10 rounded-md border border-border bg-surface px-2"
        >
          <option value="">Any equipment</option>
          {EQUIPMENT.map((m) => (
            <option key={m} value={m}>
              {label(m)}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      <DataTable
        caption="Exercises"
        rows={rows}
        rowKey={(e) => e.id}
        empty={<EmptyState title="No exercises match" />}
        columns={[
          {
            key: "name",
            header: "Exercise",
            cell: (e) => (
              <details>
                <summary className="cursor-pointer font-medium">
                  {e.name} {e.custom && <Badge>gym's own</Badge>}{" "}
                  {e.archivedAt && <Badge tone="warning">hidden</Badge>}
                </summary>
                <p className="mt-1 max-w-prose text-sm">{e.instructions}</p>
                {e.mediaUrl && (
                  <a
                    href={e.mediaUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-primary underline"
                  >
                    Media
                  </a>
                )}
              </details>
            ),
          },
          {
            key: "muscle",
            header: "Muscle",
            cell: (e) => label(e.primaryMuscle),
          },
          {
            key: "equipment",
            header: "Equipment",
            hideOnMobile: true,
            cell: (e) => label(e.equipment),
          },
          {
            key: "measure",
            header: "Logged as",
            hideOnMobile: true,
            cell: (e) => e.measure.toLowerCase(),
          },
          {
            key: "act",
            header: "",
            cell: (e) =>
              canEdit ? (
                <form action={archiveExerciseAction}>
                  <input type="hidden" name="exerciseId" value={e.id} />
                  <input
                    type="hidden"
                    name="archived"
                    value={e.archivedAt ? "false" : "true"}
                  />
                  <Button type="submit" size="sm" variant="ghost">
                    {e.archivedAt ? "Show" : "Hide"}
                  </Button>
                </form>
              ) : null,
          },
        ]}
      />
      {canEdit && (
        <section className="mt-8 max-w-2xl">
          <h2 className="mb-3 text-base font-semibold">Add an exercise</h2>
          <ActionForm
            action={saveExerciseAction}
            resetOnSuccess
            className="flex flex-col gap-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Name" name="name" required />
              <SelectField
                label="Main muscle"
                name="primaryMuscle"
                options={MUSCLES.map((m) => ({ value: m, label: label(m) }))}
              />
              <SelectField
                label="Equipment"
                name="equipment"
                options={EQUIPMENT.map((m) => ({ value: m, label: label(m) }))}
              />
              <SelectField
                label="Logged as"
                name="measure"
                options={[
                  { value: "REPS", label: "Reps (and weight)" },
                  { value: "TIME", label: "Time" },
                  { value: "DISTANCE", label: "Distance" },
                ]}
              />
              <SelectField
                label="Level"
                name="level"
                options={[
                  { value: "BEGINNER", label: "Beginner" },
                  { value: "INTERMEDIATE", label: "Intermediate" },
                  { value: "ADVANCED", label: "Advanced" },
                ]}
              />
              <FormField
                label="Video or picture link (https)"
                name="mediaUrl"
                type="url"
              />
            </div>
            <FormField
              label="Other muscles (comma separated)"
              name="muscleGroups"
              hint={MUSCLES.join(", ")}
            />
            <TextareaField
              label="How to do it"
              name="instructions"
              rows={3}
              required
            />
            <div>
              <SubmitButton>Add exercise</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
    </>
  );
}
