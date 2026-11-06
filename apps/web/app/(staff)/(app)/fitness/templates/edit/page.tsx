import { hasPermission, isTenantWritable } from "@gym/core/authz";
import {
  getWorkoutTemplate,
  listExercises,
  NON_MEDICAL_DISCLAIMER,
} from "@gym/core/fitness";
import { PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { saveTemplateAction } from "../../actions";
import { TemplateBuilder } from "../template-builder";

export const metadata: Metadata = { title: "Workout template" };

export default async function TemplateEditPage({
  searchParams,
}: PageProps<"/fitness/templates/edit">) {
  const { ctx } = await requireReady("/fitness/templates/edit");
  if (!hasPermission(ctx, "fitness.manage") || !isTenantWritable(ctx))
    return <NoAccess />;
  const sp = await searchParams;
  const id = typeof sp.id === "string" ? sp.id : null;
  const { deps } = services();
  const exercises = await orUpgrade(listExercises(deps, ctx));
  if (!exercises)
    return (
      <UpgradeNotice title="Workout templates" feature="Workout programs" />
    );
  const t = id ? await getWorkoutTemplate(deps, ctx, id) : null;
  return (
    <>
      <PageHeader
        title={t ? t.name : "New template"}
        description={NON_MEDICAL_DISCLAIMER}
      />
      <Flash params={sp} />
      <TemplateBuilder
        action={saveTemplateAction}
        exercises={exercises.map((e) => ({
          id: e.id,
          name: e.name,
          measure: e.measure,
          primaryMuscle: e.primaryMuscle,
        }))}
        initial={t?.structure ?? null}
        templateId={t?.id}
        name={t?.name}
        description={t?.description}
        level={t?.level}
      />
    </>
  );
}
