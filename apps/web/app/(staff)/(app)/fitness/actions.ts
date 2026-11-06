"use server";

import { leaveFeedback } from "@gym/core/engagement";
import {
  addGoalForMember,
  archiveWorkoutTemplate,
  assignWorkoutPlan,
  endWorkoutPlan,
  recordAssessment,
  saveExercise,
  saveWorkoutTemplate,
  setExerciseArchived,
  updateWorkoutPlan,
} from "@gym/core/fitness";
import { assignNutritionPlan, saveFoodItem } from "@gym/core/nutrition";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

const go = (path: string, params: Record<string, string>) =>
  redirect(`${path}?${new URLSearchParams(params)}`);
const member = (id: string) => `/fitness/members/${id}`;

export async function saveExerciseAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  return formAction(
    async () =>
      saveExercise(
        services().deps,
        await getAuthContext(),
        raw.exerciseId || null,
        raw,
      ),
    "Saved.",
  );
}

export async function archiveExerciseAction(form: FormData) {
  const res = await runAction(async () =>
    setExerciseArchived(
      services().deps,
      await getAuthContext(),
      String(form.get("exerciseId")),
      form.get("archived") === "true",
    ),
  );
  go(
    "/fitness/exercises",
    res.ok ? { notice: "Updated." } : { error: res.error.message },
  );
}

/** The template builder posts its structure as JSON. */
export async function saveTemplateAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  const res = await runAction(async () =>
    saveWorkoutTemplate(
      services().deps,
      await getAuthContext(),
      raw.templateId || null,
      raw,
    ),
  );
  if (!res.ok) return res;
  if (!raw.templateId)
    redirect(
      `/fitness/templates/edit?${new URLSearchParams({ id: res.data.id, notice: "Template saved." })}`,
    );
  return { ok: true, message: "Saved." };
}

export async function archiveTemplateAction(form: FormData) {
  const res = await runAction(async () =>
    archiveWorkoutTemplate(
      services().deps,
      await getAuthContext(),
      String(form.get("templateId")),
    ),
  );
  go(
    "/fitness/templates",
    res.ok ? { notice: "Archived." } : { error: res.error.message },
  );
}

export async function assignPlanAction(form: FormData) {
  const memberId = String(form.get("memberId"));
  const res = await runAction(async () =>
    assignWorkoutPlan(
      services().deps,
      await getAuthContext(),
      memberId,
      formDataToObject(form),
    ),
  );
  go(
    member(memberId),
    res.ok
      ? { notice: "Plan assigned. The member sees it in the app." }
      : { error: res.error.message },
  );
}

export async function updatePlanAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  return formAction(
    async () =>
      updateWorkoutPlan(
        services().deps,
        await getAuthContext(),
        raw.planId ?? "",
        raw,
      ),
    "Saved as a new version.",
  );
}

export async function endPlanAction(form: FormData) {
  const memberId = String(form.get("memberId"));
  const res = await runAction(async () =>
    endWorkoutPlan(
      services().deps,
      await getAuthContext(),
      String(form.get("planId")),
    ),
  );
  go(
    member(memberId),
    res.ok ? { notice: "Plan ended." } : { error: res.error.message },
  );
}

export async function assessmentAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  const metrics: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw))
    if (k.startsWith("m_") && v !== "") metrics[k.slice(2)] = v;
  return formAction(
    async () =>
      recordAssessment(
        services().deps,
        await getAuthContext(),
        raw.memberId ?? "",
        { assessedOn: raw.assessedOn ?? "", metrics, notes: raw.notes ?? "" },
      ),
    "Assessment saved.",
  );
}

export async function goalForMemberAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  return formAction(
    async () =>
      addGoalForMember(
        services().deps,
        await getAuthContext(),
        raw.memberId ?? "",
        raw,
      ),
    "Goal added.",
  );
}

export async function feedbackAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  return formAction(
    async () =>
      leaveFeedback(
        services().deps,
        await getAuthContext(),
        raw.memberId ?? "",
        raw,
      ),
    "Sent. The member gets a notification.",
  );
}

export async function nutritionPlanAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  // Meal lines: "slot | time | description" one per line.
  const meals = (raw.mealsText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [slot, time, ...rest] = l.split("|").map((x) => x.trim());
      return {
        slot: (slot ?? "OTHER").toUpperCase().replace(/\s+/g, "_"),
        time: time ?? "",
        description: rest.join(" | ") || time || "",
      };
    });
  return formAction(
    async () =>
      assignNutritionPlan(
        services().deps,
        await getAuthContext(),
        raw.memberId ?? "",
        { ...raw, meals },
      ),
    "Diet plan saved.",
  );
}

export async function saveFoodAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      saveFoodItem(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Food added to the gym's list.",
  );
}
